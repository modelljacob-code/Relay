const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Words that appear next to a code but are not the code (e.g. "AYK8PK join"). */
const ROOM_CODE_NOISE = new Set([
  "JOIN",
  "GAME",
  "ROOM",
  "HTTP",
  "HTTPS",
  "LOCALHOST",
  "WWW",
]);

/**
 * Extract a room code from a bare code, a path, or a full invite URL
 * (e.g. `http://localhost:3000/room/AYK8PK` pasted from the browser).
 * Also handles `AYK8PK join`, `join AYK8PK`, etc.
 */
export function parseRoomCodeFromInput(raw: string): string {
  const trimmed = raw.trim();
  const fromPath = trimmed.match(/\/room\/([A-Za-z0-9]+)/i);
  if (fromPath?.[1]) {
    return fromPath[1].toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  const upper = trimmed.toUpperCase();
  const tokens = upper.split(/[^A-Z0-9]+/).filter((t) => t.length >= 4 && t.length <= 12);
  for (const t of tokens) {
    if (!ROOM_CODE_NOISE.has(t)) return t;
  }
  const first = (trimmed.split(/\s+/)[0] ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return first;
}

export function generateRoomCode(length = 6): string {
  let s = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    s += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return s;
}
