"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export async function swapPlayer(formData: FormData) {
  const leagueId = String(formData.get("league_id"));
  const query = String(formData.get("return_query") ?? "");
  const base = `/leagues/${leagueId}/free-agents`;
  const separator = query ? "&" : "?";

  const dropId = String(formData.get("drop_player_id") ?? "");

  if (!dropId) {
    redirect(`${base}${query}${separator}error=Choose+a+player+to+drop.`);
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("swap_player", {
    p_league_id: leagueId,
    p_drop_player_id: dropId,
    p_add_player_id: String(formData.get("add_player_id")),
  });

  if (error) {
    redirect(`${base}${query}${separator}error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath(base);
  revalidatePath(`/leagues/${leagueId}/team`);
  redirect(`${base}${query}${separator}message=Squad+updated.`);
}
