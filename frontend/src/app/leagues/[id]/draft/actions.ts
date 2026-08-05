"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export async function makePick(formData: FormData) {
  const leagueId = String(formData.get("league_id"));
  const playerId = String(formData.get("player_id"));
  const query = String(formData.get("return_query") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.rpc("make_pick", {
    p_league_id: leagueId,
    p_player_id: playerId,
  });

  const base = `/leagues/${leagueId}/draft`;

  if (error) {
    const separator = query ? "&" : "?";
    redirect(`${base}${query}${separator}error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath(base);
  redirect(`${base}${query}`);
}
