-- Migration 005: display names per player + run-it-back for same-group replay

-- ── Schema changes ────────────────────────────────────────────────────────────

alter table public.room_members
  add column if not exists display_name text not null default '';

alter table public.rooms
  add column if not exists next_room_code text;

-- ── join_room_by_code (updated: accepts display name) ─────────────────────────

create or replace function public.join_room_by_code(p_code text, p_display_name text default '')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  rid uuid;
  rstatus text;
  cnt int;
  mx int;
  next_seat int;
begin
  select id, status into rid, rstatus
  from public.rooms
  where code = upper(trim(p_code));
  if rid is null then
    raise exception 'Room not found';
  end if;
  if rstatus <> 'waiting' then
    raise exception 'Game already started';
  end if;
  select count(*)::int into cnt from public.room_members where room_id = rid;
  select max_players into mx from public.rooms where id = rid;
  if cnt >= mx then
    raise exception 'Room is full';
  end if;
  if exists (
    select 1 from public.room_members
    where room_id = rid and user_id = auth.uid()
  ) then
    return rid;
  end if;
  select coalesce(max(seat_order), -1) + 1 into next_seat
  from public.room_members
  where room_id = rid;
  insert into public.room_members (room_id, user_id, seat_order, display_name)
  values (rid, auth.uid(), next_seat, trim(p_display_name));
  return rid;
end;
$$;

grant execute on function public.join_room_by_code(text, text) to authenticated;

-- ── run_it_back: clone a completed room with all original players ──────────────
-- Any member may call this. Idempotent: if called twice it returns the same new code.
-- Sets next_room_code on old room → all realtime subscribers auto-redirect.

create or replace function public.run_it_back(p_old_room_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_room  public.rooms%rowtype;
  v_new_code  text;
  v_new_id    uuid;
  v_member    record;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not exists (
    select 1 from public.room_members
    where room_id = p_old_room_id and user_id = auth.uid()
  ) then
    raise exception 'not a member of this room';
  end if;

  select * into v_old_room from public.rooms where id = p_old_room_id for update;
  if not found or v_old_room.status <> 'completed' then
    raise exception 'room is not completed';
  end if;

  -- Idempotent: already have a next room
  if v_old_room.next_room_code is not null then
    return v_old_room.next_room_code;
  end if;

  -- Generate unique 6-char code
  loop
    v_new_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.rooms where code = v_new_code);
  end loop;

  -- Create the new room with same host and capacity
  insert into public.rooms (code, host_id, max_players)
  values (v_new_code, v_old_room.host_id, v_old_room.max_players)
  returning id into v_new_id;

  -- Copy all members with preserved seat order and display names
  for v_member in
    select user_id, seat_order, display_name
    from public.room_members
    where room_id = p_old_room_id
    order by seat_order
  loop
    insert into public.room_members (room_id, user_id, seat_order, display_name)
    values (v_new_id, v_member.user_id, v_member.seat_order, v_member.display_name);
  end loop;

  -- Signal all clients on the old room to redirect
  update public.rooms set next_room_code = v_new_code where id = p_old_room_id;

  return v_new_code;
end;
$$;

grant execute on function public.run_it_back(uuid) to authenticated;
