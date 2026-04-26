-- Minimum time on the bot's turn clock before SQL template or relay_submit_bot_line inserts.
-- Keep in sync with lib/relay-constants.ts BOT_TURN_MIN_DWELL_MS (2500).

-- ── relay_room_tick (same as 018 + dwell gate) ────────────────────────────────

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
        desired_total := least(desired_total, h_cnt + 2, r.max_players);
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
         and b_cnt < 2
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

-- ── relay_submit_bot_line (014 + dwell gate) ─────────────────────────────────

create or replace function public.relay_submit_bot_line(p_room_id uuid, p_content text)
returns boolean
language plpgsql
security definer
set search_path = public
set row_security = off
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

  if extract(epoch from (now() - r.turn_started_at)) < 2.5 then
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
