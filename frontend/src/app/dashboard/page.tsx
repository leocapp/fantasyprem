import Link from "next/link";
import { redirect } from "next/navigation";

import { requireProfile } from "@/lib/requireProfile";
import { createClient } from "@/lib/supabase/server";

type MembershipRow = {
  id: string;
  name: string;
  leagues: { id: string; name: string; status: string } | null;
};

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Redirects to /account until a username exists.
  const { profile } = await requireProfile();

  const supabase = await createClient();

  // getUser() revalidates the token with Supabase; getSession() alone is not
  // trustworthy on the server.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: memberships } = await supabase
    .from("fantasy_teams")
    .select("id, name, leagues (id, name, status)")
    .eq("owner_id", user.id)
    .returns<MembershipRow[]>();

  return (
    <main className="page page-narrow">
      <div>
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">
          @{profile.username} · {user.email}
        </p>
      </div>

      <section>
        <h2 className="section-label">Your leagues</h2>
        {memberships && memberships.length > 0 ? (
          <ul className="list mt-3">
            {memberships.map((membership) => (
              <li key={membership.id}>
                <Link href={`/leagues/${membership.leagues?.id}`} className="row-link">
                  <span className="flex-1">
                    <span className="font-medium">{membership.leagues?.name}</span>
                    <span className="ml-2 text-sm dim">as {membership.name}</span>
                  </span>
                  <span className="text-xs uppercase dim">{membership.leagues?.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 muted">
            You&apos;re not in a league yet.{" "}
            <Link href="/leagues" className="underline">
              Create or join one
            </Link>
            .
          </p>
        )}
      </section>

      <div className="flex gap-3">
        <Link href="/leagues" className="btn btn-primary flex-1">
          Your leagues
        </Link>
        <Link href="/players" className="btn btn-ghost flex-1">
          Browse players
        </Link>
      </div>

    </main>
  );
}
