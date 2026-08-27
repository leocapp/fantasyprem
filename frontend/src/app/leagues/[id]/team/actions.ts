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

export async function setInjuryReserve(formData: FormData) {
  const leagueId = String(formData.get("league_id"));
  const path = `/leagues/${leagueId}/team`;
  const reserved = formData.get("reserved") === "1";

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_injury_reserve", {
    p_league_id: leagueId,
    p_player_id: String(formData.get("player_id")),
    p_reserved: reserved,
  });

  if (error) {
    redirect(`${path}?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath(path);
  redirect(
    `${path}?message=${encodeURIComponent(
      reserved
        ? "Moved to injury reserve. Their spot is free until they're fit."
        : "Back from injury reserve.",
    )}`,
  );
}

export async function dropPlayer(formData: FormData) {
  const leagueId = String(formData.get("league_id"));
  const path = `/leagues/${leagueId}/team`;

  const supabase = await createClient();
  const { error } = await supabase.rpc("drop_player", {
    p_league_id: leagueId,
    p_player_id: String(formData.get("player_id")),
  });

  if (error) {
    redirect(`${path}?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath(path);
  redirect(`${path}?message=Player+dropped.+Your+roster+is+legal+again.`);
}
