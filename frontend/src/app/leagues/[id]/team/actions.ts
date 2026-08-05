"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export async function saveLineup(formData: FormData) {
  const leagueId = String(formData.get("league_id"));
  const path = `/leagues/${leagueId}/team`;

  // Send null rather than "" for unset radios — an empty string fails the
  // uuid cast with a much less helpful message than the function's own.
  const captain = formData.get("captain");
  const vice = formData.get("vice");

  const supabase = await createClient();
  const { error } = await supabase.rpc("save_lineup", {
    p_team_id: String(formData.get("team_id")),
    p_gameweek_id: String(formData.get("gameweek_id")),
    p_formation: String(formData.get("formation")),
    p_starters: formData.getAll("starter").map(String),
    p_captain: captain ? String(captain) : null,
    p_vice: vice ? String(vice) : null,
  });

  if (error) {
    redirect(`${path}?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath(path);
  redirect(`${path}?message=Lineup+saved.`);
}
