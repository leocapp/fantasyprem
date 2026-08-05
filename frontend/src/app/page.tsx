import Link from "next/link";

import { apiFetch, API_BASE_URL } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/supabase/env";

type HelloResponse = {
  message: string;
  service: string;
  environment: string;
};

export const dynamic = "force-dynamic";

async function getBackendStatus(): Promise<
  { ok: true; data: HelloResponse } | { ok: false; error: string }
> {
  try {
    return { ok: true, data: await apiFetch<HelloResponse>("/api/hello") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export default async function Home() {
  const status = await getBackendStatus();

  let signedIn = false;
  if (getSupabaseEnv()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    signedIn = Boolean(user);
  }

  return (
    <main className="page page-narrow" style={{ paddingTop: "5rem" }}>
      <div>
        <h1 className="text-4xl font-bold tracking-tight">FantasyPrem</h1>
        <p className="page-subtitle text-base">
          Draft real players. Score real points. Snake draft, head-to-head, Premier League.
        </p>
        <Link href={signedIn ? "/leagues" : "/login"} className="btn btn-primary mt-5">
          {signedIn ? "Your leagues" : "Sign in"}
        </Link>
      </div>

      <section className="card">
        <h2 className="section-label">Backend connection</h2>
        {status.ok ? (
          <div className="mt-3 space-y-1">
            <p style={{ color: "var(--accent-hover)" }}>Connected to {API_BASE_URL}</p>
            <p className="numeric text-sm muted">{status.data.message}</p>
            <p className="numeric text-xs dim">
              {status.data.service} · {status.data.environment}
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-1">
            <p style={{ color: "var(--warning)" }}>Could not reach {API_BASE_URL}</p>
            <p className="numeric text-xs dim">{status.error}</p>
            <p className="text-sm muted">
              Start the API with <code>uvicorn app.main:app --reload</code> in{" "}
              <code>backend/</code>.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
