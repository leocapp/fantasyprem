import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { cancelTrade, proposeTrade, respondToTrade, vetoTrade } from "./actions";

type LeagueRow = { id: string; name: string; status: string };
type TeamRow = { id: string; name: string; owner_id: string };

type RosterRow = {
  player_id: string;
  fantasy_team_id: string;
  players: { display_name: string; position: string; clubs: { short_name: string } | null } | null;
};

type TradeRow = {
  id: string;
  proposer_team_id: string;
  receiver_team_id: string;
  status: string;
  note: string | null;
  created_at: string;
  veto_deadline: string | null;
  trade_items: { player_id: string; from_team_id: string }[];
  trade_vetoes: { fantasy_team_id: string }[];
};

const POSITION_ORDER: Record<string, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

const OPEN_STATUSES = new Set(["proposed", "accepted"]);

export const dynamic = "force-dynamic";

export default async function TradesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ with?: string; error?: string; message?: string }>;
}) {
  const { id } = await params;
  const filters = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: league } = await supabase
    .from("leagues")
    .select("id, name, status")
    .eq("id", id)
    .maybeSingle<LeagueRow>();

  if (!league) notFound();

  // No scheduler in this stack: accepted trades settle when someone looks.
  await supabase.rpc("execute_due_trades", { p_league_id: id });

  const { data: teams } = await supabase
    .from("fantasy_teams")
    .select("id, name, owner_id")
    .eq("league_id", id)
    .order("name")
    .returns<TeamRow[]>();

  const myTeam = teams?.find((team) => team.owner_id === user.id);
  if (!myTeam) notFound();

  const others = (teams ?? []).filter((team) => team.id !== myTeam.id);
  const partner = others.find((team) => team.id === filters.with);

  const { data: rosters } = await supabase
    .from("roster_entries")
    .select("player_id, fantasy_team_id, players (display_name, position, clubs (short_name))")
    .eq("league_id", id)
    .is("dropped_at", null)
    .returns<RosterRow[]>();

  const { data: trades } = await supabase
    .from("trades")
    .select(
      "id, proposer_team_id, receiver_team_id, status, note, created_at, veto_deadline, trade_items (player_id, from_team_id), trade_vetoes (fantasy_team_id)",
    )
    .eq("league_id", id)
    .order("created_at", { ascending: false })
    .returns<TradeRow[]>();

  const nameBy = new Map((teams ?? []).map((team) => [team.id, team.name]));
  const playerBy = new Map(
    (rosters ?? []).map((row) => [
      row.player_id,
      {
        name: row.players?.display_name ?? "Unknown",
        position: row.players?.position ?? "",
        club: row.players?.clubs?.short_name ?? "",
      },
    ]),
  );

  const rosterFor = (teamId: string) =>
    (rosters ?? [])
      .filter((row) => row.fantasy_team_id === teamId)
      .sort(
        (a, b) =>
          (POSITION_ORDER[a.players?.position ?? ""] ?? 9) -
            (POSITION_ORDER[b.players?.position ?? ""] ?? 9) ||
          (a.players?.display_name ?? "").localeCompare(b.players?.display_name ?? ""),
      );

  const open = (trades ?? []).filter((trade) => OPEN_STATUSES.has(trade.status));
  const closed = (trades ?? []).filter((trade) => !OPEN_STATUSES.has(trade.status));

  const uninvolvedCount = (trade: TradeRow) =>
    (teams ?? []).filter(
      (team) => team.id !== trade.proposer_team_id && team.id !== trade.receiver_team_id,
    ).length;

  const renderSide = (trade: TradeRow, teamId: string) => {
    const items = trade.trade_items.filter((item) => item.from_team_id === teamId);
    return items.length > 0
      ? items.map((item) => playerBy.get(item.player_id)?.name ?? "—").join(", ")
      : "—";
  };

  return (
    <main className="page">
      <div>
        <h1 className="page-title">Trades</h1>
        <p className="page-subtitle">
          Both sides trade the same number of players, and each squad must still meet its position
          minimums. Accepted trades settle after a 24-hour veto window.
        </p>
      </div>

      {filters.error ? <p className="notice notice-error">{filters.error}</p> : null}
      {filters.message ? <p className="notice notice-success">{filters.message}</p> : null}

      {league.status !== "active" ? (
        <p className="muted">Trading opens once the draft is complete.</p>
      ) : (
        <>
          <section>
            <h2 className="section-label">Propose a trade</h2>

            <form className="mt-3 flex flex-wrap gap-2" suppressHydrationWarning>
              <select
                name="with"
                defaultValue={partner?.id ?? ""}
                className="select"
                suppressHydrationWarning
              >
                <option value="">Choose a manager…</option>
                {others.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
              <button className="btn btn-ghost">Load squads</button>
            </form>

            {partner ? (
              <form action={proposeTrade} className="mt-4 flex flex-col gap-4">
                <input type="hidden" name="league_id" value={league.id} />
                <input type="hidden" name="receiver_team_id" value={partner.id} />

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <h3 className="text-sm font-semibold">You give</h3>
                    <ul className="list mt-2">
                      {rosterFor(myTeam.id).map((row) => (
                        <li key={row.player_id} className="row gap-2">
                          <input
                            type="checkbox"
                            name="offer"
                            value={row.player_id}
                            className="h-4 w-4 accent-emerald-600"
                            suppressHydrationWarning
                          />
                          <span className={`badge badge-${row.players?.position}`}>
                            {row.players?.position}
                          </span>
                          <span className="flex-1 truncate text-sm">
                            {row.players?.display_name}
                          </span>
                          <span className="text-xs dim">{row.players?.clubs?.short_name}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold">You get</h3>
                    <ul className="list mt-2">
                      {rosterFor(partner.id).map((row) => (
                        <li key={row.player_id} className="row gap-2">
                          <input
                            type="checkbox"
                            name="request"
                            value={row.player_id}
                            className="h-4 w-4 accent-emerald-600"
                            suppressHydrationWarning
                          />
                          <span className={`badge badge-${row.players?.position}`}>
                            {row.players?.position}
                          </span>
                          <span className="flex-1 truncate text-sm">
                            {row.players?.display_name}
                          </span>
                          <span className="text-xs dim">{row.players?.clubs?.short_name}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <input
                  name="note"
                  placeholder="Optional message"
                  className="input"
                  suppressHydrationWarning
                />
                <button className="btn btn-primary self-start">Send proposal</button>
              </form>
            ) : (
              <p className="mt-3 text-sm dim">Pick a manager to see both squads.</p>
            )}
          </section>

          <section>
            <h2 className="section-label">Open trades</h2>
            <ul className="mt-3 flex flex-col gap-2">
              {open.map((trade) => {
                const isProposer = trade.proposer_team_id === myTeam.id;
                const isReceiver = trade.receiver_team_id === myTeam.id;
                const involved = isProposer || isReceiver;
                const vetoes = trade.trade_vetoes.length;
                const others = uninvolvedCount(trade);
                const needed = others === 0 ? null : Math.floor(others / 2) + 1;
                const alreadyVetoed = trade.trade_vetoes.some(
                  (row) => row.fantasy_team_id === myTeam.id,
                );

                return (
                  <li key={trade.id} className="card">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">
                        {nameBy.get(trade.proposer_team_id)} → {nameBy.get(trade.receiver_team_id)}
                      </span>
                      <span className="text-xs uppercase dim">{trade.status}</span>
                    </div>

                    <p className="mt-2 text-sm">
                      <span className="dim">{nameBy.get(trade.proposer_team_id)} gives </span>
                      {renderSide(trade, trade.proposer_team_id)}
                    </p>
                    <p className="text-sm">
                      <span className="dim">{nameBy.get(trade.receiver_team_id)} gives </span>
                      {renderSide(trade, trade.receiver_team_id)}
                    </p>

                    {trade.note ? <p className="mt-2 text-sm muted">“{trade.note}”</p> : null}

                    {trade.status === "accepted" ? (
                      <p className="mt-2 text-xs dim">
                        Settles{" "}
                        {trade.veto_deadline
                          ? new Date(trade.veto_deadline).toLocaleString("en-GB", {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })
                          : "soon"}
                        {needed ? ` · ${vetoes} of ${needed} vetoes needed to block` : ""}
                      </p>
                    ) : null}

                    <div className="mt-3 flex flex-wrap gap-2">
                      {trade.status === "proposed" && isReceiver ? (
                        <>
                          <form action={respondToTrade}>
                            <input type="hidden" name="league_id" value={league.id} />
                            <input type="hidden" name="trade_id" value={trade.id} />
                            <input type="hidden" name="accept" value="true" />
                            <button className="btn btn-primary btn-sm">Accept</button>
                          </form>
                          <form action={respondToTrade}>
                            <input type="hidden" name="league_id" value={league.id} />
                            <input type="hidden" name="trade_id" value={trade.id} />
                            <input type="hidden" name="accept" value="false" />
                            <button className="btn btn-ghost btn-sm">Reject</button>
                          </form>
                        </>
                      ) : null}

                      {trade.status === "proposed" && isProposer ? (
                        <form action={cancelTrade}>
                          <input type="hidden" name="league_id" value={league.id} />
                          <input type="hidden" name="trade_id" value={trade.id} />
                          <button className="btn btn-ghost btn-sm">Withdraw</button>
                        </form>
                      ) : null}

                      {trade.status === "accepted" && !involved && !alreadyVetoed ? (
                        <form action={vetoTrade}>
                          <input type="hidden" name="league_id" value={league.id} />
                          <input type="hidden" name="trade_id" value={trade.id} />
                          <button className="btn btn-ghost btn-sm">Veto</button>
                        </form>
                      ) : null}

                      {alreadyVetoed ? <span className="text-xs dim">You vetoed this.</span> : null}
                    </div>
                  </li>
                );
              })}
              {open.length === 0 ? <li className="text-sm dim">Nothing on the table.</li> : null}
            </ul>
          </section>

          {closed.length > 0 ? (
            <section>
              <h2 className="section-label">History</h2>
              <ul className="list mt-3">
                {closed.slice(0, 15).map((trade) => (
                  <li key={trade.id} className="row justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {nameBy.get(trade.proposer_team_id)} → {nameBy.get(trade.receiver_team_id)}:{" "}
                      {renderSide(trade, trade.proposer_team_id)} for{" "}
                      {renderSide(trade, trade.receiver_team_id)}
                    </span>
                    <span className="text-xs uppercase dim">{trade.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <Link href={`/leagues/${league.id}`} className="text-sm dim hover:text-[var(--text)]">
        ← {league.name}
      </Link>
    </main>
  );
}
