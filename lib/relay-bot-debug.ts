/**
 * Temporary diagnostics for the bot-turn pipeline.
 * Set NEXT_PUBLIC_RELAY_BOT_DEBUG=1 (and optionally RELAY_BOT_DEBUG=1 on server-only tools).
 */

export function isRelayBotDebug(): boolean {
  if (typeof process === "undefined") return false;
  return (
    process.env.NEXT_PUBLIC_RELAY_BOT_DEBUG === "1" ||
    process.env.RELAY_BOT_DEBUG === "1"
  );
}

export function relayBotLog(...args: unknown[]): void {
  if (!isRelayBotDebug()) return;
  // eslint-disable-next-line no-console -- intentional diagnostic channel
  console.log("[relay-bot]", new Date().toISOString(), ...args);
}
