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
      <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center px-6">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-relay-live border-t-transparent" />
      </main>
    );
  }

  // Name prompt (first visit)
  if (!name) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center px-6 pb-16">
        <div className="mb-10 text-center">
          <h1 className="text-5xl font-black tracking-tight text-relay-text">Relay</h1>
          <p className="mt-3 text-relay-text/55">
            Co-write songs with friends, one line at a time.
          </p>
        </div>
        <form onSubmit={onSaveName} className="w-full space-y-3">
          <label className="block text-sm font-medium text-relay-text/60">
            What&apos;s your name?
          </label>
          <input
            ref={nameInputRef}
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="Your name"
            maxLength={24}
            className="w-full rounded-xl border border-relay-text/15 bg-relay-card px-4 py-3.5 text-center text-lg font-medium text-relay-text outline-none ring-relay-live/40 placeholder:text-relay-text/25 focus:ring-2"
          />
          <button
            type="submit"
            disabled={!nameInput.trim()}
            className="w-full rounded-xl bg-relay-live py-3.5 font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
          >
            Let&apos;s play →
          </button>
        </form>
        {err ? (
          <p className="mt-5 max-h-64 overflow-y-auto whitespace-pre-wrap text-center text-xs leading-relaxed text-relay-urgency">
            {err}
          </p>
        ) : null}
      </main>
    );
  }

  // Main lobby
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 pb-16">
      <div className="mb-10">
        <h1 className="text-5xl font-black tracking-tight text-relay-text">Relay</h1>
        <p className="mt-2 text-relay-text/55">
          Hey, <span className="font-medium text-relay-text">{name}</span> 👋
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {/* ── Quick Play ── */}
        <button
          type="button"
          disabled={busy || !authReady}
          onClick={() => void onQuickPlay()}
          className="relative rounded-xl bg-relay-live px-4 py-4 text-center font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
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

        <div className="my-3 flex items-center gap-3">
          <div className="h-px flex-1 bg-relay-text/10" />
          <span className="text-xs text-relay-text/30">or</span>
          <div className="h-px flex-1 bg-relay-text/10" />
        </div>

        {/* ── Create private room ── */}
        <button
          type="button"
          disabled={busy || !authReady}
          onClick={() => void onCreate()}
          className="rounded-xl border border-relay-text/15 bg-relay-card px-4 py-3.5 text-center font-semibold text-relay-text transition hover:bg-relay-active disabled:opacity-50"
        >
          {busyMode === "private"
            ? "Creating room…"
            : !authReady
              ? "Connecting…"
              : "Create private room"}
        </button>
        <p className="text-center text-xs text-relay-text/40">
          You get a room code and invite link to share with friends.
        </p>

        {/* ── Join by code ── */}
        <div className="mt-2 rounded-xl bg-relay-card p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-relay-text">Join a room</h2>
          <p className="mt-0.5 text-xs text-relay-text/50">
            Paste a code or full invite link.
          </p>
          <form onSubmit={onJoin} className="mt-4 flex flex-col gap-3">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="AYK8PK or invite URL"
              className="w-full rounded-lg border border-relay-text/10 bg-relay-bg px-3 py-2.5 text-center font-mono text-sm uppercase tracking-widest text-relay-text outline-none ring-relay-live/30 placeholder:normal-case placeholder:tracking-normal placeholder:text-relay-text/30 focus:ring-2 sm:text-lg"
            />
            <button
              type="submit"
              className="w-full rounded-lg bg-relay-active py-2.5 font-medium text-relay-text transition hover:opacity-90"
            >
              Join game →
            </button>
          </form>
        </div>
      </div>

      {err ? (
        <p className="mt-5 max-h-64 overflow-y-auto whitespace-pre-wrap text-center text-xs leading-relaxed text-relay-urgency">
          {err}
        </p>
      ) : null}

      <div className="mt-12 flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            localStorage.removeItem(NAME_KEY);
            setName("");
            setNameInput("");
          }}
          className="text-xs text-relay-text/30 underline"
        >
          Not {name}? Change name
        </button>
        <button
          type="button"
          onClick={music.toggleMute}
          className="flex items-center gap-1 text-xs text-relay-text/30 transition hover:text-relay-text/60"
          title={music.muted ? "Unmute music" : "Mute music"}
        >
          {music.muted ? "🔇" : "🎵"}
          <span>{music.muted ? "Music off" : "Music on"}</span>
        </button>
      </div>
    </main>
  );
}
