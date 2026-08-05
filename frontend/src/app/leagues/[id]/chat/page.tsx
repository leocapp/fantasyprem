import { notFound, redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import ChatRoom, { type ChatMessage } from "./ChatRoom";

type LeagueRow = { id: string; name: string };
type TeamRow = {
  id: string;
  name: string;
  owner_id: string;
  profiles: { username: string | null; avatar_url: string | null } | null;
};

const HISTORY_LIMIT = 100;

export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: league } = await supabase
    .from("leagues")
    .select("id, name")
    .eq("id", id)
    .maybeSingle<LeagueRow>();

  if (!league) notFound();

  const { data: teams } = await supabase
    .from("fantasy_teams")
    .select("id, name, owner_id, profiles (username, avatar_url)")
    .eq("league_id", id)
    .returns<TeamRow[]>();

  const myTeam = teams?.find((team) => team.owner_id === user.id);
  if (!myTeam) notFound();

  // Newest first from the database so the limit takes the most recent, then
  // reversed for display.
  const { data: recent } = await supabase
    .from("league_messages")
    .select("id, fantasy_team_id, author_id, body, created_at")
    .eq("league_id", id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT)
    .returns<ChatMessage[]>();

  const teamInfo = Object.fromEntries(
    (teams ?? []).map((team) => [
      team.id,
      {
        name: team.name,
        username: team.profiles?.username ?? null,
        avatarUrl: team.profiles?.avatar_url ?? null,
      },
    ]),
  );

  return (
    <main className="page page-narrow">
      <div>
        <h1 className="page-title">League chat</h1>
        <p className="page-subtitle">{league.name} · only managers in this league can read it.</p>
      </div>

      <ChatRoom
        leagueId={league.id}
        teamId={myTeam.id}
        userId={user.id}
        teams={teamInfo}
        initial={(recent ?? []).slice().reverse()}
      />
    </main>
  );
}
