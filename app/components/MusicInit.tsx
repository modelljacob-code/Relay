"use client";

/**
 * Mounted once in the root layout.
 *
 * Tries to autoplay music immediately. If the browser blocks it,
 * a small floating prompt appears so the user can tap to enable.
 * Once unlocked, the prompt disappears forever.
 */

import { useMusic } from "@/lib/useMusic";

export function MusicInit() {
  const { needsGesture, unlock } = useMusic();

  if (!needsGesture) return null;

  return (
    <button
      type="button"
      onClick={unlock}
      className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 flex items-center gap-2 rounded-full border border-relay-text/10 bg-relay-card px-4 py-2 text-sm text-relay-text/60 shadow-lg backdrop-blur transition hover:text-relay-text/90 animate-pulse"
    >
      <span className="text-base">🎵</span>
      Tap to enable music
    </button>
  );
}
