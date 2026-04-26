-- Relay: private rooms, 2–5 players, turns, handoff, realtime-ready
-- Run in Supabase SQL editor or via CLI.

-- ---- Normalization & handoff (shared rules, v3 doc) ----
create or replace function relay_normalize_raw(t text)
returns text
language sql
immutable
as $$
  select trim(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9\s-]', '', 'g'));
$$;

create or replace function relay_word_array(t text)
returns text[]
language plpgsql
immutable
as $$
declare
  norm text := relay_normalize_raw(t);
  parts text[];
  w text;
  acc text[] := array[]::text[];
begin
  if norm = '' then
    return acc;
  end if;
  parts := string_to_array(norm, ' ');
  foreach w in array parts loop
    if w <> '' then
      acc := array_append(acc, w);
    end if;
  end loop;
  return acc;
end;
$$;

create or replace function relay_handoff_phrase_from_content(p_content text)
returns text
language plpgsql
immutable
as $$
declare
  words text[];
  n int;
begin
  words := relay_word_array(p_content);
  n := cardinality(words);
  if n = 0 then
    return '';
  elsif n < 4 then
    return array_to_string(words, ' ');
  else
    return array_to_string(words[(n - 3):n], ' ');
  end if;
end;
$$;

create or replace function relay_line_satisfies_handoff(p_new_content text, p_required text)
returns boolean
language plpgsql
immutable
as $$
declare
  req_words text[];
  new_words text[];
  req_n int;
  new_n int;
  i int;
begin
  if p_required is null or p_required = '' then
    return true;
  end if;
  req_words := relay_word_array(p_required);
  new_words := relay_word_array(p_new_content);
  req_n := cardinality(req_words);
  new_n := cardinality(new_words);
  if req_n = 0 then
    return true;
  end if;
  if new_n < req_n then
    return false;
  end if;
  for i in 1..req_n loop
    if new_words[i] is distinct from req_words[i] then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ---- Tables ----
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'waiting'
    check (status in ('waiting', 'active', 'completed')),
  current_turn_seat int not null default 0,
  turn_started_at timestamptz not null default now(),
  max_players int not null default 5
    check (max_players >= 2 and max_players <= 5),
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  seat_order int not null,
  joined_at timestamptz not null default now(),
  unique (room_id, user_id),
  unique (room_id, seat_order)
);

create table if not exists public.lines (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  content text not null,
  handoff_key text not null default '',
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (room_id, position),
  constraint lines_content_len check (char_length(content) >= 1 and char_length(content) <= 50)
);

create index if not exists lines_room_position on public.lines (room_id, position desc);

-- ---- Line triggers ----
create or replace function public.lines_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  prev_handoff text;
  prev_pos int;
  room_row public.rooms%rowtype;
  author_seat int;
begin
  select * into room_row from public.rooms where id = NEW.room_id for update;
  if not found then
    raise exception 'Room not found';
  end if;
  if room_row.status <> 'active' then
    raise exception 'Room is not active';
  end if;

  select seat_order into author_seat
  from public.room_members
  where room_id = NEW.room_id and user_id = NEW.author_id;
  if not found then
    raise exception 'Not a member of this room';
  end if;
  if author_seat is distinct from room_row.current_turn_seat then
    raise exception 'Not your turn';
  end if;

  select position, handoff_key into prev_pos, prev_handoff
  from public.lines
  where room_id = NEW.room_id
  order by position desc
  limit 1;

  if relay_word_array(NEW.content) = array[]::text[] then
    raise exception 'Line cannot be empty';
  end if;

  NEW.position := coalesce(prev_pos, 0) + 1;
  NEW.handoff_key := relay_handoff_phrase_from_content(NEW.content);
  return NEW;
end;
$$;

create or replace function public.lines_after_insert_advance_turn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  seats int[];
  cur int;
  idx int;
  len int;
  next_seat int;
  j int;
begin
  select current_turn_seat into cur from public.rooms where id = NEW.room_id for update;
  select coalesce(array_agg(seat_order order by seat_order), array[]::int[])
  into seats
  from public.room_members
  where room_id = NEW.room_id;

  len := coalesce(array_length(seats, 1), 0);
  if len = 0 then
    return NEW;
  end if;

  idx := null;
  for j in 1..len loop
    if seats[j] = cur then
      idx := j;
      exit;
    end if;
  end loop;

  if idx is null then
    return NEW;
  end if;

  if len = 1 then
    next_seat := seats[1];
  else
    next_seat := seats[((idx % len) + 1)];
  end if;

  update public.rooms
  set current_turn_seat = next_seat,
      turn_started_at = now()
  where id = NEW.room_id;

  return NEW;
end;
$$;

drop trigger if exists tr_lines_before_insert on public.lines;
create trigger tr_lines_before_insert
  before insert on public.lines
  for each row
  execute procedure public.lines_before_insert();

drop trigger if exists tr_lines_after_insert_turn on public.lines;
create trigger tr_lines_after_insert_turn
  after insert on public.lines
  for each row
  execute procedure public.lines_after_insert_advance_turn();

-- ---- RLS ----
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.lines enable row level security;

-- Security definer helpers — bypass RLS inside policy checks to break recursion chains.
create or replace function public.i_am_in_room(p_room_id uuid)
returns boolean language sql security definer stable set search_path = public as
'select exists(select 1 from public.room_members where room_id = p_room_id and user_id = auth.uid())';

create or replace function public.room_member_count(p_room_id uuid)
returns bigint language sql security definer stable set search_path = public as
'select count(*) from public.room_members where room_id = p_room_id';

-- Rooms: members can read; host can update their room
drop policy if exists "rooms_select_member" on public.rooms;
drop policy if exists "rooms_insert_host" on public.rooms;
drop policy if exists "rooms_update_host" on public.rooms;

create policy "rooms_select_member"
  on public.rooms for select
  using (auth.uid() = host_id or public.i_am_in_room(id));

create policy "rooms_insert_host"
  on public.rooms for insert
  with check (auth.uid() = host_id);

create policy "rooms_update_host"
  on public.rooms for update
  using (auth.uid() = host_id)
  with check (auth.uid() = host_id);

-- Preview room by code (for join link) — returns one row, no full table leak
create or replace function public.preview_room_by_code(p_code text)
returns table (
  room_id uuid,
  status text,
  player_count bigint,
  max_players int,
  host_id uuid
)
language sql
security definer
set search_path = public
as $$
  select
    r.id,
    r.status,
    (select count(*)::bigint from public.room_members m where m.room_id = r.id),
    r.max_players,
    r.host_id
  from public.rooms r
  where r.code = upper(trim(p_code))
  limit 1;
$$;

grant execute on function public.preview_room_by_code(text) to authenticated;

create or replace function public.join_room_by_code(p_code text)
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
  insert into public.room_members (room_id, user_id, seat_order)
  values (rid, auth.uid(), next_seat);
  return rid;
end;
$$;

grant execute on function public.join_room_by_code(text) to authenticated;

-- Members
-- All helpers are security definer so they bypass RLS and break the recursion chains.
create or replace function public.get_my_room_memberships()
returns setof uuid language sql security definer stable set search_path = public as
'select room_id from public.room_members where user_id = auth.uid()';

drop policy if exists "room_members_select_same_room" on public.room_members;
drop policy if exists "room_members_insert_join" on public.room_members;

create policy "room_members_select_same_room"
  on public.room_members for select
  using (room_id = any(array(select public.get_my_room_memberships())));

create policy "room_members_insert_join"
  on public.room_members for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.rooms r
      where r.id = room_id
        and r.status = 'waiting'
        and public.room_member_count(room_id) < r.max_players
    )
  );

-- Lines: members read; insert when it's your turn (trigger enforces handoff)
drop policy if exists "lines_select_member" on public.lines;
drop policy if exists "lines_insert_on_turn" on public.lines;

create policy "lines_select_member"
  on public.lines for select
  using (public.i_am_in_room(room_id));

create policy "lines_insert_on_turn"
  on public.lines for insert
  with check (
    auth.uid() = author_id
    and exists (
      select 1
      from public.room_members me
      join public.rooms r on r.id = me.room_id
      where me.room_id = lines.room_id
        and me.user_id = auth.uid()
        and r.status = 'active'
        and me.seat_order = r.current_turn_seat
    )
  );

-- ---- Realtime ----
-- Idempotent: re-running migration must not fail if tables are already in the publication.
do $realtime$
begin
  begin
    alter publication supabase_realtime add table public.rooms;
  exception
    when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.room_members;
  exception
    when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.lines;
  exception
    when duplicate_object then null;
  end;
end
$realtime$;
