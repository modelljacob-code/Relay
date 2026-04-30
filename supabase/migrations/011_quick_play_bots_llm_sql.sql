-- Remove "Play with Bots" RPC. Bots only as Quick Play fallback.
-- Quick Play: after ~6s, add bots toward 3–5 members (capped by max_players);
--   near auto-start, ensure ≥2 and keep filling toward target.
-- Private waiting rooms: no bot spawning from tick.
-- Active bot lines: SQL templates (relay_room_tick); client tries LLM first.

drop function if exists public.play_with_bots(jsonb);
drop function if exists public.play_with_bots(text, int);
drop function if exists public.play_with_bots(int, text);

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
  desired_total int;
  spawn_n int;
  prev_handoff text;
  line_txt text;
  suffixes text[] := array[
    'and the room hums low',
    'like a half-remembered tune',
    'while the city blinks awake',
    'under a borrowed moon',
    'soft enough to keep',
    'turning slow corners in my head'
  ];
  starters text[] := array[
    'Streetlights write a thin yellow line',
    'We count beats between the thunder',
    'Paper boats in a parking lot puddle',
    'The chorus shows up late but loud',
    'Somebody hums the wrong key on purpose'
  ];
  bot_turn boolean;
  line_since_turn boolean;
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

    desired_total := least(r.max_players, 5);
    if r.max_players >= 3 then
      desired_total := greatest(3, desired_total);
    end if;
    desired_total := least(desired_total, r.max_players);

    if coalesce(r.is_quick_play, false) then
      -- ~5–8s human-first window (use 6s)
      if now() >= r.created_at + interval '6 seconds'
         and t_cnt < desired_total
         and t_cnt < r.max_players then
        spawn_n := least(2, desired_total - t_cnt, r.max_players - t_cnt);
        if spawn_n > 0 then
          perform public.relay_spawn_bots(p_room_id, spawn_n);
          select count(*)::int into t_cnt from public.room_members where room_id = p_room_id;
          if t_cnt >= 2 then
            update public.rooms
            set auto_start_at = coalesce(auto_start_at, now() + interval '10 seconds')
            where id = p_room_id
              and status = 'waiting'
              and is_quick_play = true;
          end if;
        end if;
      end if;

      if r.auto_start_at is not null
         and r.auto_start_at <= now() + interval '4 seconds' then
        if t_cnt < 2 then
          perform public.relay_spawn_bots(p_room_id, greatest(0, 2 - t_cnt));
        elsif t_cnt < desired_total and t_cnt < r.max_players then
          spawn_n := least(2, desired_total - t_cnt, r.max_players - t_cnt);
          if spawn_n > 0 then
            perform public.relay_spawn_bots(p_room_id, spawn_n);
          end if;
        end if;
        select count(*)::int into t_cnt from public.room_members where room_id = p_room_id;
        if t_cnt >= 2 then
          update public.rooms
          set auto_start_at = coalesce(auto_start_at, now() + interval '10 seconds')
          where id = p_room_id
            and status = 'waiting'
            and is_quick_play = true;
        end if;
      end if;
    end if;

    select not exists(
      select 1 from public.room_members rm
      where rm.room_id = p_room_id
        and rm.is_bot = false
        and rm.ready = false
    ) into all_ready;

    if all_ready and t_cnt >= 2 then
      return public.relay_try_start_room(p_room_id, true);
    end if;

    if r.auto_start_at is not null and r.auto_start_at <= now() and t_cnt >= 2 then
      return public.relay_try_start_room(p_room_id, false);
    end if;

    return false;
  end if;

  if r.status <> 'active' then return false; end if;

  select exists(
    select 1 from public.room_members m
    where m.room_id = p_room_id
      and m.seat_order = r.current_turn_seat
      and m.is_bot = true
  ) into bot_turn;

  if not bot_turn then return false; end if;

  select exists(
    select 1 from public.lines l
    where l.room_id = p_room_id
      and l.created_at >= r.turn_started_at
  ) into line_since_turn;

  if line_since_turn then return false; end if;

  if r.turn_started_at > now() - interval '2 seconds' then
    return false;
  end if;

  if r.turn_started_at > now() - interval '6 seconds' and random() < 0.55 then
    return false;
  end if;

  select handoff_key into prev_handoff
  from public.lines
  where room_id = p_room_id
  order by position desc
  limit 1;

  if prev_handoff is null or btrim(prev_handoff) = '' then
    line_txt := starters[1 + (floor(random() * array_length(starters, 1)))::int];
  else
    line_txt := btrim(prev_handoff) || ' '
      || suffixes[1 + (floor(random() * array_length(suffixes, 1)))::int];
  end if;

  if char_length(line_txt) > 50 then
    line_txt := left(line_txt, 50);
  end if;

  insert into public.lines (room_id, author_id, content, is_bot_line)
  values (p_room_id, null, line_txt, true);

  return true;
end;
$fn$;

grant execute on function public.relay_room_tick(uuid) to authenticated;

-- Bot timeout: placeholder line again (SQL fallback)
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
  if room_row.turn_started_at > now() - interval '23 seconds' then
    return false;
  end if;

  select m.user_id, m.is_bot into skipped_uid, is_bot_seat
  from public.room_members m
  where m.room_id = p_room_id and m.seat_order = room_row.current_turn_seat;

  chosen := fillers[1 + (floor(random() * array_length(fillers, 1)))::int];

  if coalesce(is_bot_seat, false) then
    insert into public.lines (room_id, author_id, content, is_bot_line)
    values (p_room_id, null, chosen, true);
  elsif skipped_uid is not null then
    insert into public.lines (room_id, author_id, content, is_bot_line)
    values (p_room_id, skipped_uid, chosen, false);
  else
    return false;
  end if;

  return true;
end;
$fn$;
