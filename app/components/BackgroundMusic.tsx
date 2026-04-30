"use client";

/**
 * Renders a real <audio> element in the DOM.
 * This is the most reliable cross-browser approach for looping background music.
 */

import { useEffect, useRef, useState } from "react";

const TRACK_KEY = "relay_music_track";
const MUTE_KEY  = "relay_music_muted";
const DEFAULT_SRC = "/music/lobby.mp3";
const VOLUME = 0.6;

export function BackgroundMusic() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [blocked, setBlocked] = useState(false);

  // Try to play on mount
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const muted = localStorage.getItem(MUTE_KEY) === "true";
    el.volume = muted ? 0 : VOLUME;

    el.play().catch(() => setBlocked(true));
  }, []);

  // Unlock on user tap
  function handleUnlock() {
    const el = audioRef.current;
    if (!el) return;
    const muted = localStorage.getItem(MUTE_KEY) === "true";
    el.volume = muted ? 0 : VOLUME;
    el.play().then(() => setBlocked(false)).catch(() => {});
  }

  return (
    <>
      <audio ref={audioRef} src={DEFAULT_SRC} loop preload="auto" data-relay-music="1" />

      {blocked && (
        <button
          type="button"
          onClick={handleUnlock}
          className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 flex items-center gap-2 rounded-full border border-relay-text/15 bg-relay-card/90 px-4 py-2 text-sm text-relay-text/60 shadow-lg shadow-black/30 backdrop-blur-md transition hover:text-relay-text/90 animate-pulse"
        >
          <span className="text-base">🎵</span>
          Tap to enable music
        </button>
      )}
    </>
  );
}

/**
 * Hook to control the BackgroundMusic element from anywhere.
 * Reads/writes the same audio element that BackgroundMusic renders.
 */
export function useMusicControl() {
  const [muted, setMutedState] = useState(false);

  useEffect(() => {
    setMutedState(localStorage.getItem(MUTE_KEY) === "true");
  }, []);

  function getAudio(): HTMLAudioElement | null {
    return document.querySelector("audio[data-relay-music]");
  }

  function setMuted(m: boolean) {
    localStorage.setItem(MUTE_KEY, String(m));
    setMutedState(m);
    const el = getAudio();
    if (el) el.volume = m ? 0 : VOLUME;
  }

  function toggleMute() {
    setMuted(!muted);
  }

  function stop() {
    const el = getAudio();
    if (el) { el.pause(); el.currentTime = 0; }
  }

  return { muted, toggleMute, stop };
}

// Keep the old key exports for MusicPicker compatibility
export { TRACK_KEY, MUTE_KEY };
