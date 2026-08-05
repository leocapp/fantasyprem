import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/supabase/env";

export const dynamic = "force-dynamic";

const FEATURES = [
  ["Snake draft", "Live draft room with turn order enforced by the database."],
  ["Head-to-head", "A weekly opponent, a full season schedule, and standings."],
  ["Real scoring", "Points from actual Premier League performances every gameweek."],
  ["Trades and transfers", "Free agents, multi-player trades and a league veto window."],
];

export default async function Home() {
  if (getSupabaseEnv()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) redirect("/dashboard");
  }

  return (
    <main className="page page-narrow" style={{ paddingTop: "4rem" }}>
      <div>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">FantasyPrem</h1>
        <p className="mt-3 max-w-prose text-lg muted">
          Draft a squad of real Premier League players. Set your XI each week. Score points from
          what actually happens on the pitch.
        </p>
        <Link href="/login" className="btn btn-primary mt-6">
          Sign in to play
        </Link>
      </div>

      <dl className="grid gap-4 sm:grid-cols-2">
        {FEATURES.map(([title, description]) => (
          <div key={title} className="card">
            <dt className="font-semibold">{title}</dt>
            <dd className="mt-1 text-sm muted">{description}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
