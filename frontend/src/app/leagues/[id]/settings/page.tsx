import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import CopyField from "@/components/CopyField";
import { createClient } from "@/lib/supabase/server";

import ManagerAvatar from "@/components/ManagerAvatar";

import {
  removeTeam,
  resetLeague,
  setCommissioner,
  updateLeagueSettings,
  updateScoringRules,
} from "./actions";

type LeagueRow = {
  id: string;
  name: string;
  status: string;
  join_code: string;
  max_teams: number;
  roster_size: number;
  min_gk: number;
  min_def: number;
  min_mid: number;
  min_fwd: number;
  carry_forward_lineups: boolean;
  email_reminders: boolean;
  reminder_hours_before: number;
  commissioner_id: string;
};

type RuleRow = {
  id: string;
  stat_key: string;
  applies_to: string | null;
  points: number;
};

type TeamRow = {
  id: string;
  name: string;
  owner_id: string;
  profiles: { username: string | null; avatar_url: string | null } | null;
};

const STAT_LABELS: Record<string, string> = {
  minutes_played: "Playing 1–59 minutes",
  minutes_full: "Playing 60+ minutes",
  goals: "Goal",
  assists: "Assist",
  clean_sheet: "Clean sheet",
  goals_conceded_2: "Every 2 goals conceded",
  saves_3: "Every 3 saves",
  penalties_saved: "Penalty saved",
  penalties_missed: "Penalty missed",
  own_goals: "Own goal",
  yellow_cards: "Yellow card",
  red_cards: "Red card",
  shots_on_target: "Shot on target",
  key_passes: "Key pass",
  tackles: "Tackle",
  interceptions: "Interception",
  big_chances_created: "Big chance created",
  duels_won: "Duel won",
};

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { id } = await params;
  const { error, message } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: league } = await supabase
    .from("leagues")
    .select(
      "id, name, status, join_code, max_teams, roster_size, min_gk, min_def, min_mid, min_fwd, carry_forward_lineups, email_reminders, reminder_hours_before, commissioner_id",
    )
    .eq("id", id)
    .maybeSingle<LeagueRow>();

  if (!league) notFound();

  const { data: coCommissioners } = await supabase
    .from("league_commissioners")
    .select("profile_id")
    .eq("league_id", id)
    .returns<{ profile_id: string }[]>();

  const commissionerIds = new Set([
    league.commissioner_id,
    ...(coCommissioners ?? []).map((row) => row.profile_id),
  ]);

  if (!commissionerIds.has(user.id)) redirect(`/leagues/${id}`);

  const isOwner = league.commissioner_id === user.id;

  const { data: teams } = await supabase
    .from("fantasy_teams")
    .select("id, name, owner_id, profiles (username, avatar_url)")
    .eq("league_id", id)
    .order("name")
    .returns<TeamRow[]>();

  const { data: rules } = await supabase
    .from("scoring_rules")
    .select("id, stat_key, applies_to, points")
    .eq("league_id", id)
    .returns<RuleRow[]>();

  const ordered = (rules ?? []).slice().sort((a, b) => {
    const labelA = STAT_LABELS[a.stat_key] ?? a.stat_key;
    const labelB = STAT_LABELS[b.stat_key] ?? b.stat_key;
    return labelA.localeCompare(labelB) || (a.applies_to ?? "").localeCompare(b.applies_to ?? "");
  });

  const host = (await headers()).get("host") ?? "localhost:3000";
  const protocol = host.startsWith("localhost") ? "http" : "https";
  const inviteUrl = `${protocol}://${host}/leagues?code=${league.join_code}`;

  const inSetup = league.status === "setup";

  return (
    <main className="page page-narrow">
      <div>
        <h1 className="page-title">League settings</h1>
        <p className="page-subtitle">
          {league.name} · {league.status} · only you can see this page.
        </p>
      </div>

      {error ? <p className="notice notice-error">{error}</p> : null}
      {message ? <p className="notice notice-success">{message}</p> : null}

      <section className="card">
        <h2 className="section-label">Invite managers</h2>
        <div className="mt-3 flex flex-col gap-3">
          <CopyField label="Join code" value={league.join_code} mono />
          <CopyField label="Invite link" value={inviteUrl} />
        </div>
        {!inSetup ? (
          <p className="mt-3 text-sm" style={{ color: "var(--warning)" }}>
            The draft has started, so nobody new can join this league. The code is here for
            reference.
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2 className="section-label">League</h2>
        <form
          action={updateLeagueSettings}
          className="mt-3 flex flex-col gap-3"
          suppressHydrationWarning
        >
          <input type="hidden" name="league_id" value={league.id} />

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="muted">Name</span>
            <input
              name="name"
              defaultValue={league.name}
              minLength={3}
              maxLength={60}
              className="input"
              suppressHydrationWarning
            />
          </label>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="muted">Max teams</span>
              <input
                name="max_teams"
                type="number"
                min={2}
                max={20}
                defaultValue={league.max_teams}
                disabled={!inSetup}
                className="input"
                suppressHydrationWarning
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="muted">Squad size</span>
              <input
                name="roster_size"
                type="number"
                min={11}
                max={30}
                defaultValue={league.roster_size}
                disabled={!inSetup}
                className="input"
                suppressHydrationWarning
              />
            </label>
          </div>

          <p className="text-xs dim">Minimum players per position</p>
          <div className="grid grid-cols-4 gap-3">
            {(
              [
                ["min_gk", "GK", league.min_gk],
                ["min_def", "DEF", league.min_def],
                ["min_mid", "MID", league.min_mid],
                ["min_fwd", "FWD", league.min_fwd],
              ] as const
            ).map(([field, label, value]) => (
              <label key={field} className="flex flex-col gap-1.5 text-sm">
                <span className="muted">{label}</span>
                <input
                  name={field}
                  type="number"
                  min={1}
                  max={10}
                  defaultValue={value}
                  disabled={!inSetup}
                  className="input"
                  suppressHydrationWarning
                />
              </label>
            ))}
          </div>

          {!inSetup ? (
            <p className="text-xs dim">
              Squad rules are locked once the draft starts — changing them would invalidate rosters
              that have already been picked.
            </p>
          ) : null}

          <label className="mt-1 flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="carry_forward_lineups"
              defaultChecked={league.carry_forward_lineups}
              className="mt-1 h-4 w-4 accent-emerald-600"
              suppressHydrationWarning
            />
            <span>
              Reuse last week&apos;s lineup
              <span className="block text-xs dim">
                If a manager doesn&apos;t set a lineup, their previous one is used, minus anyone
                they no longer own. Off means they score zero.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="email_reminders"
              defaultChecked={league.email_reminders}
              className="mt-1 h-4 w-4 accent-emerald-600"
              suppressHydrationWarning
            />
            <span>
              Email lineup reminders
              <span className="block text-xs dim">
                Managers with no lineup set get one email before the deadline. Off here disables
                them for everyone in the league, whatever their own setting.
              </span>
            </span>
          </label>

          <label className="flex items-center gap-3 text-sm">
            <span className="muted">Send</span>
            <input
              name="reminder_hours_before"
              type="number"
              min={1}
              max={48}
              defaultValue={league.reminder_hours_before}
              className="input w-20"
              suppressHydrationWarning
            />
            <span className="muted">hours before the deadline</span>
          </label>

          <button className="btn btn-primary self-start">Save league</button>
        </form>
      </section>

      <section className="card">
        <h2 className="section-label">Managers</h2>
        <ul className="mt-3 flex flex-col gap-2">
          {teams?.map((team) => {
            const owner = team.owner_id === league.commissioner_id;
            const co = commissionerIds.has(team.owner_id) && !owner;

            return (
              <li key={team.id} className="flex flex-wrap items-center gap-2">
                <ManagerAvatar
                  src={team.profiles?.avatar_url}
                  username={team.profiles?.username}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{team.name}</span>
                  <span className="block truncate text-xs dim">
                    @{team.profiles?.username ?? "unknown"}
                    {owner ? " · owner" : co ? " · co-commissioner" : ""}
                  </span>
                </span>

                {isOwner && !owner ? (
                  <form action={setCommissioner}>
                    <input type="hidden" name="league_id" value={league.id} />
                    <input type="hidden" name="profile_id" value={team.owner_id} />
                    <input type="hidden" name="grant" value={co ? "false" : "true"} />
                    <button className="btn btn-ghost btn-sm">
                      {co ? "Demote" : "Make commissioner"}
                    </button>
                  </form>
                ) : null}

                {!owner && inSetup ? (
                  <form action={removeTeam}>
                    <input type="hidden" name="league_id" value={league.id} />
                    <input type="hidden" name="team_id" value={team.id} />
                    <button className="btn btn-ghost btn-sm">Remove</button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
        {!inSetup ? (
          <p className="mt-3 text-xs dim">
            Managers can only be removed before the draft — afterwards their results are part of
            everyone else&apos;s season.
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2 className="section-label">Scoring</h2>
        <p className="mt-1 text-sm muted">
          Points awarded for each stat. Blank position means it applies to everyone.
        </p>

        <form
          action={updateScoringRules}
          className="mt-3 flex flex-col gap-2"
          suppressHydrationWarning
        >
          <input type="hidden" name="league_id" value={league.id} />

          {ordered.map((rule) => (
            <label key={rule.id} className="flex items-center gap-3 text-sm">
              <span className="flex-1">
                {STAT_LABELS[rule.stat_key] ?? rule.stat_key}
                {rule.applies_to ? (
                  <span className={`badge badge-${rule.applies_to} ml-2`}>{rule.applies_to}</span>
                ) : null}
              </span>
              <input
                name={`points-${rule.id}`}
                type="number"
                step="0.5"
                defaultValue={rule.points}
                className="input w-20 text-right"
                suppressHydrationWarning
              />
            </label>
          ))}

          <button className="btn btn-primary mt-2 self-start">Save scoring</button>
        </form>

        <p className="mt-3 text-xs dim">
          Changing these doesn&apos;t rewrite past results on its own — points are cached per
          gameweek. Re-run the scoring job to apply new rules to gameweeks already played.
        </p>
      </section>

      <section
        className="card"
        style={{ borderColor: "rgb(248 113 113 / 0.35)", background: "rgb(248 113 113 / 0.05)" }}
      >
        <h2 className="section-label" style={{ color: "var(--danger)" }}>
          Reset league
        </h2>
        <p className="mt-2 text-sm muted">
          Deletes the draft, every roster, all lineups, results, trades and the schedule, and puts
          the league back to setup. Teams and managers stay. This cannot be undone.
        </p>
        <form action={resetLeague} className="mt-3 flex flex-col gap-2" suppressHydrationWarning>
          <input type="hidden" name="league_id" value={league.id} />
          <label className="text-xs dim">
            Type <strong>{league.name}</strong> to confirm
          </label>
          <div className="flex gap-2">
            <input
              name="confirm_name"
              required
              placeholder={league.name}
              className="input flex-1"
              suppressHydrationWarning
            />
            <button className="btn btn-ghost" style={{ color: "var(--danger)" }}>
              Reset
            </button>
          </div>
        </form>
      </section>

      <Link href={`/leagues/${league.id}`} className="text-sm dim hover:text-[var(--text)]">
        ← {league.name}
      </Link>
    </main>
  );
}
