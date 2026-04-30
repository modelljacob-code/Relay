"use client";

import { createPrivateRoom, quickPlay } from "@/app/actions/rooms";
import { parseRoomCodeFromInput } from "@/lib/room-code";
import { useMusicControl } from "@/app/components/BackgroundMusic";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const NAME_KEY = "relay_player_name";

/** Turns Supabase client errors into actionable copy (avoid blaming “Anonymous” for network failures). */
function supabaseAuthBootstrapMessage(raw: string): string {
  const m = raw.toLowerCase();
  if (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("load failed") ||
    m.includes("network request failed")
  ) {
    return [
      raw,
      "",
      "The browser could not reach your Supabase project. That is usually not an “Anonymous auth” setting issue. Check:",
      "• .env.local has the real NEXT_PUBLIC_SUPABASE_URL (https://….supabase.co) and NEXT_PUBLIC_SUPABASE_ANON_KEY from Supabase → Settings → API.",
      "• You restarted npm run dev after changing .env.local (Next only loads env at startup).",
      "• The project is not paused in the Supabase dashboard.",
      "• Nothing (VPN, firewall, extension) is blocking *.supabase.co.",
    ].join("\n");
  }
  return [
    raw,
    "",
    "If Supabase rejected anonymous sign-in: Dashboard → Authentication → Providers → enable Anonymous.",
    "Also confirm URL and anon key match Settings → API.",
  ].join("\n");
}

function HomeShell({ children }: { children: React.ReactNode }) {
  return <div className="relative z-0 min-h-screen">{children}</div>;
}

export function HomeClient() {
  const router = useRouter();
  const music = useMusicControl();
  const [name, setName] = useState<string | null>(null); // null = not loaded yet
  const [nameInput, setNameInput] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyMode, setBusyMode] = useState<"quick" | "private" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Anonymous Supabase session is ready (cookies set) so server actions see auth.uid(). */
  const [authReady, setAuthReady] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = localStorage.getItem(NAME_KEY) ?? "";
    setName(stored);

    const supabase = createClient();
    void (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) {
          const { error } = await supabase.auth.signInAnonymously();
          if (error) throw error;
        }
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : "Could not sign in anonymously.";
        setErr(supabaseAuthBootstrapMessage(msg));
      } finally {
        setAuthReady(true);
      }
    })();
  }, []);

  /** Ensures session cookies exist before server actions (avoids race on first click). */
  async function ensureSupabaseSession(): Promise<boolean> {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session) return true;
    const { error } = await supabase.auth.signInAnonymously();
    if (error) {
      setErr(error.message);
      return false;
    }
    return true;
  }

  useEffect(() => {
    if (name === "") {
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [name]);

  function onSaveName(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = nameInput.trim().slice(0, 24);
    if (!trimmed) return;
    localStorage.setItem(NAME_KEY, trimmed);
    setName(trimmed);
  }

  async function onQuickPlay() {
    setBusy(true);
    setBusyMode("quick");
    setErr(null);
    if (!(await ensureSupabaseSession())) {
      setBusy(false);
      setBusyMode(null);
      return;
    }
    const res = await quickPlay(name ?? "");
    setBusy(false);
    setBusyMode(null);
    if (res.error) {
      setErr(res.error);
      return;
    }
    if (res.code) router.push(`/room/${res.code}`);
  }

  async function onCreate() {
    setBusy(true);
    setBusyMode("private");
    setErr(null);
    if (!(await ensureSupabaseSession())) {
      setBusy(false);
      setBusyMode(null);
      return;
    }
    const res = await createPrivateRoom(name ?? "");
    setBusy(false);
    setBusyMode(null);
    if (res.error) {
      setErr(res.error);
      return;
    }
    if (res.code) router.push(`/room/${res.code}`);
  }

  function onJoin(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const c = parseRoomCodeFromInput(joinCode);
    if (c.length < 4) {
      setErr("Enter a valid room code or paste the invite link.");
      return;
    }
    router.push(`/room/${c}`);
  }

  // Loading state (localStorage not yet read)
  if (name === null) {
    return (
      <HomeShell>
        <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center px-6 motion-safe:animate-home-fade-in">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-relay-text/30 border-t-relay-text" />
        </main>
      </HomeShell>
    );
  }

  // Name prompt (first visit)
  if (!name) {
    return (
      <HomeShell>
        <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 pb-16 motion-safe:animate-home-fade-in">
          <div className="mb-12 w-full text-center">
            <h1 className="text-5xl font-black tracking-tight text-relay-text md:text-6xl">
              Relay
            </h1>
            <p className="mx-auto mt-4 max-w-lg text-center text-lg font-medium leading-snug text-relay-text/90 sm:text-xl">
              Write a line and Pass it on
            </p>
          </div>
          <form onSubmit={onSaveName} className="w-full max-w-sm space-y-3">
            <label className="block text-center text-sm font-medium text-relay-text/50">
              What&apos;s your name?
            </label>
            <input
              ref={nameInputRef}
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Your name"
              maxLength={24}
              className="w-full rounded-xl border border-relay-text/15 bg-relay-bg/80 px-4 py-3.5 text-center text-lg font-medium text-relay-text outline-none ring-relay-live/35 placeholder:text-relay-text/30 backdrop-blur-sm focus:ring-2"
            />
            <button
              type="submit"
              disabled={!nameInput.trim()}
              className="w-full rounded-xl bg-relay-live py-3.5 font-semibold text-white shadow-lg shadow-black/30 transition hover:scale-[1.02] hover:brightness-110 active:scale-[0.99] disabled:opacity-40 disabled:hover:scale-100 disabled:hover:brightness-100"
            >
              Let&apos;s play →
            </button>
          </form>
          {err ? (
            <p className="mt-5 max-h-64 overflow-y-auto whitespace-pre-wrap text-center text-xs leading-relaxed text-red-300/90">
              {err}
            </p>
          ) : null}
        </main>
      </HomeShell>
    );
  }

  // Main lobby
  return (
    <HomeShell>
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 pb-16 pt-8 motion-safe:animate-home-fade-in">
        <header className="mb-14 text-center">
          <h1 className="text-5xl font-black tracking-tight text-relay-text md:text-6xl">
            Relay
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-lg font-medium leading-snug text-relay-text/90 sm:text-xl">
            Write a line and Pass it on
          </p>
          <p className="mt-8 text-sm text-relay-text/50">
            Hey, <span className="font-medium text-relay-text/90">{name}</span>
          </p>
        </header>

        <div className="flex flex-col gap-10">
          {/* ── Quick Play (primary) ── */}
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              disabled={busy || !authReady}
              onClick={() => void onQuickPlay()}
              className="w-full max-w-sm rounded-xl bg-relay-live px-4 py-4 text-center text-lg font-bold text-white shadow-lg shadow-black/35 transition hover:scale-[1.02] hover:brightness-110 active:scale-[0.99] disabled:opacity-50 disabled:hover:scale-100 disabled:hover:brightness-100"
            >
              {busyMode === "quick" ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Finding a game…
                </span>
              ) : !authReady ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Connecting…
                </span>
              ) : (
                "Quick Play"
              )}
            </button>
            <p className="text-center text-sm text-relay-text/55">Get matched in seconds</p>
          </div>

          <div className="flex items-center gap-4">
            <div className="h-px flex-1 bg-relay-text/35" />
            <span className="shrink-0 text-sm font-semibold uppercase tracking-[0.18em] text-relay-text/90">
              or
            </span>
            <div className="h-px flex-1 bg-relay-text/35" />
          </div>

          {/* ── Secondary: private room ── */}
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              disabled={busy || !authReady}
              onClick={() => void onCreate()}
              className="w-full max-w-sm rounded-xl border border-relay-text/20 bg-relay-card/50 px-4 py-3 text-center text-sm font-semibold text-relay-text/90 backdrop-blur-sm transition hover:scale-[1.01] hover:border-relay-text/30 hover:bg-relay-card active:scale-[0.99] disabled:opacity-50 disabled:hover:scale-100"
            >
              {busyMode === "private"
                ? "Creating room…"
                : !authReady
                  ? "Connecting…"
                  : "Create Private Room"}
            </button>
          </div>

          {/* ── Join (tertiary) ── */}
          <div className="rounded-xl border border-relay-text/12 bg-relay-card/70 p-4 shadow-sm shadow-black/25 backdrop-blur-sm">
            <h2 className="text-center text-xs font-semibold uppercase tracking-wider text-relay-text/45">
              Join a room
            </h2>
            <form onSubmit={onJoin} className="mt-3 flex flex-col gap-2.5">
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                placeholder="Code or invite link"
                className="w-full rounded-lg border border-relay-text/12 bg-relay-bg/60 px-3 py-2 text-center font-mono text-sm uppercase tracking-widest text-relay-text outline-none ring-relay-live/25 placeholder:normal-case placeholder:tracking-normal placeholder:text-relay-text/25 focus:ring-1"
              />
              <button
                type="submit"
                className="w-full rounded-lg border border-relay-text/15 bg-transparent py-2 text-sm font-medium text-relay-text/75 transition hover:scale-[1.01] hover:border-relay-text/25 hover:bg-relay-card/50 hover:text-relay-text active:scale-[0.99]"
              >
                Join Game
              </button>
            </form>
          </div>
        </div>

        {err ? (
          <p className="mt-8 max-h-64 overflow-y-auto whitespace-pre-wrap text-center text-xs leading-relaxed text-red-300/90">
            {err}
          </p>
        ) : null}

        <div className="mt-14 flex items-center justify-between gap-4 text-sm font-medium text-relay-text/95">
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem(NAME_KEY);
              setName("");
              setNameInput("");
            }}
            className="text-left underline decoration-relay-text/55 underline-offset-[3px] transition hover:text-relay-text hover:decoration-relay-text"
          >
            Not {name}? Change name
          </button>
          <button
            type="button"
            onClick={music.toggleMute}
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-1 py-0.5 transition hover:bg-relay-card/60 hover:text-relay-text"
            title={music.muted ? "Unmute music" : "Mute music"}
          >
            {music.muted ? "🔇" : "🎵"}
            <span>{music.muted ? "Music off" : "Music on"}</span>
          </button>
        </div>
      </main>
    </HomeShell>
  );
}
