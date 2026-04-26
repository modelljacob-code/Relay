"use client";

/**
 * Sound effects for Relay — synthesised with Web Audio API.
 * Tuned to complement a warm jazz/lounge background track.
 * No audio files needed. Background music lives in audioManager.ts.
 */

// ── Web Audio context (lazy, shared) ──────────────────────────────────────────

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// ── Primitive helpers ─────────────────────────────────────────────────────────

function tone(
  freq: number,
  duration: number,
  volume = 0.12,
  type: OscillatorType = "sine",
  startTime?: number,
  attack = 0.015,
  release?: number
) {
  const c = getCtx();
  if (!c) return;
  const t = startTime ?? c.currentTime;
  const rel = release ?? duration;

  const osc = c.createOscillator();
  const gain = c.createGain();
  // Gentle low-pass so nothing sounds harsh
  const lpf = c.createBiquadFilter();
  lpf.type = "lowpass";
  lpf.frequency.value = 2800;

  osc.connect(gain);
  gain.connect(lpf);
  lpf.connect(c.destination);

  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + rel);

  osc.start(t);
  osc.stop(t + rel + 0.05);
}

// ── Sound effects ─────────────────────────────────────────────────────────────

/**
 * Urgent tick at 3-2-1 — soft woodblock-style tap.
 * Warm thud, not a harsh beep.
 */
export function playUrgentTick() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  // Short percussive thud — low sine + fast decay
  tone(200, 0.12, 0.18, "sine", t, 0.005, 0.1);
  // Subtle high click on top for definition
  tone(1200, 0.05, 0.05, "sine", t, 0.003, 0.04);
}

/**
 * "Your turn" — soft two-note vibraphone-style chime (major third: E4 → G#4).
 */
export function playTurnStart() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  tone(329.63, 0.5, 0.15, "sine", t, 0.01, 0.45);       // E4
  tone(415.30, 0.6, 0.13, "sine", t + 0.18, 0.01, 0.5); // G#4
}

/**
 * Submit — warm upward ping (A4 → E5), like a soft piano key.
 */
export function playSubmit() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  tone(440,  0.4, 0.14, "sine", t,        0.008, 0.35); // A4
  tone(659,  0.35, 0.10, "sine", t + 0.1, 0.008, 0.3);  // E5
}

/**
 * Skip / timeout — gentle descending minor third, like a soft "nope" tap.
 */
export function playSkip() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  tone(311.13, 0.3, 0.12, "sine", t,        0.01, 0.28); // Eb4
  tone(246.94, 0.35, 0.10, "sine", t + 0.15, 0.01, 0.3); // B3
}

/**
 * 3-2-1 countdown beeps — soft rim-tap at 3/2/1, warm fanfare at GO.
 */
export function playCountdownBeep(n: number) {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;

  if (n === 0) {
    // "GO!" — warm jazz-style ascending triad (C-E-G)
    tone(261.63, 0.5, 0.18, "sine", t,        0.01, 0.45); // C4
    tone(329.63, 0.5, 0.15, "sine", t + 0.12, 0.01, 0.45); // E4
    tone(392.00, 0.6, 0.18, "sine", t + 0.24, 0.01, 0.55); // G4
    tone(523.25, 0.5, 0.14, "sine", t + 0.38, 0.01, 0.5);  // C5
  } else {
    // Soft woodblock tap
    tone(220, 0.1, 0.14, "sine", t, 0.005, 0.1);
    tone(880, 0.05, 0.04, "sine", t, 0.003, 0.04);
  }
}

/**
 * Button click — soft, neutral tap.
 */
export function playClick() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  tone(600, 0.07, 0.08, "sine", t, 0.003, 0.06);
}

/**
 * Song complete — warm jazz chord bloom (Cmaj7 arpeggio).
 */
export function playGameEnd() {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  // C - E - G - B - high C  (Cmaj7)
  tone(261.63, 0.9, 0.20, "sine", t,        0.02, 0.85); // C4
  tone(329.63, 0.9, 0.17, "sine", t + 0.12, 0.02, 0.85); // E4
  tone(392.00, 0.9, 0.15, "sine", t + 0.24, 0.02, 0.85); // G4
  tone(493.88, 0.9, 0.13, "sine", t + 0.36, 0.02, 0.85); // B4
  tone(523.25, 1.1, 0.18, "sine", t + 0.52, 0.02, 1.0);  // C5
}
