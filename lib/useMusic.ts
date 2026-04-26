"use client";

import { useCallback, useEffect, useState } from "react";
import { audioManager, MUSIC_OPTIONS, NO_MUSIC_ID } from "./audioManager";

export function useMusic() {
  const [muted, setMuted] = useState(false);
  const [activeId, setActiveId] = useState<string>(MUSIC_OPTIONS[0].id);
  const [needsGesture, setNeedsGesture] = useState(false);

  useEffect(() => {
    if (!audioManager) return;
    setMuted(audioManager.isMuted());
    setActiveId(audioManager.getSavedTrackId());
    // Subscribe to autoplay-blocked events
    const unsub = audioManager.onNeedsGesture(() => setNeedsGesture(true));
    return unsub;
  }, []);

  /** Start playing a track by id. Saves preference. */
  const selectTrack = useCallback((id: string) => {
    if (!audioManager) return;
    audioManager.saveTrackId(id);
    audioManager.playById(id);
    setActiveId(id);
  }, []);

  /** Start the player's saved track (call when entering gameplay). */
  const playsaved = useCallback(() => {
    if (!audioManager) return;
    const saved = audioManager.getSavedTrackId();
    if (saved !== NO_MUSIC_ID) {
      audioManager.playById(saved);
      setActiveId(saved);
    }
  }, []);

  const stop = useCallback(() => {
    audioManager?.stop();
  }, []);

  const unlock = useCallback(() => {
    audioManager?.unlock();
    setNeedsGesture(false);
  }, []);

  const toggleMute = useCallback(() => {
    if (!audioManager) return;
    const nowMuted = audioManager.toggleMute();
    setMuted(nowMuted);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "relay_music_muted",
        newValue: String(nowMuted),
      })
    );
  }, []);

  // Sync mute across tabs
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === "relay_music_muted") {
        const m = e.newValue === "true";
        audioManager?.setMuted(m);
        setMuted(m);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { muted, activeId, needsGesture, selectTrack, playsaved, stop, toggleMute, unlock };
}
