"use server";

import { createClient } from "@/lib/supabase/server";
import { MAX_CHARS_PER_TURN } from "@/lib/relay-constants";
import { generateRoomCode } from "@/lib/room-code";
import { revalidatePath } from "next/cache";

export async function createPrivateRoom(
  displayName: string = ""
): Promise<{ code?: string; error?: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Could not authenticate. Please refresh and try again." };

  const name = displayName.trim().slice(0, 24);

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateRoomCode();
    const { data: room, error: roomErr } = await supabase
      .from("rooms")
      .insert({ host_id: user.id, code })
      .select("id, code")
      .single();

    if (roomErr) {
      if (roomErr.code === "23505") continue;
      return { error: roomErr.message };
    }

    const { error: memErr } = await supabase.from("room_members").insert({
      room_id: room.id,
      user_id: user.id,
      seat_order: 0,
      display_name: name,
    });
    if (memErr) return { error: memErr.message };

    revalidatePath("/");
    return { code: room.code };
  }

  return { error: "Could not generate a unique room code." };
}

export async function quickPlay(
  displayName: string = ""
): Promise<{ code?: string; error?: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Could not authenticate. Please refresh and try again." };

  const { data: code, error } = await supabase.rpc("quick_play", {
    p_display_name: displayName.trim().slice(0, 24),
  });
  if (error) return { error: error.message };
  return { code: code as string };
}

/** Force-start a waiting room (any member). Prefer lobby countdown + relay_room_tick in UI. */
export async function startGame(roomId: string): Promise<{ ok?: true; error?: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: ok, error } = await supabase.rpc("relay_try_start_room", {
    p_room_id: roomId,
    p_force: true,
  });
  if (error) return { error: error.message };
  if (ok !== true) return { error: "Could not start yet (need at least 2 players)." };

  revalidatePath("/");
  return { ok: true };
}

export async function submitLine(
  roomId: string,
  content: string
): Promise<{ ok?: true; error?: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const trimmed = content.trim();
  if (!trimmed) return { error: "Line cannot be empty." };
  if (trimmed.length > MAX_CHARS_PER_TURN) {
    return { error: `Line must be ${MAX_CHARS_PER_TURN} characters or less.` };
  }

  const { error } = await supabase.from("lines").insert({
    room_id: roomId,
    author_id: user.id,
    content: trimmed,
  });
  if (error) return { error: error.message };

  revalidatePath("/");
  return { ok: true };
}

export async function updateDisplayName(
  roomId: string,
  displayName: string
): Promise<{ ok?: true; error?: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const name = displayName.trim().slice(0, 24);
  const { error } = await supabase
    .from("room_members")
    .update({ display_name: name })
    .eq("room_id", roomId)
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/");
  return { ok: true };
}

export async function runItBack(
  oldRoomId: string
): Promise<{ code?: string; error?: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data, error } = await supabase.rpc("run_it_back", {
    p_old_room_id: oldRoomId,
  });
  if (error) return { error: error.message };
  return { code: data as string };
}
