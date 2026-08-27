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
  const addId = String(formData.get("add_player_id"));

  const supabase = await createClient();

  // No drop chosen means "sign him into a spare slot", which only exists if
  // somebody is on injury reserve. Rather than refusing here on a guess, ask
  // the database: claim_player counts the active roster against the position
  // quota and comes back with a message that says which position is full.
  const { error } = dropId
    ? await supabase.rpc("swap_player", {
        p_league_id: leagueId,
        p_drop_player_id: dropId,
        p_add_player_id: addId,
      })
    : await supabase.rpc("claim_player", {
        p_league_id: leagueId,
        p_add_player_id: addId,
      });

  if (error) {
    redirect(`${base}${query}${separator}error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath(base);
  revalidatePath(`/leagues/${leagueId}/team`);
  redirect(`${base}${query}${separator}message=Squad+updated.`);
}
