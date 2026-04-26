-- Align stale/skip turn thresholds with TURN_TIMEOUT_SECONDS (15).
-- Reset first-turn clock after 3-2-1 so the full 15s starts when play begins.
-- Optional LLM bot lines via relay_submit_bot_line (called from app server action).

-- ── advance_turn_if_stale: 15s (was 8s) ─────────────────────────────────────

create or replace function public.advance_turn_if_stale(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  room_row public.rooms%rowtype;
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
  if not found then
    return false;
  end if;
  if room_row.status <> 'active' then
    return false;
  end if;
  if room_row.turn_started_at > now() - interval '15 seconds' then
    return false;
  end if;

  perform public.relay_advance_turn_for_room(p_room_id);
  return true;
end;
$$;

-- ── skip_turn_with_placeholder: 15s + bot seats (007 behavior) ──────────────

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

-- ── After 3-2-1-GO: give first player full turn window from "now" ────────────

create or replace function public.relay_align_first_turn_after_countdown(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
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

  if exists (select 1 from public.lines where room_id = p_room_id) then
    return;
  end if;

  update public.rooms
  set turn_started_at = now()
  where id = p_room_id
    and status = 'active';
end;
$fn$;

grant execute on function public.relay_align_first_turn_after_countdown(uuid) to authenticated;

-- ── LLM / app-driven bot line (same invariants as relay_room_tick bot path) ─

create or replace function public.relay_submit_bot_line(p_room_id uuid, p_content text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r public.rooms%rowtype;
  bot_turn boolean;
  line_since_turn boolean;
  trimmed text;
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

  trimmed := btrim(p_content);
  if trimmed = '' or char_length(trimmed) > 50 then
    return false;
  end if;

  if relay_word_array(trimmed) = array[]::text[] then
    return false;
  end if;

  select * into r from public.rooms where id = p_room_id for update;
  if not found or r.status <> 'active' then
    return false;
  end if;

  select exists(
    select 1 from public.room_members m
    where m.room_id = p_room_id
      and m.seat_order = r.current_turn_seat
      and m.is_bot = true
  ) into bot_turn;

  if not bot_turn then
    return false;
  end if;

  select exists(
    select 1 from public.lines l
    where l.room_id = p_room_id
      and l.created_at >= r.turn_started_at
  ) into line_since_turn;

  if line_since_turn then
    return false;
  end if;

  insert into public.lines (room_id, author_id, content, is_bot_line)
  values (p_room_id, null, trimmed, true);

  return true;
end;
$fn$;

grant execute on function public.relay_submit_bot_line(uuid, text) to authenticated;
