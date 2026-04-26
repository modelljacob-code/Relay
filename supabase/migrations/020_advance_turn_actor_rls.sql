-- 1) relay_advance_turn_for_room: optional p_seat_just_played so we rotate from the
--    inserter’s seat, not a second read of rooms (avoids any stale/mismatched
--    current_turn_seat vs room_members in edge cases).
-- 2) set row_security = off on advance-turn definer functions so updates to
--    public.rooms always apply under RLS (Supabase: definer is not always table owner).
-- 3) lines_after_insert: compute seat from NEW (author or current bot seat) and pass in.

create or replace function public.relay_advance_turn_for_room(
  p_room_id uuid,
  p_seat_just_played int default null
)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $fn$
declare
  room_row public.rooms%rowtype;
  seats int[];
  cur int;
  idx int;
  len int;
  next_seat int;
  j int;
begin
  select * into room_row
  from public.rooms
  where id = p_room_id
  for update;
  if not found then
    return;
  end if;

  if p_seat_just_played is not null then
    cur := p_seat_just_played;
  else
    cur := room_row.current_turn_seat;
  end if;

  select coalesce(array_agg(m.seat_order order by m.seat_order), array[]::int[])
  into seats
  from public.room_members m
  where m.room_id = p_room_id;

  len := coalesce(array_length(seats, 1), 0);
  if len = 0 then
    return;
  end if;

  idx := null;
  for j in 1..len loop
    if seats[j] = cur then
      idx := j;
      exit;
    end if;
  end loop;

  -- Stale current_turn (e.g. member removed) — resync to lowest seat then rotate.
  if idx is null then
    cur := seats[1];
    idx := 1;
  end if;

  if len = 1 then
    next_seat := seats[1];
  else
    next_seat := seats[((idx % len) + 1)];
  end if;

  update public.rooms
  set
    current_turn_seat = next_seat,
    turn_started_at = now()
  where id = p_room_id;
end;
$fn$;

create or replace function public.lines_after_insert_advance_turn()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $fn$
declare
  total_words bigint;
  v_seat int;
begin
  select coalesce(sum(cardinality(relay_word_array(l.content))), 0::bigint)
  into total_words
  from public.lines l
  where l.room_id = NEW.room_id;

  if total_words >= 80 then
    update public.rooms
    set status = 'completed'
    where id = NEW.room_id;
    return NEW;
  end if;

  if coalesce(NEW.is_bot_line, false) then
    select r.current_turn_seat into v_seat
    from public.rooms r
    where r.id = NEW.room_id;
  else
    select m.seat_order into v_seat
    from public.room_members m
    where m.room_id = NEW.room_id
      and m.user_id = NEW.author_id;
  end if;

  if v_seat is null then
    perform public.relay_advance_turn_for_room(NEW.room_id);
  else
    perform public.relay_advance_turn_for_room(NEW.room_id, v_seat);
  end if;
  return NEW;
end;
$fn$;
