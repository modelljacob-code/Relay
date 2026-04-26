-- When total words across all lines in a room reach 80, lock the game (status = completed).
-- Uses the same word token rules as relay_word_array (normalize, split on whitespace).

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
