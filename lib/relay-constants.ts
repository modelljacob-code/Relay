/** Hard cap for each turn’s line (characters). */
export const MAX_CHARS_PER_TURN = 50;

/** Total words across all lines — game locks when the song reaches this many. */
export const TARGET_SONG_WORDS = 80;

/** If the current player does not submit a line within this many seconds, the turn passes. */
export const TURN_TIMEOUT_SECONDS = 23;

/**
 * Stored when time runs out and the player typed nothing. Must survive `relay_normalize_raw`
 * (punctuation-only lines are rejected); bracket style matches bot skip fillers like `[silence]`.
 */
export const TURN_EXPIRED_PLACEHOLDER = "[timeout]";

/**
 * Bot seats wait at least this long after `turn_started_at` before SQL or LLM can insert
 * (matches `021_bot_turn_min_dwell.sql`: `extract(epoch ...) < 2.5`).
 */
export const BOT_TURN_MIN_DWELL_MS = 2500;

/** Private waiting lobby: countdown length after everyone taps ready (`relay_room_tick` + UI). */
export const PRIVATE_LOBBY_COUNTDOWN_SECONDS = 10;
