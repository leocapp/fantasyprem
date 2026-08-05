"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

function target(leagueId: string, extra = "") {
  return `/leagues/${leagueId}/trades${extra}`;
}

export async function proposeTrade(formData: FormData) {
  const leagueId = String(formData.get("league_id"));
  const withTeam = String(formData.get("receiver_team_id"));
  const back = `?with=${withTeam}`;

  const offer = formData.getAll("offer").map(String);
  const request = formData.getAll("request").map(String);

  if (offer.length === 0 || request.length === 0) {
    redirect(target(leagueId, `${back}&error=Pick+players+on+both+sides.`));
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("propose_trade", {
    p_league_id: leagueId,
    p_receiver_team_id: withTeam,
    p_offer_ids: offer,
    p_request_ids: request,
    p_note: String(formData.get("note") ?? ""),
  });

  if (error) {
    redirect(target(leagueId, `${back}&error=${encodeURIComponent(error.message)}`));
  }

  revalidatePath(target(leagueId));
  redirect(target(leagueId, "?message=Trade+proposed."));
}

export async function respondToTrade(formData: FormData) {
  const leagueId = String(formData.get("league_id"));

  const supabase = await createClient();
  const { error } = await supabase.rpc("respond_to_trade", {
    p_trade_id: String(formData.get("trade_id")),
    p_accept: formData.get("accept") === "true",
  });

  if (error) {
    redirect(target(leagueId, `?error=${encodeURIComponent(error.message)}`));
  }

  revalidatePath(target(leagueId));
  redirect(target(leagueId, "?message=Response+recorded."));
}

export async function cancelTrade(formData: FormData) {
  const leagueId = String(formData.get("league_id"));

  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_trade", {
    p_trade_id: String(formData.get("trade_id")),
  });

  if (error) {
    redirect(target(leagueId, `?error=${encodeURIComponent(error.message)}`));
  }

  revalidatePath(target(leagueId));
  redirect(target(leagueId, "?message=Proposal+withdrawn."));
}

export async function vetoTrade(formData: FormData) {
  const leagueId = String(formData.get("league_id"));

  const supabase = await createClient();
  const { error } = await supabase.rpc("veto_trade", {
    p_trade_id: String(formData.get("trade_id")),
  });

  if (error) {
    redirect(target(leagueId, `?error=${encodeURIComponent(error.message)}`));
  }

  revalidatePath(target(leagueId));
  redirect(target(leagueId, "?message=Veto+recorded."));
}
