-- Bot lines come only from the app (OpenAI + relay_submit_bot_line).
-- relay_room_tick no longer inserts template bot lines.
-- Stale bot turns advance the seat without inserting a placeholder line.

-- ── relay_room_tick: lobby only (no SQL bot poetry on active turns) ─────────

create or replace function public.relay_room_tick(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r public.rooms%rowtype;
  h_cnt int;
  t_cnt int;
  b_cnt int;
  all_ready boolean;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not exists (
    select 1 from public.room_members
    where room_id = p_room_id and user_id = auth.uid()
  ) then raise exception 'not a member'; end if;

  select * into r from public.rooms where id = p_room_id for update;
  if not found then return false; end if;

  if r.status = 'waiting' then
    select
      count(*) filter (where coalesce(is_bot, false) = false)::int,
      count(*)::int,
      count(*) filter (where coalesce(is_bot, false) = true)::int
    into h_cnt, t_cnt, b_cnt
    from public.room_members where room_id = p_room_id;

    if h_cnt = 1 and t_cnt = 1 and b_cnt = 0
       and r.created_at + interval '8 seconds' < now() then
      perform public.relay_spawn_bots(p_room_id, 1);
      select count(*)::int into t_cnt from public.room_members where room_id = p_room_id;
    end if;

    if r.auto_start_at is not null
       and r.auto_start_at <= now() + interval '4 seconds'
       and t_cnt < 2 then
      perform public.relay_spawn_bots(p_room_id, greatest(0, 2 - t_cnt));
      select count(*)::int into t_cnt from public.room_members where room_id = p_room_id;
    end if;

    select not exists(
      select 1 from public.room_members rm
      where rm.room_id = p_room_id
        and rm.is_bot = false
        and rm.ready = false
    ) into all_ready;

    if coalesce(r.play_with_bots_lobby, false) = false
       and all_ready
       and t_cnt >= 2 then
      return public.relay_try_start_room(p_room_id, true);
    end if;

    if r.auto_start_at is not null and r.auto_start_at <= now() and t_cnt >= 2 then
      return public.relay_try_start_room(p_room_id, false);
    end if;

    return false;
  end if;

  return false;
end;
$fn$;

grant execute on function public.relay_room_tick(uuid) to authenticated;

-- ── skip_turn: bot seat = advance turn only (no template bot line) ──────────

create or replace function public.skip_turn_with_placeholder(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  room_row public.rooms%rowtype;
  skipped_uid uuid;
  fillers text[] := array[
    '[silence]',
    '[brain offline]',
    '[connection lost]',
    '[staring into space]',
    '[fumbles with phone]',
    '[crickets]',
    '[long pause]',
    '[mind went blank]'
  ];
  chosen text;
  is_bot_seat boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = auth.uid()
  ) then
    raise exception 'not a room member';
  end if;

  select * into room_row from public.rooms where id = p_room_id for update;
  if not found or room_row.status <> 'active' then
    return false;
  end if;
  if room_row.turn_started_at > now() - interval '15 seconds' then
    return false;
  end if;

  select m.user_id, m.is_bot into skipped_uid, is_bot_seat
  from public.room_members m
  where m.room_id = p_room_id and m.seat_order = room_row.current_turn_seat;

  if coalesce(is_bot_seat, false) then
    perform public.relay_advance_turn_for_room(p_room_id);
    return true;
  end if;

  if skipped_uid is null then
    return false;
  end if;

  chosen := fillers[1 + (floor(random() * array_length(fillers, 1)))::int];

  insert into public.lines (room_id, author_id, content, is_bot_line)
  values (p_room_id, skipped_uid, chosen, false);

  return true;
end;
$fn$;
