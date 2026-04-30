-- Bots, per-player ready, unified autostart (no host-only start), play-with-bots.
-- Bot members have user_id NULL + is_bot true. Bot lines use is_bot_line true + author_id NULL.
-- Voting is not part of Relay line play — omitted until a voting feature exists.

-- ── room_members: bot + ready ───────────────────────────────────────────────

alter table public.rooms
  add column if not exists play_with_bots_lobby boolean not null default false;

alter table public.room_members
  add column if not exists is_bot boolean not null default false,
  add column if not exists ready boolean not null default false;

update public.room_members
set ready = false
where coalesce(is_bot, false) = false;

update public.room_members
set ready = true
where coalesce(is_bot, false) = true;

alter table public.room_members drop constraint if exists room_members_user_id_fkey;
alter table public.room_members alter column user_id drop not null;

alter table public.room_members drop constraint if exists room_members_user_or_bot;
alter table public.room_members add constraint room_members_user_or_bot check (
  (is_bot = true and user_id is null)
  or (is_bot = false and user_id is not null)
);

-- ── lines: bot-authored rows ─────────────────────────────────────────────────

alter table public.lines add column if not exists is_bot_line boolean not null default false;

alter table public.lines drop constraint if exists lines_author_id_fkey;
alter table public.lines alter column author_id drop not null;

alter table public.lines drop constraint if exists lines_author_bot_check;
alter table public.lines add constraint lines_author_bot_check check (
  (is_bot_line = true and author_id is null)
  or (is_bot_line = false and author_id is not null)
);

-- ── lines_before_insert (humans + bots) ─────────────────────────────────────

create or replace function public.lines_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  prev_handoff text;
  prev_pos int;
  room_row public.rooms%rowtype;
  author_seat int;
  bot_here boolean;
begin
  select * into room_row from public.rooms where id = NEW.room_id for update;
  if not found then
    raise exception 'Room not found';
  end if;
  if room_row.status <> 'active' then
    raise exception 'Room is not active';
  end if;

  if coalesce(NEW.is_bot_line, false) then
    select exists(
      select 1 from public.room_members m
      where m.room_id = NEW.room_id
        and m.seat_order = room_row.current_turn_seat
        and m.is_bot = true
    ) into bot_here;
    if not bot_here then
      raise exception 'Not a bot turn';
    end if;
    NEW.author_id := null;
  else
    if NEW.author_id is null then
      raise exception 'author required';
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
$fn$;

-- ── skip_turn: support bot seats (null user_id) ─────────────────────────────

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
  if room_row.turn_started_at > now() - interval '8 seconds' then
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

-- ── Spawn bots (security definer) ───────────────────────────────────────────

create or replace function public.relay_spawn_bots(p_room_id uuid, p_count int)
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r public.rooms%rowtype;
  next_seat int;
  i int := 0;
  k int := 0;
  bot_names text[] := array['Echo', 'Neon', 'Loose Wire', 'Static', 'Side B'];
  nm text;
begin
  if p_count <= 0 then return 0; end if;

  select * into r from public.rooms where id = p_room_id for update;
  if not found or r.status <> 'waiting' then return 0; end if;

  while k < p_count loop
    select count(*)::int into i from public.room_members where room_id = p_room_id;
    if i >= r.max_players then exit; end if;

    select coalesce(max(seat_order), -1) + 1 into next_seat
    from public.room_members where room_id = p_room_id;

    nm := bot_names[1 + ((next_seat + 7) % array_length(bot_names, 1))];

    insert into public.room_members (room_id, user_id, seat_order, display_name, is_bot, ready)
    values (p_room_id, null, next_seat, nm, true, true);

    k := k + 1;
  end loop;

  return k;
end;
$fn$;

grant execute on function public.relay_spawn_bots(uuid, int) to authenticated;

-- ── Remove one bot (highest seat) when humans need space ─────────────────────

create or replace function public.relay_trim_one_bot(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  victim uuid;
begin
  select id into victim
  from public.room_members
  where room_id = p_room_id and is_bot = true
  order by seat_order desc
  limit 1;

  if victim is null then return false; end if;

  delete from public.room_members where id = victim;
  return true;
end;
$fn$;

grant execute on function public.relay_trim_one_bot(uuid) to authenticated;

-- ── Unified start (any waiting room, 2+ seats) ─────────────────────────────

create or replace function public.relay_try_start_room(p_room_id uuid, p_force boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_cnt int;
  v_first_seat int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not exists (
    select 1 from public.room_members
    where room_id = p_room_id and user_id = auth.uid()
  ) then raise exception 'not a member'; end if;

  if p_force then
    perform 1 from public.rooms
    where id = p_room_id and status = 'waiting'
    for update skip locked;
  else
    perform 1 from public.rooms
    where id = p_room_id
      and status = 'waiting'
      and auto_start_at is not null
      and auto_start_at <= now()
    for update skip locked;
  end if;

  if not found then return false; end if;

  select count(*)::int into v_cnt from public.room_members where room_id = p_room_id;
  if v_cnt < 2 then return false; end if;

  select min(seat_order) into v_first_seat from public.room_members where room_id = p_room_id;

  update public.rooms
  set status = 'active',
      current_turn_seat = v_first_seat,
      turn_started_at = now(),
      auto_start_at = null,
      play_with_bots_lobby = false
  where id = p_room_id;

  return true;
end;
$fn$;

grant execute on function public.relay_try_start_room(uuid, boolean) to authenticated;

-- Wrapper: keep existing client calls working
create or replace function public.auto_start_quick_play(p_room_id uuid, p_force bool default false)
returns boolean
language sql
security definer
set search_path = public
as $fn$
  select public.relay_try_start_room(p_room_id, p_force);
$fn$;

-- ── Ready toggle ────────────────────────────────────────────────────────────

create or replace function public.relay_set_ready(p_room_id uuid, p_ready boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  update public.room_members
  set ready = p_ready
  where room_id = p_room_id
    and user_id = auth.uid()
    and is_bot = false;

  -- Private waiting lobby: unready resets the "everyone ready" start countdown immediately.
  if not p_ready then
    update public.rooms r
    set auto_start_at = null
    where r.id = p_room_id
      and r.status = 'waiting'
      and coalesce(r.is_quick_play, false) = false;
  end if;
end;
$fn$;

grant execute on function public.relay_set_ready(uuid, boolean) to authenticated;

-- ── Lobby + bot turn tick (callable by any member, ~1–2s poll) ───────────────

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

  -- ── Waiting lobby ────────────────────────────────────────────────────────
  if r.status = 'waiting' then
    select
      count(*) filter (where coalesce(is_bot, false) = false)::int,
      count(*)::int,
      count(*) filter (where coalesce(is_bot, false) = true)::int
    into h_cnt, t_cnt, b_cnt
    from public.room_members where room_id = p_room_id;

    -- Solo human for a while → add one bot (quick matchmaking feel)
    if h_cnt = 1 and t_cnt = 1 and b_cnt = 0
       and r.created_at + interval '8 seconds' < now() then
      perform public.relay_spawn_bots(p_room_id, 1);
      select count(*)::int into t_cnt from public.room_members where room_id = p_room_id;
    end if;

    -- Near auto-start and still under 2 seats → fill to 2 with bots
    if r.auto_start_at is not null
       and r.auto_start_at <= now() + interval '4 seconds'
       and t_cnt < 2 then
      perform public.relay_spawn_bots(p_room_id, greatest(0, 2 - t_cnt));
      select count(*)::int into t_cnt from public.room_members where room_id = p_room_id;
    end if;

    -- All humans ready (bots always ready)
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

  -- ── Active: bot submits a line if it is their turn ───────────────────────
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

-- ── join_room_by_code: trim bots if full, arm autostart, optional bot trim ───

create or replace function public.join_room_by_code(p_code text, p_display_name text default '')
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  rid uuid;
  rstatus text;
  cnt int;
  mx int;
  next_seat int;
  h_after int;
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

  while cnt >= mx loop
    if not exists (
      select 1 from public.room_members where room_id = rid and is_bot = true
    ) then
      raise exception 'Room is full';
    end if;
    if not public.relay_trim_one_bot(rid) then
      raise exception 'Room is full';
    end if;
    select count(*)::int into cnt from public.room_members where room_id = rid;
  end loop;

  if exists (
    select 1 from public.room_members
    where room_id = rid and user_id = auth.uid()
  ) then
    return rid;
  end if;

  select coalesce(max(seat_order), -1) + 1 into next_seat
  from public.room_members where room_id = rid;

  insert into public.room_members (room_id, user_id, seat_order, display_name, is_bot, ready)
  values (rid, auth.uid(), next_seat, trim(p_display_name), false, false);

  select count(*) filter (where is_bot = false)::int into h_after
  from public.room_members where room_id = rid;

  if h_after >= 3 then
    perform public.relay_trim_one_bot(rid);
  end if;

  select count(*)::int into cnt from public.room_members where room_id = rid;
  if cnt >= 2 then
    update public.rooms
    set auto_start_at = coalesce(
      auto_start_at,
      now() + interval '12 seconds'
    )
    where id = rid
      and status = 'waiting';
  end if;

  return rid;
end;
$fn$;

-- ── quick_play: arm countdown for solo new rooms ─────────────────────────────

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

  select r.code into v_code
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  where rm.user_id = auth.uid()
    and r.status = 'waiting'
    and r.is_quick_play = true
  limit 1;
  if v_code is not null then return v_code; end if;

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
    select count(*)::int into v_cnt from public.room_members where room_id = v_room_id;
    if v_cnt >= 5 then v_room_id := null; end if;
  end if;

  if v_room_id is null then
    loop
      v_new_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
      exit when not exists (select 1 from public.rooms where code = v_new_code);
    end loop;
    insert into public.rooms (code, host_id, is_quick_play)
    values (v_new_code, auth.uid(), true)
    returning id into v_room_id;

    insert into public.room_members (room_id, user_id, seat_order, display_name, is_bot, ready)
    values (v_room_id, auth.uid(), 0, trim(p_display_name), false, false);

    update public.rooms
    set auto_start_at = now() + interval '10 seconds'
    where id = v_room_id;

    select code into v_code from public.rooms where id = v_room_id;
    return v_code;
  end if;

  select coalesce(max(seat_order), -1) + 1 into v_next_seat
  from public.room_members where room_id = v_room_id;

  insert into public.room_members (room_id, user_id, seat_order, display_name, is_bot, ready)
  values (v_room_id, auth.uid(), v_next_seat, trim(p_display_name), false, false);

  select count(*)::int into v_cnt from public.room_members where room_id = v_room_id;
  if v_cnt >= 2 then
    update public.rooms
    set auto_start_at = coalesce(auto_start_at, now() + interval '10 seconds')
    where id = v_room_id
      and status = 'waiting';
  end if;

  select code into v_code from public.rooms where id = v_room_id;
  return v_code;
end;
$fn$;

-- ── play_with_bots: instant room, N bots, short countdown ───────────────────
-- Single jsonb arg — PostgREST reliably resolves it (avoids multi-arg schema cache issues).

drop function if exists public.play_with_bots(text, int);
drop function if exists public.play_with_bots(int, text);
drop function if exists public.play_with_bots(jsonb);

create or replace function public.play_with_bots(args jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_room_id uuid;
  v_code text;
  n int;
  d text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  n := case
    when coalesce(args->>'p_bot_count', '') ~ '^[0-9]+$'
    then (args->>'p_bot_count')::int
    else 2
  end;
  n := greatest(1, least(n, 3));

  d := left(btrim(coalesce(args->>'p_display_name', '')), 24);

  loop
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.rooms where code = v_code);
  end loop;

  insert into public.rooms (code, host_id, is_quick_play, play_with_bots_lobby)
  values (v_code, auth.uid(), true, true)
  returning id into v_room_id;

  insert into public.room_members (room_id, user_id, seat_order, display_name, is_bot, ready)
  values (v_room_id, auth.uid(), 0, d, false, false);

  perform public.relay_spawn_bots(v_room_id, n);

  update public.rooms
  set auto_start_at = now() + interval '3 seconds'
  where id = v_room_id;

  return v_code;
end;
$fn$;

grant execute on function public.play_with_bots(jsonb) to authenticated;

-- ── run_it_back: copy bot flags ─────────────────────────────────────────────

create or replace function public.run_it_back(p_old_room_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
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

  if v_old_room.next_room_code is not null then
    return v_old_room.next_room_code;
  end if;

  loop
    v_new_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.rooms where code = v_new_code);
  end loop;

  insert into public.rooms (code, host_id, max_players, play_with_bots_lobby)
  values (v_new_code, v_old_room.host_id, v_old_room.max_players, false)
  returning id into v_new_id;

  for v_member in
    select user_id, seat_order, display_name, is_bot, ready
    from public.room_members
    where room_id = p_old_room_id
    order by seat_order
  loop
    insert into public.room_members (room_id, user_id, seat_order, display_name, is_bot, ready)
    values (
      v_new_id,
      v_member.user_id,
      v_member.seat_order,
      v_member.display_name,
      coalesce(v_member.is_bot, false),
      case when coalesce(v_member.is_bot, false) then true else false end
    );
  end loop;

  update public.rooms set next_room_code = v_new_code where id = p_old_room_id;

  return v_new_code;
end;
$fn$;

grant execute on function public.run_it_back(uuid) to authenticated;
