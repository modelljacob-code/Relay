"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  playClick,
  playCountdownBeep,
  playGameEnd,
  playSkip,
  playSubmit,
  playTurnStart,
  playUrgentTick,
} from "./sounds";

const STORAGE_KEY = "relay_sfx_enabled";

function readEnabled(): boolean {
  if (typeof window === "undefined") return true;
  const v = localStorage.getItem(STORAGE_KEY);
  return v === null ? true : v === "true";
}

/** Controls in-game sound effects (beeps, ticks, chimes). */
export function useSounds() {
  const [enabled, setEnabledState] = useState(true);

  useEffect(() => {
    setEnabledState(readEnabled());
  }, []);

  const toggle = useCallback(() => {
    setEnabledState((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  const guard = useCallback(
    <T extends unknown[]>(fn: (...args: T) => void) =>
      (...args: T) => {
        if (enabled) fn(...args);
      },
    [enabled]
  );

  return {
    enabled,
    toggle,
    click: guard(playClick),
    urgentTick: guard(playUrgentTick),
    turnStart: guard(playTurnStart),
    submit: guard(playSubmit),
    skip: guard(playSkip),
    countdownBeep: guard(playCountdownBeep),
    gameEnd: guard(playGameEnd),
  };
}

/**
 * Plays countdown sounds only at 3, 2, 1 seconds — and only on your turn.
 */
export function useTimerTick(
  secondsLeft: number,
  isMyTurn: boolean,
  enabled: boolean
) {
  const prevRef = useRef(secondsLeft);

  useEffect(() => {
    if (!isMyTurn || !enabled) return;
    if (secondsLeft === prevRef.current) return;
    prevRef.current = secondsLeft;
    if (secondsLeft === 3 || secondsLeft === 2 || secondsLeft === 1) {
      playUrgentTick();
    }
  }, [secondsLeft, isMyTurn, enabled]);
}
