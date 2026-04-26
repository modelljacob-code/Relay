/** Hard cap for each turn’s line (characters). */
export const MAX_CHARS_PER_TURN = 50;

/** Total words across all lines — game locks when the song reaches this many. */
export const TARGET_SONG_WORDS = 80;

/** If the current player does not submit a line within this many seconds, the turn passes. */
export const TURN_TIMEOUT_SECONDS = 15;

/**
 * Bot seats wait at least this long after `turn_started_at` before SQL or LLM can insert
 * (matches `021_bot_turn_min_dwell.sql`: `extract(epoch ...) < 2.5`).
 */
export const BOT_TURN_MIN_DWELL_MS = 2500;
