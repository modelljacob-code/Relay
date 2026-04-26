-- Migration 006: Quick Play matchmaking
-- Players are placed into existing waiting rooms before creating new ones.
-- Rooms auto-start when ≥ 2 players are present and a 10-second countdown elapses.

-- ── Schema ─────────────────────────────────────────────────────────────────

alter table public.rooms
  add column if not exists is_quick_play bool not null default false;

alter table public.rooms
  add column if not exists auto_start_at timestamptz;

-- ── quick_play: find or create a waiting room and join it ──────────────────
-- Returns the room code so the client can navigate directly.
-- Priority: most players first → oldest room first → new room if none found.

create or replace function public.quick_play(p_display_name text default '')
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_room_id  uuid;
  v_cnt      int;
  v_next_seat int;
  v_new_code text;
  v_code     text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  -- Already in a quick-play waiting room → return that code (idempotent)
  select r.code into v_code
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  where rm.user_id = auth.uid()
    and r.status = 'waiting'
    and r.is_quick_play = true
  limit 1;
  if v_code is not null then return v_code; end if;

  -- Find best available room: most players, then oldest
  select r.id into v_room_id
  from public.rooms r
  where r.status = 'waiting'
    and r.is_quick_play = true
    and not exists (
      select 1 from public.room_members rm2
      where rm2.room_id = r.id and rm2.user_id = auth.uid()
    )
    and (
      select count(*)::int from public.room_members rm3 where rm3.room_id = r.id
    ) < r.max_players
  order by
    (select count(*)::int from public.room_members rm4 where rm4.room_id = r.id) desc,
    r.created_at asc
  limit 1
  for update skip locked;

  if v_room_id is not null then
    -- Race-condition guard: re-check count after acquiring lock
    select count(*)::int into v_cnt from public.room_members where room_id = v_room_id;
    if v_cnt >= 5 then v_room_id := null; end if;
  end if;

  -- Create new room if none found (or all were full)
  if v_room_id is null then
    loop
      v_new_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
      exit when not exists (select 1 from public.rooms where code = v_new_code);
    end loop;
    insert into public.rooms (code, host_id, is_quick_play)
    values (v_new_code, auth.uid(), true)
    returning id into v_room_id;

    insert into public.room_members (room_id, user_id, seat_order, display_name)
    values (v_room_id, auth.uid(), 0, trim(p_display_name));

    select code into v_code from public.rooms where id = v_room_id;
    return v_code;
  end if;

  -- Join existing room
  select coalesce(max(seat_order), -1) + 1 into v_next_seat
  from public.room_members where room_id = v_room_id;

  insert into public.room_members (room_id, user_id, seat_order, display_name)
  values (v_room_id, auth.uid(), v_next_seat, trim(p_display_name));

  -- If count crossed the 2-player threshold, arm the auto-start countdown
  select count(*)::int into v_cnt from public.room_members where room_id = v_room_id;
  if v_cnt >= 2 then
    update public.rooms
    set auto_start_at = now() + interval '10 seconds'
    where id = v_room_id
      and auto_start_at is null
      and status = 'waiting';
  end if;

  select code into v_code from public.rooms where id = v_room_id;
  return v_code;
end;
$fn$;

grant execute on function public.quick_play(text) to authenticated;

-- ── auto_start_quick_play: start the game when countdown expires ───────────
-- Any member can call this; uses FOR UPDATE SKIP LOCKED to prevent races.
-- Also used when a member clicks "Start now" (force = true skips the timer check).

create or replace function public.auto_start_quick_play(p_room_id uuid, p_force bool default false)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_cnt        int;
  v_first_seat int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not exists (
    select 1 from public.room_members
    where room_id = p_room_id and user_id = auth.uid()
  ) then raise exception 'not a member'; end if;

  -- Lock the room row; skip if another transaction already holds it
  if p_force then
    -- Manual "Start now": only require 2+ players in a waiting quick-play room
    perform 1 from public.rooms
    where id = p_room_id
      and status = 'waiting'
      and is_quick_play = true
    for update skip locked;
  else
    -- Auto: countdown must have expired
    perform 1 from public.rooms
    where id = p_room_id
      and status = 'waiting'
      and is_quick_play = true
      and auto_start_at is not null
      and auto_start_at <= now()
    for update skip locked;
  end if;

  if not found then return false; end if;

  select count(*)::int into v_cnt from public.room_members where room_id = p_room_id;
  if v_cnt < 2 then return false; end if;

  select min(seat_order) into v_first_seat from public.room_members where room_id = p_room_id;

  update public.rooms
  set status           = 'active',
      current_turn_seat = v_first_seat,
      turn_started_at  = now(),
      auto_start_at    = null
  where id = p_room_id;

  return true;
end;
$fn$;

grant execute on function public.auto_start_quick_play(uuid, bool) to authenticated;
