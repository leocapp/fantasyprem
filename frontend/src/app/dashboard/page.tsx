import Link from "next/link";
import { redirect } from "next/navigation";

import { signOut } from "@/app/auth/actions";
import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";

type MeResponse = {
  id: string;
  email: string | null;
  role: string | null;
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
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-slate-400">Signed in as {user.email}</p>
        </div>
        <form action={signOut}>
          <button className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-400">
            Sign out
          </button>
        </form>
      </div>

      <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Backend token verification
        </h2>
        {backend.ok ? (
          <div className="mt-3 space-y-1">
            <p className="text-emerald-400">FastAPI verified your Supabase JWT.</p>
            <p className="font-mono text-xs text-slate-500">user id: {backend.data.id}</p>
            <p className="font-mono text-xs text-slate-500">role: {backend.data.role ?? "—"}</p>
          </div>
        ) : (
          <div className="mt-3 space-y-1">
            <p className="text-amber-400">Backend rejected or could not be reached.</p>
            <p className="font-mono text-xs text-slate-500">{backend.error}</p>
          </div>
        )}
      </section>

      <div className="flex gap-3">
        <Link
          href="/leagues"
          className="flex-1 rounded-md bg-emerald-600 px-4 py-2 text-center font-medium text-white hover:bg-emerald-500"
        >
          Your leagues
        </Link>
        <Link
          href="/players"
          className="flex-1 rounded-md border border-slate-600 px-4 py-2 text-center font-medium text-slate-200 hover:border-slate-400"
        >
          Browse players
        </Link>
      </div>
    </main>
  );
}
