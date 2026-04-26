-- Replace any (text,int) / (int,text) overload with single-arg jsonb for PostgREST.

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
