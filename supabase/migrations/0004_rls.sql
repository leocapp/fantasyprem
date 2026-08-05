-- 0004_rls.sql
-- Row Level Security. Default posture: deny everything, then grant back.
--
-- Two important notes:
--   * The service role key bypasses RLS entirely. The ingestion job and any
--     backend-only writes use it, which is why reference tables below are
--     read-only for normal users with no write policies at all.
--   * Helper functions are SECURITY DEFINER so that a policy on fantasy_teams
--     can query fantasy_teams without recursively triggering its own policy.

-- ------------------------------------------------------------- helpers ----

create or replace function is_league_member(p_league_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from fantasy_teams t
     where t.league_id = p_league_id
       and t.owner_id = auth.uid()
  );
$$;

create or replace function is_league_commissioner(p_league_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from leagues l
     where l.id = p_league_id
       and l.commissioner_id = auth.uid()
  );
$$;

create or replace function owns_fantasy_team(p_team_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from fantasy_teams t
     where t.id = p_team_id
       and t.owner_id = auth.uid()
  );
$$;

-- ------------------------------------------------ reference data (read) ----

alter table seasons             enable row level security;
alter table clubs               enable row level security;
alter table gameweeks           enable row level security;
alter table players             enable row level security;
alter table fixtures            enable row level security;
alter table player_match_stats  enable row level security;
alter table default_scoring_rules enable row level security;

create policy "reference readable by signed-in users"
  on seasons for select to authenticated using (true);
create policy "reference readable by signed-in users"
  on clubs for select to authenticated using (true);
create policy "reference readable by signed-in users"
  on gameweeks for select to authenticated using (true);
create policy "reference readable by signed-in users"
  on players for select to authenticated using (true);
create policy "reference readable by signed-in users"
  on fixtures for select to authenticated using (true);
create policy "reference readable by signed-in users"
  on player_match_stats for select to authenticated using (true);
create policy "reference readable by signed-in users"
  on default_scoring_rules for select to authenticated using (true);

-- ------------------------------------------------------------ profiles ----

alter table profiles enable row level security;

create policy "profiles are readable by signed-in users"
  on profiles for select to authenticated using (true);

create policy "users manage their own profile"
  on profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "users create their own profile"
  on profiles for insert to authenticated
  with check (id = auth.uid());

-- ------------------------------------------------------------- leagues ----

alter table leagues enable row level security;

create policy "members read their leagues"
  on leagues for select to authenticated
  using (is_league_member(id) or commissioner_id = auth.uid());

create policy "users create leagues they commission"
  on leagues for insert to authenticated
  with check (commissioner_id = auth.uid());

create policy "commissioner updates the league"
  on leagues for update to authenticated
  using (commissioner_id = auth.uid())
  with check (commissioner_id = auth.uid());

create policy "commissioner deletes the league"
  on leagues for delete to authenticated
  using (commissioner_id = auth.uid());

-- ------------------------------------------------------- fantasy teams ----

alter table fantasy_teams enable row level security;

create policy "members read teams in their leagues"
  on fantasy_teams for select to authenticated
  using (owner_id = auth.uid() or is_league_member(league_id) or is_league_commissioner(league_id));

create policy "users create their own team"
  on fantasy_teams for insert to authenticated
  with check (owner_id = auth.uid());

create policy "users update their own team"
  on fantasy_teams for update to authenticated
  using (owner_id = auth.uid() or is_league_commissioner(league_id))
  with check (owner_id = auth.uid() or is_league_commissioner(league_id));

create policy "users leave their own team"
  on fantasy_teams for delete to authenticated
  using (owner_id = auth.uid() or is_league_commissioner(league_id));

-- ------------------------------------------------------- scoring rules ----

alter table scoring_rules enable row level security;

create policy "members read scoring rules"
  on scoring_rules for select to authenticated
  using (is_league_member(league_id) or is_league_commissioner(league_id));

create policy "commissioner edits scoring rules"
  on scoring_rules for all to authenticated
  using (is_league_commissioner(league_id))
  with check (is_league_commissioner(league_id));

-- --------------------------------------------------------- draft picks ----

alter table draft_picks enable row level security;

create policy "members read the draft board"
  on draft_picks for select to authenticated
  using (is_league_member(league_id) or is_league_commissioner(league_id));

-- Picks are made through the API (which validates turn order), not by direct
-- table writes, so there is deliberately no user-facing insert/update policy.

-- ------------------------------------------------------ roster entries ----

alter table roster_entries enable row level security;

create policy "members read rosters in their leagues"
  on roster_entries for select to authenticated
  using (is_league_member(league_id) or is_league_commissioner(league_id));

-- ------------------------------------------------------------- lineups ----

alter table lineups enable row level security;

create policy "members read lineups in their leagues"
  on lineups for select to authenticated
  using (
    exists (
      select 1 from fantasy_teams t
       where t.id = lineups.fantasy_team_id
         and (is_league_member(t.league_id) or is_league_commissioner(t.league_id))
    )
  );

create policy "managers write their own lineup"
  on lineups for all to authenticated
  using (owns_fantasy_team(fantasy_team_id))
  with check (owns_fantasy_team(fantasy_team_id));

alter table lineup_players enable row level security;

create policy "members read lineup players"
  on lineup_players for select to authenticated
  using (
    exists (
      select 1
        from lineups l
        join fantasy_teams t on t.id = l.fantasy_team_id
       where l.id = lineup_players.lineup_id
         and (is_league_member(t.league_id) or is_league_commissioner(t.league_id))
    )
  );

create policy "managers write their own lineup players"
  on lineup_players for all to authenticated
  using (
    exists (
      select 1 from lineups l
       where l.id = lineup_players.lineup_id
         and owns_fantasy_team(l.fantasy_team_id)
    )
  )
  with check (
    exists (
      select 1 from lineups l
       where l.id = lineup_players.lineup_id
         and owns_fantasy_team(l.fantasy_team_id)
    )
  );

-- ------------------------------------------------------------ matchups ----

alter table matchups enable row level security;

create policy "members read matchups"
  on matchups for select to authenticated
  using (is_league_member(league_id) or is_league_commissioner(league_id));

-- ---------------------------------------------- player gameweek scores ----

alter table player_gameweek_scores enable row level security;

create policy "members read computed scores"
  on player_gameweek_scores for select to authenticated
  using (is_league_member(league_id) or is_league_commissioner(league_id));

-- -------------------------------------------------------- transactions ----

alter table transactions enable row level security;

create policy "members read the transaction log"
  on transactions for select to authenticated
  using (is_league_member(league_id) or is_league_commissioner(league_id));

-- ----------------------------------------------------- standings view ----
-- Views run with the privileges of the querying user in PG15+, so the
-- underlying matchups policy already restricts rows correctly.

alter view league_standings set (security_invoker = on);
