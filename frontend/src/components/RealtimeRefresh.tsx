"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

type Props = {
  /** Unique channel name; two channels with the same name collide. */
  channel: string;
  /** Tables to watch, each with an optional PostgREST-style filter. */
  sources: { table: string; filter?: string; event?: "INSERT" | "UPDATE" | "DELETE" | "*" }[];
  /** Show the connection state at all times. Useful while debugging. */
  debug?: boolean;
  /** Show a warning only while the socket is down. */
  showWhenDegraded?: boolean;
  /** Safety-net poll interval in ms. Set to 0 to rely on the socket alone. */
  pollMs?: number;
};

/**
 * Subscribes to database changes and re-runs the server components on this
 * page. Renders nothing (unless debugging) — the server stays the source of
 * truth, and this only decides when to ask it again.
 */
export default function RealtimeRefresh({
  channel,
  sources,
  debug = false,
  showWhenDegraded = false,
  pollMs = 20000,
}: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<string>("connecting");

  // Serialised so the effect doesn't re-run on every render.
  const key = JSON.stringify(sources);

  useEffect(() => {
    const supabase = createClient();
    const watched: Props["sources"] = JSON.parse(key);

    let subscription = supabase.channel(channel);

    for (const source of watched) {
      subscription = subscription.on(
        "postgres_changes",
        {
          event: source.event ?? "*",
          schema: "public",
          table: source.table,
          ...(source.filter ? { filter: source.filter } : {}),
        },
        () => router.refresh(),
      );
    }

    subscription.subscribe((state, error) => {
      setStatus(state);
      if (error) {
        // Most often: the table isn't in the supabase_realtime publication.
        console.error(`[realtime] ${channel} ${state}`, error);
      }
    });

    // Background tabs get throttled and the socket can drop without the client
    // noticing, so a tab returning to the foreground re-syncs rather than
    // trusting that it kept up.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      router.refresh();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    // Safety net. Mobile browsers suspend pages and can leave a socket that
    // reports healthy but delivers nothing, which is indistinguishable from a
    // quiet league. A slow poll costs little and makes that failure invisible.
    const timer =
      pollMs > 0
        ? setInterval(() => {
            if (document.visibilityState === "visible") router.refresh();
          }, pollMs)
        : undefined;

    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      void supabase.removeChannel(subscription);
    };
  }, [channel, key, router, pollMs]);

  const live = status === "SUBSCRIBED";

  if (debug) {
    return (
      <p className="text-xs text-[var(--text-dim)]">
        realtime: {live ? "connected" : status.toLowerCase()}
      </p>
    );
  }

  // Degraded means the poll is carrying the page: still correct, just slower.
  if (showWhenDegraded && !live && status !== "connecting") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-[var(--text-dim)]">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
        Live connection lost — updating every few seconds instead.
      </p>
    );
  }

  return null;
}
