-- Turn timeout: if no line is played for 8 seconds, advance to the next seat (any member may invoke the check).
-- Refactors advance-turn logic into relay_advance_turn_for_room() for reuse.

create or replace function public.relay_advance_turn_for_room(p_room_id uuid)
returns void
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
  select current_turn_seat into cur from public.rooms where id = p_room_id for update;
  if not found then
    return;
  end if;

  select coalesce(array_agg(seat_order order by seat_order), array[]::int[])
  into seats
  from public.room_members
  where room_id = p_room_id;

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

  if idx is null then
    return;
  end if;

  if len = 1 then
    next_seat := seats[1];
  else
    next_seat := seats[((idx % len) + 1)];
  end if;

  update public.rooms
  set current_turn_seat = next_seat,
      turn_started_at = now()
  where id = p_room_id;
end;
$$;

create or replace function public.lines_after_insert_advance_turn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  total_words bigint;
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

  perform public.relay_advance_turn_for_room(NEW.room_id);
  return NEW;
end;
$$;

-- Call from clients while viewing an active room (polling). Only advances if turn_started_at is older than 8s.
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
  if room_row.turn_started_at > now() - interval '8 seconds' then
    return false;
  end if;

  perform public.relay_advance_turn_for_room(p_room_id);
  return true;
end;
$$;

grant execute on function public.advance_turn_if_stale(uuid) to authenticated;

-- Skip the current player's turn and insert a funny auto-line so the song keeps flowing.
-- The insert fires lines_after_insert_advance_turn which advances the turn automatically.
create or replace function public.skip_turn_with_placeholder(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
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

  select user_id into skipped_uid
  from public.room_members
  where room_id = p_room_id and seat_order = room_row.current_turn_seat;

  if skipped_uid is null then
    return false;
  end if;

  chosen := fillers[1 + (floor(random() * array_length(fillers, 1)))::int];

  -- Insert as the skipped player so the trigger's seat check passes.
  -- The after-insert trigger will advance the turn automatically.
  insert into public.lines (room_id, author_id, content)
  values (p_room_id, skipped_uid, chosen);

  return true;
end;
$$;

grant execute on function public.skip_turn_with_placeholder(uuid) to authenticated;
