-- 1) Kick a random bot (not highest seat) when making room for a human.
-- 2) quick_play: seed 1–3 bots when a new Quick Play room is created; allow joining
--    full lobbies by trimming one bot at a time until a seat opens.
-- 3) Re-apply relay_spawn_bots (max 3 bots) + relay_room_tick lobby cap aligned with 018/021.

-- ── relay_trim_one_bot: random bot ───────────────────────────────────────────

create or replace function public.relay_trim_one_bot(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
set row_security = off
as $fn$
declare
  victim uuid;
begin
  select id into victim
  from public.room_members
  where room_id = p_room_id and coalesce(is_bot, false) = true
  order by random()
  limit 1;

  if victim is null then return false; end if;

  delete from public.room_members where id = victim;
  return true;
end;
$fn$;

grant execute on function public.relay_trim_one_bot(uuid) to authenticated;

-- ── relay_spawn_bots (max 3 for quick play) ──────────────────────────────────

create or replace function public.relay_spawn_bots(p_room_id uuid, p_count int)
returns int
language plpgsql
security definer
set search_path = public
set row_security = off
as $fn$
declare
  r public.rooms%rowtype;
  next_seat int;
  i int := 0;
  k int := 0;
  firsts text[] := array[
    'james','maria','lucas','emma','david','sofia','noah','priya','maya','ethan',
    'olivia','ryan','hannah','marcus','amy','kevin','nina','jordan','lei','samira',
    'ian','yuki','carlos','ana','vikram','sara','tyler','ava','omar','zara',
    'chloe','daniel','elena','gabe','isla','jonah','kate','liam','mia','nate'
  ];
  lasts text[] := array[
    'patel','kim','garcia','chen','nguyen','khan','lopez','silva','brown','park',
    'tanaka','martinez','wright','bell','foster','murphy','reed','ross','cole','shah',
    'campbell','rivera','singh','abdullah','okonkwo','hughes','gray','price','wood','long',
    'evans','morgan','kelly','cooper','bailey','nelson','washington','flores','myers','hayes'
  ];
  fi int;
  li int;
  nm text;
  bot_n int;
begin
  if p_count <= 0 then return 0; end if;

  select * into r from public.rooms where id = p_room_id for update;
  if not found or r.status <> 'waiting' then return 0; end if;

  if coalesce(r.is_quick_play, false) then
    select count(*)::int into bot_n from public.room_members
    where room_id = p_room_id and coalesce(is_bot, false) = true;
    if bot_n >= 3 then
      return 0;
    end if;
  end if;

  while k < p_count loop
    select count(*)::int into i from public.room_members where room_id = p_room_id;
    if i >= r.max_players then exit; end if;

    if coalesce(r.is_quick_play, false) then
      select count(*)::int into bot_n from public.room_members
      where room_id = p_room_id and coalesce(is_bot, false) = true;
      if bot_n >= 3 then
        exit;
      end if;
    end if;

    select coalesce(max(seat_order), -1) + 1 into next_seat
    from public.room_members where room_id = p_room_id;

    fi := 1 + (floor(random() * array_length(firsts, 1)))::int;
    li := 1 + (floor(random() * array_length(lasts, 1)))::int;
    nm := initcap(trim(both from firsts[fi] || ' ' || lasts[li]));
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

grant execute on function public.relay_spawn_bots(uuid, int) to authenticated;

-- ── quick_play: seed bots on new room + join full QP lobbies via trim ─────────

create or replace function public.quick_play(p_display_name text default '')
returns text
language plpgsql
security definer
set search_path = public
set row_security = off
as $fn$
declare
  v_room_id  uuid;
  v_cnt      int;
  v_next_seat int;
  v_new_code text;
  v_code     text;
  v_mx       int;
  v_spawn    int;
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
      (select count(*)::int from public.room_members rm3 where rm3.room_id = r.id) < r.max_players
      or (
        exists (
          select 1 from public.room_members bm
          where bm.room_id = r.id and coalesce(bm.is_bot, false) = true
        )
      )
    )
  order by
    (select count(*)::int from public.room_members rm4 where rm4.room_id = r.id) desc,
    r.created_at asc
  limit 1
  for update skip locked;

  if v_room_id is not null then
    select max_players into v_mx from public.rooms where id = v_room_id;
    select count(*)::int into v_cnt from public.room_members where room_id = v_room_id;
    while v_cnt >= v_mx loop
      if not exists (
        select 1 from public.room_members
        where room_id = v_room_id and coalesce(is_bot, false) = true
      ) then
        v_room_id := null;
        exit;
      end if;
      exit when not public.relay_trim_one_bot(v_room_id);
      select count(*)::int into v_cnt from public.room_members where room_id = v_room_id;
    end loop;
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

    select max_players into v_mx from public.rooms where id = v_room_id;
    v_spawn := least(
      1 + (floor(random() * 3))::int,
      3,
      greatest(v_mx - 1, 0)
    );
    if v_spawn > 0 then
      perform public.relay_spawn_bots(v_room_id, v_spawn);
    end if;

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

-- ── relay_room_tick (021 + max three bots in quick-play lobby) ───────────────

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
      if desired_total is not null then
        desired_total := least(desired_total, h_cnt + 3, r.max_players);
      end if;

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
         and b_cnt < 3
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

    if coalesce(r.is_quick_play, false) then
      -- Quick Play: two-thirds of humans ready → start immediately (no timer).
      if human_cnt = 0 then
        all_ready := false;
      else
        humans_needed := greatest(1, ceil((human_cnt * 2.0) / 3.0)::int);
        all_ready := ready_h >= humans_needed;
      end if;

      if all_ready and t_cnt >= 2 then
        return public.relay_try_start_room(p_room_id, true);
      end if;
    else
      -- Private room: only start after fixed 10s countdown, armed when *every* human is ready.
      if human_cnt < 2 or ready_h < human_cnt or t_cnt < 2 then
        update public.rooms
        set auto_start_at = null
        where id = p_room_id
          and status = 'waiting'
          and auto_start_at is not null;
      elsif r.auto_start_at is null then
        update public.rooms
        set auto_start_at = now() + interval '10 seconds'
        where id = p_room_id
          and status = 'waiting';
      end if;

      select auto_start_at into r.auto_start_at from public.rooms where id = p_room_id;

      if r.auto_start_at is not null
         and r.auto_start_at <= now()
         and t_cnt >= 2
         and human_cnt >= 2
         and ready_h = human_cnt then
        return public.relay_try_start_room(p_room_id, false);
      end if;
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

  if extract(epoch from (now() - r.turn_started_at)) < 2.5 then
    return false;
  end if;

  select exists(
    select 1 from public.lines l
    where l.room_id = p_room_id
      and l.created_at >= r.turn_started_at
  ) into line_since_turn;

  if line_since_turn then return false; end if;

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
