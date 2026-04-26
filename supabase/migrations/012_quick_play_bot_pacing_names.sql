-- Quick Play bots: random lobby size target (3–5 when max allows), one bot per tick
-- with 2–6s randomized gaps, random display names (not fixed Echo/Neon list).

alter table public.rooms
  add column if not exists quick_play_fill_target int null;

alter table public.rooms
  add column if not exists last_bot_spawn_at timestamptz null;

alter table public.rooms
  add column if not exists next_bot_fill_after timestamptz null;

-- ── Bot display names: random two-word combo each spawn ───────────────────────

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
  adj text[] := array[
    'quiet', 'silver', 'late', 'wild', 'soft', 'urban', 'slow', 'bright',
    'empty', 'cheap', 'warm', 'cold', 'lost', 'lucky', 'fake', 'honest'
  ];
  noun text[] := array[
    'cassette', 'freeway', 'pigeon', 'basement', 'thunder', 'parking', 'neon',
    'coffee', 'voicemail', 'winter', 'summer', 'shadow', 'window', 'static',
    'mirror', 'highway', 'river', 'corner'
  ];
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

    nm := initcap(
      trim(both from
        adj[1 + (floor(random() * array_length(adj, 1)))::int]
        || ' '
        || noun[1 + (floor(random() * array_length(noun, 1)))::int]
      )
    );
    if char_length(nm) > 24 then
      nm := left(nm, 24);
    end if;

    insert into public.room_members (room_id, user_id, seat_order, display_name, is_bot, ready)
    values (p_room_id, null, next_seat, nm, true, true);

    k := k + 1;
  end loop;

  return k;
end;
$fn$;

-- ── Clear pacing fields when a game starts ──────────────────────────────────

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
      play_with_bots_lobby = false,
      quick_play_fill_target = null,
      last_bot_spawn_at = null,
      next_bot_fill_after = null
  where id = p_room_id;

  return true;
end;
$fn$;

-- ── Quick Play lobby: random target, staggered single-bot spawns ────────────

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
      -- Once past ~6s grace, lock in a random lobby size (3..min(5,max_players))
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

      urgent := r.auto_start_at is not null
        and r.auto_start_at <= now() + interval '4 seconds'
        and t_cnt < 2;

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
