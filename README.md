# Relay V1

Private rooms, **2–5 players**, **turns**, **handoff** (last four normalized words), and **Supabase Realtime** updates. Stack: **Next.js 14** (App Router), **Supabase** (Auth, Postgres, Realtime), **Tailwind**.

## Setup

1. **Create a Supabase project** and enable **Email** auth (magic link). In **Authentication → URL configuration**, add redirect URLs:
   - `http://localhost:3000/auth/callback`
   - your production URL + `/auth/callback`

2. **Run the SQL migrations** in order in the Supabase **SQL Editor** (each file once, unless noted):
   - `001_relay_private_rooms.sql` — schema, RLS, triggers, realtime  
   - `002_line_length_50_chars.sql` — only if you previously ran `001` with a higher line length  
   - `003_song_completion.sql` — when total song words reach **80**, the room locks (`completed`)  
   - `004_turn_timeout.sql` — **120s** turn timer; stale turns advance automatically (clients poll `advance_turn_if_stale`)  
   If `alter publication` in `001` errors because tables are already in the publication, skip those lines or ignore the error.  
   If you previously ran an older migration that used a **100-word** threshold, run the current `003_song_completion.sql` once to replace the trigger with the **80-word** rule.

3. **Environment** — copy `.env.local.example` to `.env.local` and set:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`

4. **Install and dev**

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in, **Play with friends** to create a room, share the link, **Join game** from another browser/session, host **Start game** with 2–5 players, then take turns with **Play turn**. Each turn allows **up to 50 characters** per line. The song ends when it reaches **at least 80 words** (same word rules as handoffs); the room then locks and shows **Song complete**.

## Vertical slice scope

- Private room + invite link  
- 2–5 players, host starts when ready  
- Strict turn order (no back-to-back; DB enforced)  
- Handoff rules aligned with v3 doc (normalize, &lt;4 words = full line, hyphenated tokens)  
- Realtime refresh on `rooms`, `room_members`, `lines`  
- **80-word** song completion → room `completed`, no more lines  
- **Turn timeout** — **120 seconds** per turn; anyone in the room triggers checks (polling); DB advances the seat  

Not in this slice: public lobby matchmaking, profiles.
