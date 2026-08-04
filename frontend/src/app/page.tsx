import { apiFetch, API_BASE_URL } from "@/lib/api";

type HelloResponse = {
  message: string;
  service: string;
  environment: string;
};

// Always render fresh so the backend status reflects reality on reload.
export const dynamic = "force-dynamic";

async function getBackendStatus(): Promise<
  { ok: true; data: HelloResponse } | { ok: false; error: string }
> {
  try {
    const data = await apiFetch<HelloResponse>("/api/hello");
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export default async function Home() {
  const status = await getBackendStatus();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 p-8">
      <div>
        <h1 className="text-4xl font-bold tracking-tight">FantasyPrem</h1>
        <p className="mt-2 text-slate-400">
          Frontend is running. Skeleton only — no app features yet.
        </p>
      </div>

      <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Backend connection
        </h2>
        {status.ok ? (
          <div className="mt-3 space-y-1">
            <p className="text-emerald-400">Connected to {API_BASE_URL}</p>
            <p className="font-mono text-sm text-slate-300">{status.data.message}</p>
            <p className="font-mono text-xs text-slate-500">
              {status.data.service} · {status.data.environment}
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-1">
            <p className="text-amber-400">Could not reach {API_BASE_URL}</p>
            <p className="font-mono text-xs text-slate-500">{status.error}</p>
            <p className="text-sm text-slate-400">
              Start the API with <code className="text-slate-300">uvicorn app.main:app --reload</code>{" "}
              in the <code className="text-slate-300">backend/</code> directory.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
