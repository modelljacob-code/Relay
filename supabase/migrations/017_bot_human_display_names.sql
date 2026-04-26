-- Bot lobby names: first + last style (read like real players), not poetic adj+noun.

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
begin
  if p_count <= 0 then return 0; end if;

  select * into r from public.rooms where id = p_room_id for update;
  if not found or r.status <> 'waiting' then return 0; end if;

  while k < p_count loop
    select count(*)::int into i from public.room_members where room_id = p_room_id;
    if i >= r.max_players then exit; end if;

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
