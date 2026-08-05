import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

type LeagueDetail = {
  id: string;
  name: string;
  join_code: string;
  status: string;
  max_teams: number;
  roster_size: number;
  commissioner_id: string;
};

type TeamRow = {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  profiles: { display_name: string | null; username: string | null } | null;
};

export const dynamic = "force-dynamic";

export default async function LeaguePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Returns nothing if the user has no team in this league — RLS, not a 404
  // check in application code.
  const { data: league } = await supabase
    .from("leagues")
    .select("id, name, join_code, status, max_teams, roster_size, commissioner_id")
    .eq("id", id)
    .maybeSingle<LeagueDetail>();

  if (!league) notFound();

  const { data: teams } = await supabase
    .from("fantasy_teams")
    .select("id, name, owner_id, created_at, profiles (display_name, username)")
    .eq("league_id", id)
    .order("created_at")
    .returns<TeamRow[]>();

  const isCommissioner = league.commissioner_id === user.id;
  const slotsLeft = league.max_teams - (teams?.length ?? 0);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 p-8 pt-16">
      <div>
        <Link href="/leagues" className="text-sm text-slate-500 hover:text-slate-300">
          ← All leagues
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">{league.name}</h1>
        <p className="mt-1 text-sm text-slate-400">
          {league.status} · {teams?.length ?? 0} of {league.max_teams} teams · {league.roster_size}{" "}
          players per roster
        </p>
      </div>

      <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Join code</h2>
        <p className="mt-2 font-mono text-2xl tracking-widest">{league.join_code}</p>
        <p className="mt-2 text-sm text-slate-500">
          {slotsLeft > 0
            ? `Share this with friends — ${slotsLeft} ${slotsLeft === 1 ? "slot" : "slots"} left.`
            : "This league is full."}
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Teams</h2>
        <ul className="mt-3 flex flex-col gap-2">
          {teams?.map((team) => (
            <li
              key={team.id}
              className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3"
            >
              <span className="font-medium">{team.name}</span>
              <span className="text-sm text-slate-500">
                {team.profiles?.display_name ?? team.profiles?.username ?? "Manager"}
                {team.owner_id === league.commissioner_id ? " · commissioner" : ""}
                {team.owner_id === user.id ? " · you" : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-sm text-slate-500">
        {isCommissioner
          ? "You run this league. The draft room is the next thing to build."
          : "Waiting on the commissioner to start the draft."}
      </p>
    </main>
  );
}
