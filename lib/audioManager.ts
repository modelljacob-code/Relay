"use client";

/**
 * AudioManager — background music using native HTML5 Audio.
 * Simple, reliable, no dynamic imports.
 *
 * Drop tracks in /public/music/:
 *   lobby.mp3  — home + waiting room
 *   game.mp3   — active gameplay (falls back to lobby.mp3)
 *   end.mp3    — song complete screen (falls back to lobby.mp3)
 */

// ── Music catalogue ────────────────────────────────────────────────────────────

export type MusicOption = {
  id: string;
  label: string;
  emoji: string;
  description: string;
  url: string;
};

/**
 * Add tracks by dropping MP3s into /public/music/ and adding entries here.
 * Only local files are used — external streaming URLs block hotlinking.
 */
export const MUSIC_OPTIONS: MusicOption[] = [
  {
    id: "jazz-lounge",
    label: "Jazz Lounge",
    emoji: "🎷",
    description: "Smooth & warm",
    url: "/music/lobby.mp3",
  },
  // Add more tracks by dropping files in /public/music/ and adding entries:
  // { id: "lofi", label: "Lo-fi Chill", emoji: "🎹", description: "...", url: "/music/lofi.mp3" },
  // { id: "hype", label: "Hype",        emoji: "⚡", description: "...", url: "/music/hype.mp3"  },
];

export const NO_MUSIC_ID = "none";

// ── Constants ──────────────────────────────────────────────────────────────────

const TARGET_VOLUME = 0.25;
const MUTE_KEY = "relay_music_muted";
const TRACK_KEY = "relay_music_track";

// ── Fade helper (works on any Audio element independently) ────────────────────

function fadeTo(
  el: HTMLAudioElement,
  to: number,
  durationMs: number,
  onDone?: () => void,
  from?: number
): ReturnType<typeof setInterval> {
  if (from !== undefined) el.volume = from;
  const start = el.volume;
  const steps = Math.max(1, Math.round(durationMs / 50));
  const delta = (to - start) / steps;
  let step = 0;
  const timer = setInterval(() => {
    step++;
    el.volume = Math.min(1, Math.max(0, start + delta * step));
    if (step >= steps) {
      clearInterval(timer);
      onDone?.();
    }
  }, 50);
  return timer;
}

// ── Manager ────────────────────────────────────────────────────────────────────

type Listener = () => void;

class AudioManager {
  private audio: HTMLAudioElement | null = null;
  private activeId: string | null = null;
  private muted: boolean;
  private fadeTimer: ReturnType<typeof setInterval> | null = null;

  needsGesture = false;
  private gestureListeners: Listener[] = [];

  constructor() {
    this.muted =
      typeof window !== "undefined"
        ? localStorage.getItem(MUTE_KEY) === "true"
        : false;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  playById(id: string) {
    if (id === NO_MUSIC_ID) { this.stop(); return; }
    if (this.activeId === id && this.audio && !this.audio.paused) return;

    const option = MUSIC_OPTIONS.find((o) => o.id === id);
    if (!option) return;

    this._swap(option.url, id);
  }

  stop() {
    this._clearFade();
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    this.activeId = null;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    localStorage.setItem(MUTE_KEY, String(muted));
    if (this.audio) {
      this.audio.volume = muted ? 0 : TARGET_VOLUME;
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  isMuted() { return this.muted; }
  isPlaying() { return this.audio ? !this.audio.paused : false; }
  getActiveId() { return this.activeId; }

  getSavedTrackId(): string {
    return (
      (typeof window !== "undefined" && localStorage.getItem(TRACK_KEY)) ||
      "jazz-lounge"
    );
  }

  saveTrackId(id: string) {
    localStorage.setItem(TRACK_KEY, id);
  }

  onNeedsGesture(cb: Listener): () => void {
    this.gestureListeners.push(cb);
    return () => {
      this.gestureListeners = this.gestureListeners.filter((l) => l !== cb);
    };
  }

  /** Resume after user taps the "enable music" prompt. */
  unlock() {
    this.needsGesture = false;
    const id = this.activeId;
    // Always create a fresh element on unlock — most reliable after a block
    if (id) {
      this.activeId = null;
      if (this.audio) { this.audio.pause(); this.audio.src = ""; this.audio = null; }
      this.playById(id);
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _swap(url: string, id: string) {
    // Stop current immediately
    if (this.audio) {
      this._clearFade();
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }

    this.activeId = id;
    const el = new Audio(url);
    el.loop = true;
    el.volume = this.muted ? 0 : TARGET_VOLUME;
    this.audio = el;

    el.play().catch(() => {
      this.needsGesture = true;
      this.gestureListeners.forEach((cb) => cb());
    });
  }

  private _fade(
    el: HTMLAudioElement,
    from: number,
    to: number,
    durationMs: number,
    onDone?: () => void
  ) {
    this._clearFade();
    this.fadeTimer = fadeTo(el, to, durationMs, onDone, from);
  }

  private _clearFade() {
    if (this.fadeTimer !== null) {
      clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
  }
}

export const audioManager: AudioManager | null =
  typeof window !== "undefined" ? new AudioManager() : null;
