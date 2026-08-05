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
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-8">
        <h1 className="text-2xl font-bold">Supabase not configured</h1>
        <p className="text-slate-400">
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
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Sign in to FantasyPrem</h1>
        <p className="mt-1 text-sm text-slate-400">New here? Use the same form to create an account.</p>
      </div>

      {error ? (
        <p className="rounded-md border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {message ? (
        <p className="rounded-md border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          {message}
        </p>
      ) : null}

      <form className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-300">Email</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-300">Password</span>
          <input
            name="password"
            type="password"
            required
            minLength={6}
            autoComplete="current-password"
            className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
          />
        </label>

        <div className="flex gap-3">
          <button
            formAction={login}
            className="flex-1 rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500"
          >
            Sign in
          </button>
          <button
            formAction={signup}
            className="flex-1 rounded-md border border-slate-600 px-4 py-2 font-medium text-slate-200 hover:border-slate-400"
          >
            Create account
          </button>
        </div>
      </form>

      <Link href="/" className="text-sm text-slate-500 hover:text-slate-300">
        ← Back home
      </Link>
    </main>
  );
}
