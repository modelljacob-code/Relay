-- Bot lines use author_id NULL. The original policy required auth.uid() = author_id,
-- which is never true for NULL (unknown), so bot inserts failed under RLS.
-- Allow inserts when the active turn seat is a bot and the caller is a room member.

drop policy if exists "lines_insert_bot_turn" on public.lines;

create policy "lines_insert_bot_turn"
  on public.lines for insert
  with check (
    coalesce(is_bot_line, false) = true
    and author_id is null
    and public.i_am_in_room(room_id)
    and exists (
      select 1
      from public.rooms r
      join public.room_members mb
        on mb.room_id = r.id
       and mb.is_bot = true
       and mb.seat_order = r.current_turn_seat
      where r.id = lines.room_id
        and r.status = 'active'
    )
  );
