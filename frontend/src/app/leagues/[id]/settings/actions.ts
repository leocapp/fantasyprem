"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

function back(leagueId: string, query: string) {
  return `/leagues/${leagueId}/settings${query}`;
}

export async function updateLeagueSettings(formData: FormData) {
  const leagueId = String(formData.get("league_id"));
  const supabase = await createClient();

  // RLS restricts this to the commissioner; the form is only rendered for them.
  const { error } = await supabase
    .from("leagues")
    .update({
      name: String(formData.get("name") ?? "").trim(),
      max_teams: Number(formData.get("max_teams")),
      roster_size: Number(formData.get("roster_size")),
      min_gk: Number(formData.get("min_gk")),
      min_def: Number(formData.get("min_def")),
      min_mid: Number(formData.get("min_mid")),
      min_fwd: Number(formData.get("min_fwd")),
      // Unchecked checkboxes aren't submitted at all.
      carry_forward_lineups: formData.get("carry_forward_lineups") === "on",
    })
    .eq("id", leagueId);

  if (error) {
    const message = error.message.includes("roster_size_fits_minimums")
      ? "Roster size must be at least the sum of the position minimums."
      : error.message;
    redirect(back(leagueId, `?error=${encodeURIComponent(message)}`));
  }

  revalidatePath(`/leagues/${leagueId}`, "layout");
  redirect(back(leagueId, "?message=Settings+saved."));
}

export async function setCommissioner(formData: FormData) {
  const leagueId = String(formData.get("league_id"));
  const supabase = await createClient();

  const { error } = await supabase.rpc("set_commissioner", {
    p_league_id: leagueId,
    p_profile_id: String(formData.get("profile_id")),
    p_grant: formData.get("grant") === "true",
  });

  if (error) {
    redirect(back(leagueId, `?error=${encodeURIComponent(error.message)}`));
  }

  revalidatePath(`/leagues/${leagueId}`, "layout");
  redirect(back(leagueId, "?message=Commissioners+updated."));
}

export async function removeTeam(formData: FormData) {
  const leagueId = String(formData.get("league_id"));
  const supabase = await createClient();

  const { error } = await supabase.rpc("remove_team", {
    p_team_id: String(formData.get("team_id")),
  });

  if (error) {
    redirect(back(leagueId, `?error=${encodeURIComponent(error.message)}`));
  }

  revalidatePath(`/leagues/${leagueId}`, "layout");
  redirect(back(leagueId, "?message=Manager+removed."));
}

export async function resetLeague(formData: FormData) {
  const leagueId = String(formData.get("league_id"));
  const supabase = await createClient();

  const { error } = await supabase.rpc("reset_league", {
    p_league_id: leagueId,
    p_confirm_name: String(formData.get("confirm_name") ?? ""),
  });

  if (error) {
    redirect(back(leagueId, `?error=${encodeURIComponent(error.message)}`));
  }

  revalidatePath(`/leagues/${leagueId}`, "layout");
  redirect(back(leagueId, "?message=League+reset+to+setup."));
}

export async function updateScoringRules(formData: FormData) {
  const leagueId = String(formData.get("league_id"));
  const supabase = await createClient();

  // Each rule arrives as points-<rule id>. Only changed values are written.
  const updates: { id: string; points: number }[] = [];

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("points-")) continue;
    const points = Number(value);
    if (Number.isNaN(points)) continue;
    updates.push({ id: key.slice("points-".length), points });
  }

  for (const update of updates) {
    const { error } = await supabase
      .from("scoring_rules")
      .update({ points: update.points })
      .eq("id", update.id)
      .eq("league_id", leagueId);

    if (error) {
      redirect(back(leagueId, `?error=${encodeURIComponent(error.message)}`));
    }
  }

  revalidatePath(`/leagues/${leagueId}`, "layout");
  redirect(
    back(
      leagueId,
      "?message=Scoring+updated.+Re-run+scoring+to+apply+it+to+past+gameweeks.",
    ),
  );
}
