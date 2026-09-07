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

  const update: Record<string, unknown> = {
    name: String(formData.get("name") ?? "").trim(),
    // Unchecked checkboxes aren't submitted at all.
    carry_forward_lineups: formData.get("carry_forward_lineups") === "on",
    email_reminders: formData.get("email_reminders") === "on",
    reminder_hours_before: Number(formData.get("reminder_hours_before")) || 4,
    playoff_teams: Number(formData.get("playoff_teams")) || 0,
  };

  // Squad composition is locked once a league leaves setup, and the form marks
  // those inputs disabled. A disabled input is not submitted, so reading them
  // unconditionally produced Number(null) — zero — and every save on an active
  // league failed on the max_teams check. Absent means "don't touch", which is
  // what disabling them was trying to say in the first place.
  for (const field of ["max_teams", "roster_size", "min_gk", "min_def", "min_mid", "min_fwd"]) {
    const raw = formData.get(field);
    if (raw === null || raw === "") continue;

    const value = Number(raw);
    if (Number.isNaN(value)) continue;

    update[field] = value;
  }

  // RLS restricts this to the commissioner; the form is only rendered for them.
  const { error } = await supabase.from("leagues").update(update).eq("id", leagueId);

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

  // The draft board ranks on draft_values, a cached table computed under these
  // rules. Without this it keeps showing the old ranking until the nightly job
  // runs — and it looks right, which is worse: a commissioner changes the
  // scoring, sees the same numbers, and concludes the data is broken.
  const { error: rankError } = await supabase.rpc("recompute_draft_values", {
    p_league_id: leagueId,
  });

  revalidatePath(`/leagues/${leagueId}`, "layout");
  redirect(
    back(
      leagueId,
      rankError
        ? `?message=${encodeURIComponent(
            "Scoring updated, but the draft rankings could not be rebuilt: " +
              rankError.message,
          )}`
        : "?message=Scoring+updated+and+draft+rankings+rebuilt.+Re-run+scoring+to+apply+it+to+past+gameweeks.",
    ),
  );
}
