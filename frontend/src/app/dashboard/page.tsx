import Link from "next/link";
import { redirect } from "next/navigation";

import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";

type MeResponse = { id: string; email: string | null; role: string | null };

type MembershipRow = {
  id: string;
  name: string;
  leagues: { id: string; name: string; status: string } | null;
};

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createClient();

  // getUser() revalidates the token with Supabase; getSession() alone is not
  // trustworthy on the server.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { data: memberships } = await supabase
    .from("fantasy_teams")
    .select("id, name, leagues (id, name, status)")
    .eq("owner_id", user.id)
    .returns<MembershipRow[]>();

  let backend: { ok: true; data: MeResponse } | { ok: false; error: string };
  try {
    backend = {
      ok: true,
      data: await apiFetch<MeResponse>("/api/me", { accessToken: session?.access_token }),
    };
  } catch (error) {
    backend = { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }

  return (
    <main className="page page-narrow">
      <div>
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">Signed in as {user.email}</p>
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

      <section className="card">
        <h2 className="section-label">Backend token verification</h2>
        {backend.ok ? (
          <div className="mt-3 space-y-1">
            <p style={{ color: "var(--accent-hover)" }}>FastAPI verified your Supabase JWT.</p>
            <p className="numeric text-xs dim">user id: {backend.data.id}</p>
          </div>
        ) : (
          <div className="mt-3 space-y-1">
            <p style={{ color: "var(--warning)" }}>Backend rejected or could not be reached.</p>
            <p className="numeric text-xs dim">{backend.error}</p>
          </div>
        )}
      </section>
    </main>
  );
}
