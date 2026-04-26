-- If you already ran 001 with a higher limit, apply this to match the app (50 chars per turn).
alter table public.lines drop constraint if exists lines_content_len;
alter table public.lines
  add constraint lines_content_len check (char_length(content) >= 1 and char_length(content) <= 50);
