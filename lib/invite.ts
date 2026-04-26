/**
 * Invite helpers — full URL, Web Share API, clipboard fallbacks.
 */

export function getRoomInviteUrl(code: string): string {
  const c = code.trim().toUpperCase();
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/room/${c}`;
  }
  return `/room/${c}`;
}

export function canWebShare(): boolean {
  return typeof navigator !== "undefined" && !!navigator.share;
}

export async function shareRoomInvite(opts: {
  code: string;
  url: string;
}): Promise<"shared" | "aborted" | "unsupported"> {
  if (!canWebShare()) return "unsupported";
  try {
    await navigator.share({
      title: "Relay — join my room",
      text: `Join room ${opts.code} on Relay`,
      url: opts.url,
    });
    return "shared";
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError") return "aborted";
    throw e;
  }
}
