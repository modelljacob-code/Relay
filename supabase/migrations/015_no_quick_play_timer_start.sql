-- Quick Play: no timer-based game start — only relay_try_start_room(..., true)
-- when enough humans tap ready (two-thirds), or force from UI.
-- Still fill empty seats over time; urgency uses room age, not auto_start_at.
-- Clear stale countdown on existing quick-play lobbies.

update public.rooms
set auto_start_at = null
where coalesce(is_quick_play, false) = true
  and status = 'waiting';

-- ── join_room_by_code: do not arm auto_start for quick-play rooms ───────────

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
  qp boolean;
begin
  select id, status, coalesce(is_quick_play, false)
  into rid, rstatus, qp
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

  -- Private lobby: countdown is armed only after every human taps ready (`relay_room_tick`).

  return rid;
end;
$fn$;

-- ── quick_play: never arm auto_start_at (player-driven start only) ───────────

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

    select code into v_code from public.rooms where id = v_room_id;
    return v_code;
  end if;

  select coalesce(max(seat_order), -1) + 1 into v_next_seat
  from public.room_members where room_id = v_room_id;

  insert into public.room_members (room_id, user_id, seat_order, display_name, is_bot, ready)
  values (v_room_id, auth.uid(), v_next_seat, trim(p_display_name), false, false);

  select code into v_code from public.rooms where id = v_room_id;
  return v_code;
end;
$fn$;

grant execute on function public.quick_play(text) to authenticated;
grant execute on function public.join_room_by_code(text, text) to authenticated;

-- ── relay_room_tick: drop timer start + no auto_start_at writes for QP ───────

create or replace function public.relay_room_tick(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
set row_security = off
as $fn$
declare
  r public.rooms%rowtype;
  h_cnt int;
  t_cnt int;
  b_cnt int;
  all_ready boolean;
  ready_h int;
  human_cnt int;
  humans_needed int;
  desired_total int;
  hi int;
  new_tgt int;
  urgent boolean;
  stagger_ok boolean;
  next_gap int;
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

    if coalesce(r.is_quick_play, false) then
      if r.quick_play_fill_target is null and now() >= r.created_at + interval '6 seconds' then
        hi := least(5, r.max_players);
        if hi >= 3 then
          new_tgt := 3 + floor(random() * (hi - 3 + 1))::int;
        else
          new_tgt := hi;
        end if;
        update public.rooms
        set quick_play_fill_target = new_tgt
        where id = p_room_id;
        select quick_play_fill_target into r.quick_play_fill_target
        from public.rooms where id = p_room_id;
      end if;

      desired_total := r.quick_play_fill_target;

      urgent := t_cnt < 2
        and now() >= r.created_at + interval '40 seconds';

      stagger_ok := urgent
        or (
          r.next_bot_fill_after is null
          and r.last_bot_spawn_at is null
          and now() >= r.created_at + interval '6 seconds'
        )
        or (
          r.next_bot_fill_after is not null
          and now() >= r.next_bot_fill_after
        );

      if stagger_ok
         and t_cnt < r.max_players
         and (
           (urgent and t_cnt < 2)
           or (desired_total is not null and t_cnt < desired_total)
         ) then
        next_gap := 2 + floor(random() * 5)::int;
        perform public.relay_spawn_bots(p_room_id, 1);
        update public.rooms
        set
          last_bot_spawn_at = now(),
          next_bot_fill_after = now() + (next_gap * interval '1 second')
        where id = p_room_id;
        select count(*)::int into t_cnt from public.room_members where room_id = p_room_id;
      end if;
    end if;

    select
      count(*) filter (where coalesce(is_bot, false) = false and ready = true)::int,
      count(*) filter (where coalesce(is_bot, false) = false)::int
    into ready_h, human_cnt
    from public.room_members
    where room_id = p_room_id;

    if human_cnt = 0 then
      all_ready := false;
    else
      humans_needed := greatest(1, ceil((human_cnt * 2.0) / 3.0)::int);
      all_ready := ready_h >= humans_needed;
    end if;

    if all_ready and t_cnt >= 2 then
      return public.relay_try_start_room(p_room_id, true);
    end if;

    if coalesce(r.is_quick_play, false) = false
       and r.auto_start_at is not null
       and r.auto_start_at <= now()
       and t_cnt >= 2 then
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
