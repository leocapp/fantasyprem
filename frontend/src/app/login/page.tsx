import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/supabase/env";

import { login, signup } from "./actions";

type SearchParams = Promise<{ error?: string; message?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { error, message } = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <main className="page page-narrow" style={{ paddingTop: "5rem" }}>
        <h1 className="page-title">Supabase not configured</h1>
        <p className="muted">
          Add <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to{" "}
          <code>frontend/.env.local</code>, then restart the dev server.
        </p>
      </main>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) redirect("/dashboard");

  return (
    <main className="page page-narrow" style={{ maxWidth: "26rem", paddingTop: "5rem" }}>
      <div>
        <h1 className="page-title">Sign in to FantasyPrem</h1>
        <p className="page-subtitle">New here? The same form creates an account.</p>
      </div>

      {error ? <p className="notice notice-error">{error}</p> : null}
      {message ? <p className="notice notice-success">{message}</p> : null}

      {/* suppressHydrationWarning: password managers and browser autofill add
          their own attributes to these fields before React hydrates. */}
      <form className="flex flex-col gap-4" suppressHydrationWarning>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="muted">Email</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            suppressHydrationWarning
            className="input"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="muted">Password</span>
          <input
            name="password"
            type="password"
            required
            minLength={6}
            autoComplete="current-password"
            suppressHydrationWarning
            className="input"
          />
        </label>

        <div className="flex gap-3">
          <button formAction={login} className="btn btn-primary flex-1">
            Sign in
          </button>
          <button formAction={signup} className="btn btn-ghost flex-1">
            Create account
          </button>
        </div>
      </form>

      <Link href="/" className="text-sm dim hover:text-[var(--text)]">
        ← Back home
      </Link>
    </main>
  );
}
