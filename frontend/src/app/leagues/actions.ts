"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export async function createLeague(formData: FormData) {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("create_league", {
    p_name: String(formData.get("league_name") ?? "").trim(),
    p_team_name: String(formData.get("team_name") ?? "").trim(),
    p_max_teams: Number(formData.get("max_teams") ?? 10),
  });

  if (error) {
    redirect(`/leagues?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/leagues");
  redirect(`/leagues/${data as string}`);
}

export async function joinLeague(formData: FormData) {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("join_league", {
    p_join_code: String(formData.get("join_code") ?? "").trim(),
    p_team_name: String(formData.get("team_name") ?? "").trim(),
  });

  if (error) {
    redirect(`/leagues?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/leagues");
  redirect(`/leagues/${data as string}`);
}
