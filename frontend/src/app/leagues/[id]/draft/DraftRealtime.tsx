"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

/**
 * Refreshes the server components whenever a pick is made in this league.
 * Renders nothing — the server pages stay the single source of truth, and this
 * only tells them when to re-run.
 */
export default function DraftRealtime({ leagueId }: { leagueId: string }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`draft:${leagueId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "draft_picks",
          filter: `league_id=eq.${leagueId}`,
        },
        () => router.refresh(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [leagueId, router]);

  return null;
}
