"use server";

import { createClient } from "@/lib/supabase/server";
import { repairStuckTurnIfSameSeat } from "@/lib/repair-stuck-turn";
import { BOT_TURN_MIN_DWELL_MS, MAX_CHARS_PER_TURN } from "@/lib/relay-constants";
import { isRelayBotDebug, relayBotLog } from "@/lib/relay-bot-debug";

/** OpenAI round-trip cap (stay under TURN_TIMEOUT_SECONDS so SQL fallback can still run). */
const LLM_FETCH_TIMEOUT_MS = 12_000;

/** Skip LLM until the server turn clock is this old (avoids racing the GO countdown). */
const TURN_MIN_AGE_MS = 200;

/**
 * When OpenAI is configured, tries an LLM line for the current bot seat.
 * On miss (no key, not bot turn, API error, race), returns skipped —
 * `relay_room_tick` supplies SQL template lines so play always continues.
 */
export async function trySubmitLlmBotLine(
  roomId: string
): Promise<{ ok?: true; skipped?: true; error?: string }> {
  const dbg = isRelayBotDebug();
  const t0 = Date.now();
  if (dbg) {
    relayBotLog("trySubmitLlmBotLine:start", { roomId });
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    if (dbg) relayBotLog("trySubmitLlmBotLine:early", { reason: "no_OPENAI_API_KEY" });
    return { skipped: true };
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    if (dbg) relayBotLog("trySubmitLlmBotLine:early", { reason: "no_auth_user_server" });
    return { skipped: true };
  }

  const { data: room, error: roomErr } = await supabase
    .from("rooms")
    .select("id, status, current_turn_seat, turn_started_at")
    .eq("id", roomId)
    .single();

  if (roomErr || !room || room.status !== "active") {
    if (dbg) {
      relayBotLog("trySubmitLlmBotLine:early", {
        reason: "room_inactive_or_error",
        roomErr: roomErr?.message,
        status: room?.status,
      });
    }
    return { skipped: true };
  }

  const turnStartMs = new Date(room.turn_started_at as string).getTime();
  if (turnStartMs > Date.now() - TURN_MIN_AGE_MS) {
    if (dbg) relayBotLog("trySubmitLlmBotLine:early", { reason: "turn_too_new_ms", ageMs: Date.now() - turnStartMs });
    return { skipped: true };
  }

  const { data: members, error: memErr } = await supabase
    .from("room_members")
    .select("seat_order, is_bot")
    .eq("room_id", roomId);

  if (memErr || !members?.length) {
    if (dbg) relayBotLog("trySubmitLlmBotLine:early", { reason: "members_error", memErr: memErr?.message });
    return { skipped: true };
  }

  const turnSeat = Number(room.current_turn_seat);
  const current = members.find((m) => Number(m.seat_order) === turnSeat);
  if (!current?.is_bot) {
    if (dbg) {
      relayBotLog("trySubmitLlmBotLine:early", {
        reason: "not_bot_seat",
        current_turn_seat: room.current_turn_seat,
        turnSeatResolved: turnSeat,
        currentSeat: current ?? null,
      });
    }
    return { skipped: true };
  }

  const ageMs = Date.now() - turnStartMs;
  if (ageMs < BOT_TURN_MIN_DWELL_MS) {
    if (dbg) {
      relayBotLog("trySubmitLlmBotLine:early", {
        reason: "bot_turn_dwell",
        ageMs,
        waitMs: BOT_TURN_MIN_DWELL_MS - ageMs,
      });
    }
    return { skipped: true };
  }

  const { data: recentLines, error: lineErr } = await supabase
    .from("lines")
    .select("created_at, content, handoff_key, position")
    .eq("room_id", roomId)
    .order("position", { ascending: false })
    .limit(12);

  if (lineErr) {
    if (dbg) relayBotLog("trySubmitLlmBotLine:early", { reason: "lines_select_error", lineErr: lineErr.message });
    return { skipped: true };
  }

  const lines = recentLines ?? [];
  const turnStarted = new Date(room.turn_started_at as string).getTime();
  if (
    lines.some(
      (l) => new Date(l.created_at as string).getTime() >= turnStarted
    )
  ) {
    // SQL bot line often lands before this server action; if the DB trigger did not
    // advance rooms.current_turn_seat (RLS), we sit in "bot turn + line" forever.
    await repairStuckTurnIfSameSeat(supabase, roomId, turnSeat);
    if (dbg) {
      relayBotLog("trySubmitLlmBotLine:skip_llm_line_exists_this_turn", {
        note: "repair_stuck_turn_if_needed",
        seat: turnSeat,
      });
    }
    return { skipped: true };
  }

  const last = lines[0];
  const handoff = (last?.handoff_key ?? "").trim() || (last?.content ?? "").trim();

  const system = `You are a bot player in Relay, a collaborative song written one line at a time.
Rules:
- Reply with exactly ONE line of lyrics (no quotes, no numbering, no explanation).
- Max ${MAX_CHARS_PER_TURN} characters including spaces.
- Continue naturally from the previous line's tone and imagery.`;

  const userMsg =
    lines.length > 0
      ? `Previous line: "${String(last!.content).slice(0, 200)}". Echo or answer this thread: "${handoff.slice(0, 120)}". Write the next single line.`
      : `The song is empty. Write a strong opening line (max ${MAX_CHARS_PER_TURN} characters).`;

  let raw: string;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), LLM_FETCH_TIMEOUT_MS);
  const openaiStarted = Date.now();
  if (dbg) relayBotLog("openai:fetch_start", { timeoutMs: LLM_FETCH_TIMEOUT_MS });
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.9,
        max_tokens: 80,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (dbg) {
        relayBotLog("openai:fetch_end_not_ok", {
          status: res.status,
          ms: Date.now() - openaiStarted,
          bodyPreview: errBody.slice(0, 200),
        });
      }
      return { skipped: true };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    raw = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (dbg) {
      relayBotLog("openai:fetch_end_ok", {
        ms: Date.now() - openaiStarted,
        rawLen: raw.length,
        rawPreview: raw.slice(0, 120),
      });
    }
  } catch (e) {
    if (dbg) {
      relayBotLog("openai:fetch_error", {
        ms: Date.now() - openaiStarted,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    return { skipped: true };
  } finally {
    clearTimeout(to);
  }

  const oneLine = raw.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
  let line = oneLine.slice(0, MAX_CHARS_PER_TURN).trim();
  if (dbg) {
    relayBotLog("line:after_trim", { oneLineLen: oneLine.length, lineLen: line.length, linePreview: line.slice(0, 80) });
  }
  if (!line) {
    if (dbg) relayBotLog("trySubmitLlmBotLine:early", { reason: "empty_line_after_trim" });
    return { skipped: true };
  }
  // DB trigger rejects lines with no word tokens (punctuation / emoji only).
  if (!/[a-z0-9]/i.test(line.replace(/\s/g, ""))) {
    line = "Soft light on the dashboard glass";
    if (line.length > MAX_CHARS_PER_TURN) line = line.slice(0, MAX_CHARS_PER_TURN);
    if (dbg) relayBotLog("line:fallback_punctuation_replaced", { line });
  }

  if (dbg) relayBotLog("relay_submit_bot_line:rpc_start", { roomId, lineLen: line.length });
  const { data: inserted, error: rpcErr } = await supabase.rpc(
    "relay_submit_bot_line",
    { p_room_id: roomId, p_content: line }
  );

  if (dbg) {
    relayBotLog("relay_submit_bot_line:rpc_end", {
      inserted,
      rpcErr: rpcErr?.message ?? null,
      totalMs: Date.now() - t0,
    });
  }

  if (rpcErr) return { error: rpcErr.message };
  if (inserted !== true) return { skipped: true };

  await repairStuckTurnIfSameSeat(supabase, roomId, turnSeat);

  return { ok: true };
}
