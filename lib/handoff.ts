/** Client-side mirror of DB handoff rules (v3): normalize, last 4 words, <4 = full line. */

export function relayNormalizeRaw(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim();
}

export function relayWordArray(text: string): string[] {
  const norm = relayNormalizeRaw(text);
  if (!norm) return [];
  return norm.split(/\s+/).filter(Boolean);
}

export function handoffPhraseFromContent(content: string): string {
  const words = relayWordArray(content);
  if (words.length === 0) return "";
  if (words.length < 4) return words.join(" ");
  return words.slice(-4).join(" ");
}

/** Word count for one line (same token rules as the database). */
export function wordCountInLine(text: string): number {
  return relayWordArray(text).length;
}

/** Returns true if the line is an auto-generated skip placeholder (e.g. "[silence]"). */
export function isPlaceholderLine(content: string): boolean {
  return content.startsWith("[") && content.endsWith("]");
}

/** Total words in the song so far — skips placeholder/skip lines. */
export function totalSongWordCount(lineContents: string[]): number {
  return lineContents.reduce(
    (sum, c) => sum + (isPlaceholderLine(c) ? 0 : wordCountInLine(c)),
    0
  );
}

export function lineSatisfiesHandoff(newContent: string, required: string): boolean {
  if (!required) return true;
  const req = relayWordArray(required);
  const neu = relayWordArray(newContent);
  if (req.length === 0) return true;
  if (neu.length < req.length) return false;
  for (let i = 0; i < req.length; i++) {
    if (neu[i] !== req[i]) return false;
  }
  return true;
}
