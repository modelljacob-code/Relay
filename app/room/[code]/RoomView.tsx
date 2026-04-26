"use client";

import { trySubmitLlmBotLine } from "@/app/actions/botTurn";
import { runItBack, submitLine, updateDisplayName } from "@/app/actions/rooms";
import { totalSongWordCount } from "@/lib/handoff";
import {
  MAX_CHARS_PER_TURN,
  TARGET_SONG_WORDS,
  TURN_TIMEOUT_SECONDS,
} from "@/lib/relay-constants";
import { isRelayBotDebug, relayBotLog } from "@/lib/relay-bot-debug";
import { repairStuckTurnIfSameSeat } from "@/lib/repair-stuck-turn";
import { canWebShare, getRoomInviteUrl, shareRoomInvite } from "@/lib/invite";
import { createClient } from "@/lib/supabase/client";
import { MusicPicker } from "@/app/components/MusicPicker";
import { useMusicControl } from "@/app/components/BackgroundMusic";
import { useSounds, useTimerTick } from "@/lib/useSounds";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const NAME_KEY = "relay_player_name";

type RoomRow = {
  id: string;
  code: string;
  host_id: string;
  status: "waiting" | "active" | "completed";
  current_turn_seat: number;
  max_players: number;
  turn_started_at: string;
  next_room_code: string | null;
  is_quick_play: boolean;
  auto_start_at: string | null;
};

type MemberRow = {
  user_id: string | null;
  seat_order: number;
  display_name: string;
  is_bot?: boolean;
  ready?: boolean;
};

type LineRow = {
  id: string;
  author_id: string | null;
  content: string;
  handoff_key: string;
  position: number;
  created_at: string;
};

type PreviewRow = {
  room_id: string;
  status: string;
  player_count: number;
  max_players: number;
  host_id: string;
  is_quick_play?: boolean;
};

// ── Song feed sub-component ───────────────────────────────────────────────────

function SongFeed({
  lines,
  members,
  myUserId,
  status,
  wordTotal,
  className = "",
}: {
  lines: LineRow[];
  members: MemberRow[];
  myUserId: string | null;
  status: string;
  wordTotal: number;
  className?: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length]);

  const memberMap = useMemo(() => {
    const m = new Map<string, string>();
    members.forEach((mem) => {
      const label = mem.display_name || `P${mem.seat_order + 1}`;
      if (mem.user_id) m.set(mem.user_id, label);
      m.set(`seat:${mem.seat_order}`, label);
    });
    return m;
  }, [members]);

  return (
    <div className={className}>
      {lines.length === 0 ? (
        <p className="text-xs italic text-relay-text/30">
          The song hasn&apos;t started yet…
        </p>
      ) : (
        <ol className="space-y-2">
          {lines.map((line, i) => {
            const isLast = i === lines.length - 1;
            const isSkip =
              line.content.startsWith("[") && line.content.endsWith("]");
            const isMe =
              line.author_id !== null && line.author_id === myUserId;
            const authorName = isMe
              ? "You"
              : !line.author_id
                ? "Player"
                : (memberMap.get(line.author_id) ?? "—");

            return (
              <li
                key={line.id}
                className={`rounded-lg px-3 py-2 text-sm leading-relaxed transition-all ${
                  isLast && status === "active"
                    ? "border border-relay-live/30 bg-relay-live/8 text-relay-text"
                    : isSkip
                      ? "italic text-relay-text/25"
                      : "text-relay-text/65"
                }`}
              >
                <span className="mr-1 text-xs text-relay-text/20">
                  {line.position}.
                </span>
                {!isSkip && (
                  <span
                    className={`mr-1.5 text-xs font-semibold ${isMe ? "text-relay-live/70" : "text-relay-text/35"}`}
                  >
                    {authorName}:
                  </span>
                )}
                {line.content}
              </li>
            );
          })}
          <div ref={endRef} />
        </ol>
      )}
      {lines.length > 0 && (
        <p className="mt-3 text-right text-xs text-relay-text/30">
          {wordTotal} / {TARGET_SONG_WORDS} words
        </p>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function RoomView({ code }: { code: string }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();

  // Auth & identity
  const [userId, setUserId] = useState<string | null>(null);
  const [myDisplayName, setMyDisplayName] = useState("");
  const [authReady, setAuthReady] = useState(false);

  // Room state
  const [room, setRoom] = useState<RoomRow | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [preview, setPreview] = useState<PreviewRow | null>(null);
  const [needsJoin, setNeedsJoin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Auto-start countdown for quick play rooms
  const [autoStartSecondsLeft, setAutoStartSecondsLeft] = useState<number | null>(null);

  // UI state
  const [joinBusy, setJoinBusy] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [lineDraft, setLineDraft] = useState("");
  const [submitBusy, setSubmitBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [songCopied, setSongCopied] = useState(false);
  const [newGameBusy, setNewGameBusy] = useState(false);
  const [turnClockTick, setTurnClockTick] = useState(0);
  const [musicPickerOpen, setMusicPickerOpen] = useState(false);

  // Countdown animation (3-2-1-GO on game start)
  const [countdown, setCountdown] = useState<number | null>(null);
  const prevStatusRef = useRef<string | null>(null);
  const prevCountdownForFirstTurnRef = useRef<number | null>(null);

  // Turn flash animation
  const prevTurnSeatRef = useRef<number | null>(null);
  const [turnFlash, setTurnFlash] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  /** Always read latest game phase inside interval callbacks (avoids stale `status` closures). */
  const roomStatusRef = useRef(room?.status);
  roomStatusRef.current = room?.status;

  /** Latest turn seat for repair after bot SQL tick (trigger may not advance `rooms` under RLS). */
  const currentTurnSeatRef = useRef<number | null>(null);
  currentTurnSeatRef.current =
    room?.current_turn_seat !== undefined ? room.current_turn_seat : null;

  /** Latest members for interval (avoid calling LLM on human turns). */
  const membersRef = useRef<MemberRow[]>([]);
  membersRef.current = members;

  /** Latest lines + turn clock for tick (skip LLM when bot line already visible; repair stuck turn). */
  const linesRef = useRef<LineRow[]>([]);
  linesRef.current = lines;
  const turnStartedAtRef = useRef<string | null>(null);
  turnStartedAtRef.current = room?.turn_started_at ?? null;

  /** One active-game tick at a time so slow LLM awaits do not stack concurrent OpenAI calls. */
  const botTurnPipelineBusyRef = useRef(false);

  // ── Sound system ───────────────────────────────────────────────────────────
  const sounds = useSounds();
  const music = useMusicControl();

  // ── Sync display name from DB member record ────────────────────────────────
  useEffect(() => {
    if (!userId || members.length === 0) return;
    const me = members.find((m) => m.user_id === userId);
    if (me?.display_name) {
      setMyDisplayName(me.display_name);
      localStorage.setItem(NAME_KEY, me.display_name);
    }
  }, [members, userId]);

  // ── Auth init (anon sign-in) ────────────────────────────────────────────────

  useEffect(() => {
    const init = async () => {
      const storedName = localStorage.getItem(NAME_KEY) ?? "";
      setMyDisplayName(storedName);

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        await supabase.auth.signInAnonymously();
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) setUserId(user.id);
      setAuthReady(true);
    };
    void init();
  }, [supabase]);

  // ── Data loading ───────────────────────────────────────────────────────────

  const loadByRoomId = useCallback(
    async (roomId: string): Promise<MemberRow[] | null> => {
      const [rRes, mRes, lRes] = await Promise.all([
        supabase.from("rooms").select("*").eq("id", roomId).single(),
        supabase
          .from("room_members")
          .select("user_id, seat_order, display_name, is_bot, ready")
          .eq("room_id", roomId)
          .order("seat_order", { ascending: true }),
        supabase
          .from("lines")
          .select("*")
          .eq("room_id", roomId)
          .order("position", { ascending: true }),
      ]);
      if (rRes.error || !rRes.data) {
        setError(rRes.error?.message ?? "Could not load room.");
        return null;
      }
      const memberRows = (mRes.data as MemberRow[]) ?? [];
      setRoom(rRes.data as RoomRow);
      setMembers(memberRows);
      setLines((lRes.data as LineRow[]) ?? []);
      setNeedsJoin(false);
      return memberRows;
    },
    [supabase]
  );

  const tryLoadByCode = useCallback(async () => {
    setLoading(true);
    setError(null);

    const fetchRoomByCode = () =>
      supabase.from("rooms").select("*").eq("code", code).maybeSingle();

    let { data: r, error: rErr } = await fetchRoomByCode();
    if (!(r && !rErr)) {
      await new Promise((res) => setTimeout(res, 200));
      const second = await fetchRoomByCode();
      r = second.data;
      rErr = second.error;
    }

    if (r && !rErr) {
      await loadByRoomId(r.id);
      setLoading(false);
      return;
    }

    const { data: pv, error: pErr } = await supabase.rpc(
      "preview_room_by_code",
      { p_code: code }
    );

    if (pErr) {
      setError(pErr.message);
      setLoading(false);
      return;
    }

    const row = Array.isArray(pv) ? pv[0] : pv;
    if (!row) {
      setError("Room not found.");
      setLoading(false);
      return;
    }

    setPreview(row as PreviewRow);
    setNeedsJoin(true);
    setRoom(null);
    setMembers([]);
    setLines([]);
    setLoading(false);
  }, [code, loadByRoomId, supabase]);

  // Load once auth is ready
  useEffect(() => {
    if (!authReady) return;
    void tryLoadByCode();
  }, [authReady, tryLoadByCode]);

  // ── Realtime subscription ──────────────────────────────────────────────────

  useEffect(() => {
    if (!room?.id) return;
    const roomId = room.id;
    const refresh = () => void loadByRoomId(roomId);
    const channel = supabase
      .channel(`relay-room-${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rooms",
          filter: `id=eq.${roomId}`,
        },
        refresh
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "room_members",
          filter: `room_id=eq.${roomId}`,
        },
        refresh
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "lines",
          filter: `room_id=eq.${roomId}`,
        },
        refresh
      )
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [room?.id, loadByRoomId, supabase]);

  // ── Redirect when "run it back" is triggered by any player ────────────────

  useEffect(() => {
    if (room?.next_room_code) {
      router.push(`/room/${room.next_room_code}`);
    }
  }, [room?.next_room_code, router]);

  // ── Turn clock ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (room?.status !== "active") return;
    const id = window.setInterval(
      () => setTurnClockTick((n) => n + 1),
      1000
    );
    return () => window.clearInterval(id);
  }, [room?.status, room?.id]);

  // Background poll — calls skip_turn_with_placeholder every ~10 s as fallback
  useEffect(() => {
    if (room?.status !== "active" || !room.id || countdown !== null) return;
    const roomId = room.id;
    const poll = async () => {
      const { data, error: e } = await supabase.rpc(
        "skip_turn_with_placeholder",
        { p_room_id: roomId }
      );
      if (!e && data === true) await loadByRoomId(roomId);
    };
    const id = window.setInterval(poll, 10000);
    return () => window.clearInterval(id);
  }, [room?.id, room?.status, room?.turn_started_at, countdown, supabase, loadByRoomId]);

  // ── Game-start countdown animation (3-2-1-GO) ─────────────────────────────

  useEffect(() => {
    if (!room?.status) return;
    if (prevStatusRef.current === "waiting" && room.status === "active") {
      setCountdown(3);
    }
    prevStatusRef.current = room.status;
  }, [room?.status]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      const id = setTimeout(() => setCountdown(null), 800);
      return () => clearTimeout(id);
    }
    const id = setTimeout(
      () => setCountdown((c) => (c !== null ? c - 1 : null)),
      1000
    );
    return () => clearTimeout(id);
  }, [countdown]);

  // After GO: reset server turn clock so the first line gets a full 15s window
  useEffect(() => {
    const was = prevCountdownForFirstTurnRef.current;
    const roomId = room?.id;
    if (
      roomId &&
      room.status === "active" &&
      was !== null &&
      countdown === null &&
      lines.length === 0
    ) {
      void supabase
        .rpc("relay_align_first_turn_after_countdown", { p_room_id: roomId })
        .then(() => void loadByRoomId(roomId));
    }
    prevCountdownForFirstTurnRef.current = countdown;
  }, [
    countdown,
    room?.id,
    room?.status,
    lines.length,
    supabase,
    loadByRoomId,
  ]);

  // Beep on each countdown step (3-2-1-GO)
  useEffect(() => {
    if (countdown === null) return;
    sounds.countdownBeep(countdown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown]);

  // ── Turn flash ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (room?.current_turn_seat === undefined) return;
    if (
      prevTurnSeatRef.current !== null &&
      prevTurnSeatRef.current !== room.current_turn_seat
    ) {
      setTurnFlash(true);
      const id = setTimeout(() => setTurnFlash(false), 600);
      return () => clearTimeout(id);
    }
    prevTurnSeatRef.current = room.current_turn_seat;
  }, [room?.current_turn_seat]);

  // ── Lobby auto-start countdown (private rooms only; Quick Play is ready-driven)

  useEffect(() => {
    if (!room?.auto_start_at || room.status !== "waiting" || room.is_quick_play) {
      setAutoStartSecondsLeft(null);
      return;
    }
    const target = new Date(room.auto_start_at).getTime();
    const tick = () => {
      const secs = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      setAutoStartSecondsLeft(secs);
      if (secs <= 0) {
        void supabase
          .rpc("relay_room_tick", { p_room_id: room.id })
          .then(() => void loadByRoomId(room.id));
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [room?.auto_start_at, room?.status, room?.id, room?.is_quick_play, supabase, loadByRoomId]);

  // ── Lobby / active: server tick; active = optional LLM line then SQL fallback

  useEffect(() => {
    if (!room?.id) return;
    if (room.status !== "waiting" && room.status !== "active") return;
    const roomId = room.id;
    const tick = () => {
      void (async () => {
        const liveStatus = roomStatusRef.current;
        if (liveStatus === "active" && botTurnPipelineBusyRef.current) {
          if (isRelayBotDebug()) {
            relayBotLog("client_interval_tick_skipped", { roomId, reason: "bot_pipeline_busy" });
          }
          return;
        }
        if (liveStatus === "active") botTurnPipelineBusyRef.current = true;
        try {
          if (isRelayBotDebug()) {
            relayBotLog("client_interval_tick", { roomId, liveStatus });
          }
          const seatBeforeTick =
            liveStatus === "active" ? currentTurnSeatRef.current : null;
          if (liveStatus === "active") {
            const seat = currentTurnSeatRef.current;
            const curMember =
              seat == null
                ? undefined
                : membersRef.current.find(
                    (m) => Number(m.seat_order) === Number(seat)
                  );
            // Only hit the server when this client sees a bot seat (human turns otherwise spam
            // `not_bot_seat` and waste a round trip).
            if (curMember?.is_bot) {
              const turnAt = turnStartedAtRef.current;
              const hasLineThisTurn =
                turnAt != null &&
                linesRef.current.some(
                  (l) =>
                    new Date(l.created_at).getTime() >= new Date(turnAt).getTime()
                );
              if (hasLineThisTurn) {
                // Bot line is already in the feed but the seat may not have advanced (RLS/trigger).
                // Repair locally — do not POST trySubmitLlmBotLine (avoids noisy line_already logs).
                await repairStuckTurnIfSameSeat(
                  supabase,
                  roomId,
                  Number(seat)
                );
                if (isRelayBotDebug()) {
                  relayBotLog("client:bot_turn_repair_only", { roomId, seat });
                }
              } else {
                // Await LLM first (with server-side timeout) so SQL relay_room_tick only fills
                // if the model did not submit — parallel fire-and-forget always lost to SQL.
                try {
                  const r = await trySubmitLlmBotLine(roomId);
                  if (isRelayBotDebug()) {
                    relayBotLog("trySubmitLlmBotLine:client_result", { roomId, r });
                  }
                } catch (e) {
                  if (isRelayBotDebug()) {
                    relayBotLog("trySubmitLlmBotLine:client_throw", {
                      roomId,
                      err: e instanceof Error ? e.message : String(e),
                    });
                  }
                }
              }
            }
          }
          const { data: tickData, error: tickErr } = await supabase.rpc(
            "relay_room_tick",
            { p_room_id: roomId }
          );
          if (isRelayBotDebug()) {
            relayBotLog("relay_room_tick:client_rpc_done", {
              roomId,
              data: tickData,
              error: tickErr?.message ?? null,
            });
          }
          await loadByRoomId(roomId);
          if (
            liveStatus === "active" &&
            tickData === true &&
            seatBeforeTick !== null
          ) {
            await repairStuckTurnIfSameSeat(
              supabase,
              roomId,
              Number(seatBeforeTick)
            );
            await loadByRoomId(roomId);
          }
        } finally {
          if (liveStatus === "active") botTurnPipelineBusyRef.current = false;
        }
      })();
    };
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [room?.id, room?.status, supabase, loadByRoomId]);

  useEffect(() => {
    if (!isRelayBotDebug()) return;
    if (room?.status !== "active" || room.turn_started_at == null) return;
    const seat = room.current_turn_seat;
    const m = members.find((x) => Number(x.seat_order) === Number(seat));
    relayBotLog("turn:state_after_render", {
      roomId: room.id,
      current_turn_seat: seat,
      turn_started_at: room.turn_started_at,
      seatIsBot: m?.is_bot ?? null,
      seatLabel: m?.display_name ?? null,
    });
  }, [
    room?.id,
    room?.status,
    room?.current_turn_seat,
    room?.turn_started_at,
    members,
  ]);

  // ── When countdown hits 0, skip stale turn immediately ────────────────────

  const secondsLeftOnTurn = useMemo(() => {
    void turnClockTick;
    if (room?.status !== "active" || !room.turn_started_at) return null;
    // Freeze at full time while the 3-2-1 game-start countdown is playing
    // so the first turn always has the full 15 seconds after GO.
    if (countdown !== null) return TURN_TIMEOUT_SECONDS;
    const deadline =
      new Date(room.turn_started_at).getTime() + TURN_TIMEOUT_SECONDS * 1000;
    return Math.min(
      TURN_TIMEOUT_SECONDS,
      Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    );
  }, [room?.status, room?.turn_started_at, turnClockTick, countdown]);

  useEffect(() => {
    // Don't skip during the 3-2-1 — the first player should get full time.
    if (countdown !== null) return;
    if (secondsLeftOnTurn !== 0 || !room?.id || room.status !== "active") return;
    const roomId = room.id;
    const skip = async () => {
      const { data, error: e } = await supabase.rpc(
        "skip_turn_with_placeholder",
        { p_room_id: roomId }
      );
      if (!e && data === true) {
        sounds.skip();
        await loadByRoomId(roomId);
      }
    };
    void skip();
  }, [secondsLeftOnTurn, room?.id, room?.status, supabase, loadByRoomId]);

  // ── Auto-focus textarea when it's your turn ───────────────────────────────

  const isMyTurn =
    room?.status === "active" &&
    userId !== null &&
    members.find((m) => m.user_id === userId)?.seat_order ===
      room.current_turn_seat;

  useEffect(() => {
    if (isMyTurn) setTimeout(() => inputRef.current?.focus(), 50);
  }, [isMyTurn]);

  // Play "your turn" sound when turn switches to me
  const prevIsMyTurnRef = useRef(false);
  useEffect(() => {
    if (isMyTurn && !prevIsMyTurnRef.current && countdown === null) {
      sounds.turnStart();
    }
    prevIsMyTurnRef.current = !!isMyTurn;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMyTurn, countdown]);

  // Stop music when song completes, play game-end sound
  const prevRoomStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevRoomStatusRef.current;
    const cur = room?.status ?? null;
    if (prev === "active" && cur === "completed") {
      sounds.gameEnd();
      music.stop();
    }
    prevRoomStatusRef.current = cur;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.status]);

  // Timer tick sounds (ticks only on my turn)
  useTimerTick(secondsLeftOnTurn ?? 0, !!isMyTurn, sounds.enabled);

  // ── Derived state ──────────────────────────────────────────────────────────

  const mySeat = useMemo(
    () => members.find((m) => m.user_id === userId)?.seat_order ?? null,
    [members, userId]
  );

  const myReady = members.find((m) => m.user_id === userId)?.ready ?? false;

  const canQuickStart =
    room?.status === "waiting" &&
    room.is_quick_play &&
    mySeat !== null &&
    members.length >= 2;

  const lastLine = lines.length ? lines[lines.length - 1] : null;
  const requiredHandoff = lastLine?.handoff_key ?? "";

  const songWordTotal = useMemo(
    () => totalSongWordCount(lines.map((l) => l.content)),
    [lines]
  );

  const songProgressPct = Math.min(
    100,
    Math.round((songWordTotal / TARGET_SONG_WORDS) * 100)
  );
  const nearingEnd = songProgressPct >= 70;
  const almostDone = songProgressPct >= 88;

  const memberMap = useMemo(() => {
    const m = new Map<string, string>();
    members.forEach((mem) => {
      const label = mem.display_name || `P${mem.seat_order + 1}`;
      if (mem.user_id) m.set(mem.user_id, label);
      m.set(`seat:${mem.seat_order}`, label);
    });
    return m;
  }, [members]);

  const inviteUrl = useMemo(() => getRoomInviteUrl(code), [code]);

  // ── Actions ────────────────────────────────────────────────────────────────

  async function onJoin() {
    setJoinBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc("join_room_by_code", {
      p_code: code,
      p_display_name: myDisplayName,
    });
    setJoinBusy(false);
    if (e) {
      setError(e.message);
      return;
    }
    await loadByRoomId(data as string);
  }

  async function onQuickStart() {
    if (!room) return;
    setStartBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc("relay_try_start_room", {
      p_room_id: room.id,
      p_force: true,
    });
    setStartBusy(false);
    if (e) { setError(e.message); return; }
    if (data === true) await loadByRoomId(room.id);
  }

  async function onSetReady(next: boolean) {
    if (!room) return;
    sounds.click();
    setError(null);
    const { error: e } = await supabase.rpc("relay_set_ready", {
      p_room_id: room.id,
      p_ready: next,
    });
    if (e) setError(e.message);
    await loadByRoomId(room.id);
  }

  async function onSubmitLine(e: React.FormEvent) {
    e.preventDefault();
    if (!room || room.status !== "active" || !userId) return;
    const trimmed = lineDraft.trim();
    if (!trimmed) {
      setError("Write a line first.");
      return;
    }
    if (trimmed.length > MAX_CHARS_PER_TURN) {
      setError(`Keep it under ${MAX_CHARS_PER_TURN} characters.`);
      return;
    }

    // Optimistic update for instant feel
    const optimisticLine: LineRow = {
      id: `opt-${Date.now()}`,
      author_id: userId,
      content: trimmed,
      handoff_key: "",
      position: (lines[lines.length - 1]?.position ?? 0) + 1,
      created_at: new Date().toISOString(),
    };
    setLines((prev) => [...prev, optimisticLine]);
    setLineDraft("");

    sounds.submit();
    setSubmitBusy(true);
    setError(null);
    const res = await submitLine(room.id, trimmed);
    setSubmitBusy(false);
    if ("error" in res && res.error) {
      setLines((prev) => prev.filter((l) => l.id !== optimisticLine.id));
      setError(res.error);
      return;
    }
    await loadByRoomId(room.id);
  }

  async function onRunItBack() {
    if (!room) return;
    setNewGameBusy(true);
    setError(null);
    const res = await runItBack(room.id);
    setNewGameBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    if (res.code) router.push(`/room/${res.code}`);
  }

  async function saveName(name: string) {
    if (!room || !userId) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    localStorage.setItem(NAME_KEY, trimmed);
    setMyDisplayName(trimmed);
    const res = await updateDisplayName(room.id, trimmed);
    if ("error" in res && res.error) {
      setError(res.error);
      const refreshed = await loadByRoomId(room.id);
      const me = refreshed?.find((m) => m.user_id === userId);
      const revert = me?.display_name ?? "";
      setMyDisplayName(revert);
      localStorage.setItem(NAME_KEY, revert);
      return;
    }
    await loadByRoomId(room.id);
  }

  async function copySong() {
    const text = lines.map((l, i) => `${i + 1}. ${l.content}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setSongCopied(true);
      setTimeout(() => setSongCopied(false), 2500);
    } catch {
      setError("Could not copy to clipboard.");
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy link.");
    }
  }

  async function copyRoomCodeOnly() {
    try {
      await navigator.clipboard.writeText(room?.code ?? code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      setError("Could not copy room code.");
    }
  }

  async function shareInviteLink() {
    sounds.click();
    const url = inviteUrl;
    try {
      const result = await shareRoomInvite({ code: room?.code ?? code, url });
      if (result === "unsupported") {
        await copyInvite();
        return;
      }
      if (result === "aborted") return;
    } catch {
      setError("Could not open share sheet. Try copy link instead.");
    }
  }

  // ── Loading / error / join screens ─────────────────────────────────────────

  if (!authReady || loading) {
    return (
      <main className="mx-auto max-w-lg px-6 py-16 text-center text-relay-text/60">
        Loading room…
      </main>
    );
  }

  if (needsJoin && preview) {
    return (
      <main className="mx-auto max-w-lg px-6 py-16">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm text-relay-text/50 underline">
            ← Home
          </Link>
          <button
            type="button"
            onClick={() => { sounds.click(); music.toggleMute(); }}
            title={music.muted ? "Unmute music" : "Mute music"}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-relay-text/45 transition hover:bg-relay-text/8 hover:text-relay-text/75"
          >
            <span className="text-sm leading-none">{music.muted ? "🔇" : "🎵"}</span>
            <span>{music.muted ? "Music off" : "Music on"}</span>
          </button>
        </div>
        <h1 className="mt-6 text-2xl font-semibold text-relay-text">
          {preview.is_quick_play ? "Quick Play room" : "Private room"}
        </h1>
        <p className="mt-2 font-mono text-xl tracking-widest text-relay-text">
          {code}
        </p>
        <p className="mt-4 text-sm text-relay-text/70">
          {preview.player_count} / {preview.max_players} players ·{" "}
          {preview.status === "waiting"
            ? "Waiting to start"
            : preview.status === "completed"
              ? "Song finished"
              : "In progress"}
        </p>
        {preview.status === "completed" ? (
          <p className="mt-6 text-relay-text/70">
            This game has ended. The room is locked.
          </p>
        ) : preview.status !== "waiting" ? (
          <p className="mt-6 text-relay-urgency">
            This game already started. You can&apos;t join now.
          </p>
        ) : preview.player_count >= preview.max_players ? (
          <p className="mt-6 text-relay-urgency">This room is full.</p>
        ) : (
          <>
            <div className="mt-5">
              <label className="mb-1.5 block text-xs font-medium text-relay-text/55">
                Your name
              </label>
              <input
                type="text"
                value={myDisplayName}
                onChange={(e) => {
                  setMyDisplayName(e.target.value);
                  localStorage.setItem(NAME_KEY, e.target.value);
                }}
                maxLength={24}
                placeholder="Enter your name"
                className="w-full rounded-xl border border-relay-text/15 bg-relay-card px-4 py-2.5 text-sm text-relay-text outline-none ring-relay-live/40 placeholder:text-relay-text/25 focus:ring-2"
              />
            </div>
            <button
              type="button"
              disabled={joinBusy}
              onClick={() => { sounds.click(); void onJoin(); }}
              className="mt-4 w-full rounded-xl bg-relay-live py-3 font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {joinBusy ? "Joining…" : "Join game →"}
            </button>
            {canWebShare() && (
              <button
                type="button"
                onClick={() => void shareInviteLink()}
                className="mt-2 w-full rounded-xl border border-relay-text/15 py-2.5 text-sm font-medium text-relay-text/75 hover:bg-relay-bg"
              >
                Share invite…
              </button>
            )}
          </>
        )}
        {error && (
          <p className="mt-4 text-center text-sm text-relay-urgency">{error}</p>
        )}
      </main>
    );
  }

  if (!room) {
    return (
      <main className="mx-auto max-w-lg px-6 py-16">
        <Link href="/" className="text-sm underline">
          ← Home
        </Link>
        <p className="mt-8 text-relay-urgency">{error ?? "Room not found."}</p>
      </main>
    );
  }

  // ── Active game: full-screen 3-col layout ─────────────────────────────────

  if (room.status === "active") {
    const timerColor =
      secondsLeftOnTurn === null
        ? "text-relay-text/10"
        : secondsLeftOnTurn <= 2
          ? "text-relay-urgency animate-pulse"
          : secondsLeftOnTurn <= 4
            ? "text-orange-400"
            : "text-relay-text/15";

    const currentTurnMember = members.find(
      (m) => m.seat_order === room.current_turn_seat
    );
    const turnLabel =
      currentTurnMember &&
      (currentTurnMember.user_id
        ? memberMap.get(currentTurnMember.user_id)
        : memberMap.get(`seat:${currentTurnMember.seat_order}`));
    const currentTurnName =
      currentTurnMember?.user_id === userId
        ? "your turn"
        : `${turnLabel ?? "their"} turn`;

    return (
      <div className="flex min-h-screen flex-col bg-relay-bg">
        {/* 3-2-1 countdown overlay */}
        {countdown !== null && (
          <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-relay-bg">
            <div
              className={`font-black leading-none tabular-nums text-relay-live transition-all duration-150 ${
                countdown === 0 ? "text-[7rem] scale-110" : "text-[10rem]"
              }`}
            >
              {countdown === 0 ? "GO" : countdown}
            </div>
            {countdown > 0 && (
              <p className="mt-6 text-sm font-medium uppercase tracking-widest text-relay-text/40">
                Get ready…
              </p>
            )}
          </div>
        )}

        {/* Slim top bar */}
        <nav className="flex flex-shrink-0 items-center justify-between border-b border-relay-text/8 px-4 py-3 lg:px-8">
          <Link
            href="/"
            className="text-sm text-relay-text/35 hover:text-relay-text/70"
          >
            ← Home
          </Link>
          <span className="font-mono text-sm tracking-widest text-relay-text/60">
            {code}
          </span>
          <div className="relative flex items-center gap-3">
            {/* Music picker trigger */}
            <button
              type="button"
              onClick={() => { sounds.click(); setMusicPickerOpen((o) => !o); }}
              title="Music settings"
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-relay-text/45 transition hover:bg-relay-text/8 hover:text-relay-text/75"
            >
              <span className="text-sm leading-none">
                {music.muted ? "🔇" : "🎵"}
              </span>
              <span className="hidden sm:inline">Music</span>
            </button>

            {musicPickerOpen && (
              <MusicPicker
                activeId="jazz-lounge"
                muted={music.muted}
                onSelect={() => setMusicPickerOpen(false)}
                onToggleMute={music.toggleMute}
                onClose={() => setMusicPickerOpen(false)}
              />
            )}

            <span className="flex items-center gap-1.5 rounded-full bg-relay-live/15 px-2.5 py-0.5 text-xs font-semibold text-relay-live">
              <span className="h-1.5 w-1.5 rounded-full bg-relay-live" />
              Live
            </span>
          </div>
        </nav>

        {error && (
          <div className="mx-4 mt-3 rounded-lg bg-relay-urgency/10 px-3 py-2 text-sm text-relay-urgency">
            {error}
          </div>
        )}

        {/* 3-col body */}
        <div className="flex flex-1 overflow-hidden">
          {/* ── Left sidebar: Players (desktop only) ── */}
          <aside className="hidden w-52 flex-shrink-0 flex-col border-r border-relay-text/8 p-5 lg:flex">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-relay-text/35">
              Players
            </p>
            <ul className="space-y-1.5">
              {members.map((m) => {
                const isTurn = room.current_turn_seat === m.seat_order;
                const isMe = m.user_id !== null && m.user_id === userId;
                const label =
                  isMe
                    ? `${m.display_name || "You"} (you)`
                    : m.display_name || `Player ${m.seat_order + 1}`;
                return (
                  <li
                    key={m.user_id ?? `bot-${m.seat_order}`}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all ${
                      isTurn
                        ? `bg-relay-live/10 font-semibold text-relay-text ${turnFlash ? "scale-[1.02]" : ""}`
                        : "text-relay-text/40"
                    }`}
                  >
                    <span
                      className={`h-2 w-2 flex-shrink-0 rounded-full transition-all ${
                        isTurn
                          ? "bg-relay-live shadow-[0_0_8px_rgba(60,179,113,0.5)]"
                          : "bg-relay-text/15"
                      }`}
                    />
                    <span className="flex-1 truncate">{label}</span>
                    {isTurn && (
                      <span className="text-xs font-normal text-relay-live/70">
                        ▸
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>

            {/* Progress */}
            <div className="mt-auto pt-6">
              {(nearingEnd) && (
                <p
                  className={`mb-2 text-xs font-semibold ${almostDone ? "animate-pulse text-relay-urgency" : "text-orange-400"}`}
                >
                  {almostDone ? "🔥 Final lines!" : "⚡ Almost there!"}
                </p>
              )}
              <div className="mb-1.5 flex justify-between text-xs text-relay-text/35">
                <span>Song</span>
                <span>
                  {songWordTotal} / {TARGET_SONG_WORDS}w
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-relay-text/10">
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ${almostDone ? "bg-relay-urgency" : nearingEnd ? "bg-orange-400" : "bg-relay-live"}`}
                  style={{ width: `${songProgressPct}%` }}
                />
              </div>
            </div>
          </aside>

          {/* ── Center: Game focus ── */}
          <main className="flex flex-1 flex-col overflow-y-auto">
            <div className="mx-auto w-full max-w-md px-4 py-8 lg:py-12">
              {/* Big timer */}
              <div className="mb-6 text-center">
                <div
                  className={`text-[7rem] font-black leading-none tabular-nums transition-colors ${timerColor}`}
                >
                  {secondsLeftOnTurn ?? "—"}
                </div>
                <p className="mt-2 text-xs font-medium uppercase tracking-widest text-relay-text/35">
                  {currentTurnName}
                </p>
              </div>

              {/* Input or waiting */}
              {isMyTurn ? (
                <form
                  onSubmit={(e) => void onSubmitLine(e)}
                  className="space-y-3"
                >
                  {lastLine && (
                    <p className="text-xs text-relay-text/40">
                      Continue from:{" "}
                      <span className="font-medium text-relay-text/65">
                        &ldquo;{requiredHandoff}&rdquo;
                      </span>
                    </p>
                  )}
                  <input
                    ref={inputRef}
                    type="text"
                    value={lineDraft}
                    onChange={(e) => setLineDraft(e.target.value)}
                    maxLength={MAX_CHARS_PER_TURN}
                    disabled={submitBusy}
                    className="w-full rounded-xl border border-relay-live/40 bg-relay-card px-4 py-3.5 font-mono text-sm text-relay-text outline-none ring-relay-live/40 placeholder:text-relay-text/25 focus:ring-2 disabled:opacity-60"
                    placeholder={
                      lastLine ? "Write the next line… (Enter to submit)" : "Start the song… (Enter to submit)"
                    }
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-relay-text/30">
                      {lineDraft.length} / {MAX_CHARS_PER_TURN}
                    </span>
                    <button
                      type="submit"
                      disabled={submitBusy || !lineDraft.trim()}
                      className="rounded-xl bg-relay-live px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
                    >
                      {submitBusy ? "…" : "↵"}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="rounded-xl border border-relay-text/8 bg-relay-card/30 py-8 text-center text-sm text-relay-text/35">
                  {mySeat !== null ? "Waiting for their line…" : "Watching…"}
                </div>
              )}

              {/* Mobile: player chips */}
              <div className="mt-6 flex flex-wrap gap-2 lg:hidden">
                {members.map((m) => {
                  const isTurn = room.current_turn_seat === m.seat_order;
                  const label =
                    m.user_id !== null && m.user_id === userId
                      ? "You"
                      : m.display_name || `P${m.seat_order + 1}`;
                  return (
                    <span
                      key={m.user_id ?? `bot-${m.seat_order}`}
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-all ${
                        isTurn
                          ? `bg-relay-live/15 font-medium text-relay-live ${turnFlash ? "scale-105" : ""}`
                          : "bg-relay-text/8 text-relay-text/40"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${isTurn ? "bg-relay-live" : "bg-relay-text/20"}`}
                      />
                      {label}
                    </span>
                  );
                })}
              </div>

              {/* Mobile: progress + nearing-end indicator */}
              <div className="mt-5 lg:hidden">
                {nearingEnd && (
                  <p
                    className={`mb-1.5 text-xs font-semibold ${almostDone ? "animate-pulse text-relay-urgency" : "text-orange-400"}`}
                  >
                    {almostDone ? "🔥 Final lines!" : "⚡ Almost there!"}
                  </p>
                )}
                <div className="mb-1 flex justify-between text-xs text-relay-text/35">
                  <span>Song</span>
                  <span>
                    {songWordTotal} / {TARGET_SONG_WORDS} words
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-relay-text/10">
                  <div
                    className={`h-full rounded-full transition-[width] duration-500 ${almostDone ? "bg-relay-urgency" : nearingEnd ? "bg-orange-400" : "bg-relay-live"}`}
                    style={{ width: `${songProgressPct}%` }}
                  />
                </div>
              </div>

              {/* Mobile: song feed */}
              <div className="mt-8 lg:hidden">
                <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-relay-text/35">
                  The Song
                </p>
                <SongFeed
                  lines={lines}
                  members={members}
                  myUserId={userId}
                  status={room.status}
                  wordTotal={songWordTotal}
                />
              </div>
            </div>
          </main>

          {/* ── Right sidebar: Song feed (desktop only) ── */}
          <aside className="hidden w-72 flex-shrink-0 flex-col overflow-y-auto border-l border-relay-text/8 p-5 lg:flex">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-relay-text/35">
              The Song
            </p>
            <SongFeed
              lines={lines}
              members={members}
              myUserId={userId}
              status={room.status}
              wordTotal={songWordTotal}
              className="flex-1"
            />
          </aside>
        </div>
      </div>
    );
  }

  // ── Lobby (waiting) and Completed: centered single-column ─────────────────

  return (
    <main className="mx-auto min-h-screen max-w-lg px-6 py-10">
      {/* 3-2-1 countdown overlay (visible to all players when game starts) */}
      {countdown !== null && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-relay-bg">
          <div
            className={`font-black leading-none tabular-nums text-relay-live transition-all duration-150 ${
              countdown === 0 ? "text-[7rem] scale-110" : "text-[10rem]"
            }`}
          >
            {countdown === 0 ? "GO" : countdown}
          </div>
          {countdown > 0 && (
            <p className="mt-6 text-sm font-medium uppercase tracking-widest text-relay-text/40">
              Get ready…
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <Link href="/" className="text-sm text-relay-text/50 underline">
          ← Home
        </Link>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { sounds.click(); music.toggleMute(); }}
            title={music.muted ? "Unmute music" : "Mute music"}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-relay-text/45 transition hover:bg-relay-text/8 hover:text-relay-text/75"
          >
            <span className="text-sm leading-none">{music.muted ? "🔇" : "🎵"}</span>
          </button>
          {room.status === "completed" ? (
            <span className="rounded-full bg-relay-text/10 px-3 py-1 text-xs font-medium text-relay-text/70">
              Complete
            </span>
          ) : room.is_quick_play ? (
            <span className="rounded-full bg-relay-live/15 px-3 py-1 text-xs font-medium text-relay-live">
              Quick Play
            </span>
          ) : (
            <span className="rounded-full bg-relay-active px-3 py-1 text-xs font-medium text-relay-text/70">
              Lobby
            </span>
          )}
        </div>
      </div>

      {/* Room header */}
      <header className="mt-6 rounded-2xl bg-relay-card p-5 shadow-sm">
        {room.status === "waiting" ? (
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-widest text-relay-text/45">
              {room.is_quick_play ? "Quick Play" : "Private room"}
            </p>
            <p className="mt-1 text-2xl font-black text-relay-text">
              {members.length} / {room.max_players} players
            </p>
            {!room.is_quick_play && (
              <p className="mt-2 font-mono text-lg tracking-widest text-relay-text/80">
                {room.code}
              </p>
            )}
            {members.length < 2 ? (
              <p className="mt-3 text-sm text-relay-text/50">
                {room.is_quick_play ? (
                  <>
                    Waiting for more players…{" "}
                    <span className="text-relay-text/40">
                      Send friends this page&apos;s link from the address bar.
                    </span>
                  </>
                ) : (
                  <>
                    Waiting for a second player…{" "}
                    <span className="text-relay-text/40">
                      Share the invite below. Others can join from the link anytime.
                    </span>
                  </>
                )}
              </p>
            ) : room.is_quick_play ? null : autoStartSecondsLeft !== null && autoStartSecondsLeft > 0 ? (
              <div className="mt-3">
                <p className="text-xs font-medium uppercase tracking-widest text-relay-text/40">
                  Starting in
                </p>
                <p className="mt-0.5 text-5xl font-black tabular-nums text-relay-live">
                  {autoStartSecondsLeft}
                </p>
              </div>
            ) : (
              <p className="mt-3 text-sm text-relay-live">Starting…</p>
            )}
            {!room.is_quick_play && room.status === "waiting" && (
              <div className="mt-6 space-y-3 border-t border-relay-text/10 pt-5 text-left">
                <div>
                  <p className="mb-1 text-xs font-medium text-relay-text/45">
                    Invite link
                  </p>
                  <input
                    readOnly
                    value={inviteUrl}
                    onFocus={(e) => e.target.select()}
                    className="w-full cursor-text rounded-lg border border-relay-text/10 bg-relay-bg px-3 py-2 font-mono text-xs text-relay-text/90 outline-none ring-relay-live/30 focus:ring-2"
                  />
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <button
                    type="button"
                    onClick={() => { sounds.click(); void copyInvite(); }}
                    className="flex-1 rounded-lg border border-relay-text/10 bg-relay-bg py-2.5 text-sm font-medium text-relay-text/85 hover:bg-relay-active min-[380px]:min-w-[8rem]"
                  >
                    {copied ? "Link copied ✓" : "Copy link"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { sounds.click(); void copyRoomCodeOnly(); }}
                    className="flex-1 rounded-lg border border-relay-text/10 bg-relay-bg py-2.5 text-sm font-medium text-relay-text/85 hover:bg-relay-active min-[380px]:min-w-[8rem]"
                  >
                    {codeCopied ? "Code copied ✓" : "Copy code"}
                  </button>
                  {canWebShare() && (
                    <button
                      type="button"
                      onClick={() => void shareInviteLink()}
                      className="flex-1 rounded-lg bg-relay-live py-2.5 text-sm font-semibold text-white hover:opacity-90 min-[380px]:min-w-[8rem]"
                    >
                      Share…
                    </button>
                  )}
                </div>
                <p className="text-center text-xs leading-relaxed text-relay-text/45">
                  Each person joins from their own browser (or incognito) so everyone
                  gets their own turn.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center">
            <p className="text-xs font-medium uppercase tracking-wide text-relay-text/45">
              Room code
            </p>
            <p className="mt-1 font-mono text-2xl tracking-widest text-relay-text">
              {room.code}
            </p>
          </div>
        )}
      </header>

      {error && (
        <p className="mt-4 rounded-lg bg-relay-urgency/10 px-3 py-2 text-sm text-relay-urgency">
          {error}
        </p>
      )}

      {/* Players list */}
      <section className="mt-6 rounded-2xl bg-relay-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-relay-text">Players</h2>
        <ul className="mt-3 space-y-2">
          {members.map((m) => {
            const isMe = m.user_id !== null && m.user_id === userId;
            const label = m.display_name || `Player ${m.seat_order + 1}`;
            const rowKey = m.user_id ?? `bot-${m.seat_order}`;
            return (
              <li
                key={rowKey}
                className="flex items-center justify-between rounded-lg bg-relay-bg/80 px-3 py-2 text-sm"
              >
                {isMe && room.status === "waiting" && !m.is_bot ? (
                  <input
                    type="text"
                    value={myDisplayName}
                    onChange={(e) => {
                      setMyDisplayName(e.target.value);
                      localStorage.setItem(NAME_KEY, e.target.value);
                    }}
                    onBlur={(e) => void saveName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur();
                      }
                    }}
                    maxLength={24}
                    placeholder="Your name"
                    className="min-w-0 flex-1 rounded bg-transparent font-medium text-relay-text outline-none ring-relay-live/40 placeholder:text-relay-text/30 focus:ring-2 focus:px-2 focus:-mx-2"
                  />
                ) : (
                  <span className={isMe ? "font-medium text-relay-text" : "text-relay-text/70"}>
                    {m.is_bot ? label : isMe ? `${label} (you)` : label}
                  </span>
                )}
                <span className="ml-3 shrink-0 text-xs text-relay-text/40">
                  {room.status === "completed"
                    ? "played"
                    : m.is_bot
                      ? "ready"
                      : m.ready
                        ? "ready"
                        : "tap below"}
                </span>
              </li>
            );
          })}
        </ul>

        {room.status === "waiting" && (
          <div className="mt-5 space-y-3">
            {mySeat !== null && (
              <button
                type="button"
                onClick={() => void onSetReady(!myReady)}
                className={`w-full rounded-xl border py-3 text-sm font-semibold transition ${
                  myReady
                    ? "border-relay-live/40 bg-relay-live/10 text-relay-live"
                    : "border-relay-text/15 bg-relay-bg text-relay-text/70 hover:bg-relay-active"
                }`}
              >
                {myReady ? "✓ You’re ready" : "Tap when you’re ready"}
              </button>
            )}
            {room.is_quick_play && canQuickStart && (
              <button
                type="button"
                disabled={startBusy}
                onClick={() => { sounds.click(); void onQuickStart(); }}
                className="w-full rounded-xl border border-relay-live/30 py-2.5 text-sm font-medium text-relay-live/80 hover:bg-relay-live/5 disabled:opacity-40"
              >
                {startBusy ? "Starting…" : "Start game now →"}
              </button>
            )}
          </div>
        )}
      </section>

      {/* Song (completed) */}
      {room.status === "completed" && (
        <section className="mt-6 rounded-2xl bg-relay-card p-5 shadow-sm">
          <div className="mb-4 rounded-xl border border-relay-live/30 bg-relay-live/10 px-4 py-3 text-center">
            <p className="text-base font-bold text-relay-text">
              Song finished! 🎵
            </p>
            <p className="mt-1 text-xs text-relay-text/60">
              {songWordTotal} words · {lines.length} lines
            </p>
          </div>

          <SongFeed
            lines={lines}
            members={members}
            myUserId={userId}
            status={room.status}
            wordTotal={songWordTotal}
          />

          <button
            type="button"
            onClick={() => { sounds.click(); void copySong(); }}
            className="mt-4 w-full rounded-xl border border-relay-text/15 py-2.5 text-sm font-medium text-relay-text/80 hover:bg-relay-bg"
          >
            {songCopied ? "Copied! ✓" : "Copy song"}
          </button>
        </section>
      )}

      {/* Run it back */}
      {room.status === "completed" && (
        <section className="mt-6 space-y-3 pb-16">
          <button
            type="button"
            disabled={newGameBusy}
            onClick={() => { sounds.click(); void onRunItBack(); }}
            className="w-full rounded-xl bg-relay-live py-3.5 font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {newGameBusy ? "Setting up…" : "Run it back →"}
          </button>
          <p className="text-center text-xs text-relay-text/40">
            Same crew, new song. Everyone is auto-added.
          </p>
        </section>
      )}
    </main>
  );
}
