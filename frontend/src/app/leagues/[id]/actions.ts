"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export async function setDraftOrder(formData: FormData) {
  const leagueId = String(formData.get("league_id"));
  // Team ids arrive in the order the commissioner arranged them.
  const teamIds = formData.getAll("team_id").map(String);

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_draft_order", {
    p_league_id: leagueId,
    p_team_ids: teamIds,
  });

  if (error) {
    redirect(`/leagues/${leagueId}?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath(`/leagues/${leagueId}`);
  redirect(`/leagues/${leagueId}?message=Draft+order+saved.`);
}

export async function startDraft(formData: FormData) {
  const leagueId = String(formData.get("league_id"));

  const supabase = await createClient();
  const { error } = await supabase.rpc("start_draft", { p_league_id: leagueId });

  if (error) {
    redirect(`/leagues/${leagueId}?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath(`/leagues/${leagueId}`, "layout");
  redirect(`/leagues/${leagueId}/draft`);
}
