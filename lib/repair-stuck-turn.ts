import type { SupabaseClient } from "@supabase/supabase-js";
import { isRelayBotDebug, relayBotLog } from "@/lib/relay-bot-debug";

/*
 * If RPC calls here do nothing, run in Supabase SQL Editor (no new migration file needed):
 *   grant execute on function public.relay_advance_turn_for_room(uuid, int) to authenticated;
 *   grant execute on function public.relay_advance_turn_for_room(uuid) to authenticated;
 * (Adjust signature if Postgres lists a different arg type name.)
 */

/**
 * If a line was just played from `playedSeat` but `rooms.current_turn_seat` is still that seat,
 * the after-insert advance likely failed (e.g. RLS on `rooms` before relay_advance uses row_security off).
 * Call the definer advance RPC as a best-effort fix — no-op if the turn already moved.
 */
export async function repairStuckTurnIfSameSeat(
  supabase: SupabaseClient,
  roomId: string,
  playedSeat: number
): Promise<void> {
  const { data: room, error: roomErr } = await supabase
    .from("rooms")
    .select("current_turn_seat, status")
    .eq("id", roomId)
    .single();

  if (roomErr || !room || room.status !== "active") return;
  const played = Number(playedSeat);
  if (!Number.isFinite(played)) return;
  if (Number(room.current_turn_seat) !== played) return;

  let { error } = await supabase.rpc("relay_advance_turn_for_room", {
    p_room_id: roomId,
    p_seat_just_played: played,
  });

  if (error) {
    if (isRelayBotDebug()) {
      relayBotLog("repairStuckTurn:rpc_two_arg_err", {
        roomId,
        played,
        message: error.message,
      });
    }
    ({ error } = await supabase.rpc("relay_advance_turn_for_room", {
      p_room_id: roomId,
    }));
  }
  if (error && isRelayBotDebug()) {
    relayBotLog("repairStuckTurn:rpc_one_arg_err", {
      roomId,
      played,
      message: error.message,
    });
  }
}
