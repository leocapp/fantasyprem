-- 0058_breakdown_league_only.sql
-- Keep the scoring breakdown inside the league.
--
-- 0057 wrote team_scoring_breakdown as SECURITY DEFINER with no check on who
-- was asking, which was fine while the only caller was a manager looking at
-- their own team. It is about to be called for every other team in the league,
-- and a definer function with no guard answers for *any* team id — including
-- teams in leagues the caller has never joined.
--
-- Nothing here is secret within a league; standings and lineups are already
-- visible to members. Across leagues it is nobody's business, and every other
-- table in this schema says so through is_league_member. This one should too.
--
-- Written as a filter rather than a raised exception: a non-member gets no
-- team row, so the whole query returns nothing, which is what the rest of the
-- schema does under RLS.

create or replace function team_scoring_breakdown(p_team_id uuid)
returns table (
  bucket  text,
  weeks   integer,
  total   numeric,
  average numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with team as (
    select ft.id, ft.league_id, l.season_id
      from fantasy_teams ft
      join leagues l on l.id = ft.league_id
     where ft.id = p_team_id
       and (is_league_member(l.id) or is_league_commissioner(l.id))
  ),
  played as (
    select g.id as gameweek_id
      from gameweeks g
      join team t on g.season_id = t.season_id
     where g.status = 'complete'
  ),
  starters as (
    select p.gameweek_id, lp.player_id, lp.is_captain, lp.is_vice_captain, li.id as lineup_id
      from played p
      join lineups li on li.fantasy_team_id = p_team_id and li.gameweek_id = p.gameweek_id
      join lineup_players lp on lp.lineup_id = li.id and lp.role = 'starter'
  ),
  armband as (
    select gameweek_id,
           (array_agg(player_id) filter (where is_captain))[1]      as captain,
           (array_agg(player_id) filter (where is_vice_captain))[1] as vice
      from starters
     group by gameweek_id
  ),
  -- The same rule team_gameweek_points applies: the vice takes over when the
  -- captain didn't play. Spelled out a second time here rather than shared,
  -- which is a duplication worth knowing about — if the armband rule ever
  -- changes, it changes in two places.
  doubled as (
    select a.gameweek_id,
           case
             when coalesce(
               (select (s.breakdown ->> 'minutes')::numeric > 0
                  from player_gameweek_scores s, team t
                 where s.league_id = t.league_id
                   and s.gameweek_id = a.gameweek_id
                   and s.player_id = a.captain),
               false
             )
             then a.captain
             else a.vice
           end as player_id
      from armband a
  ),
  contributions as (
    select
      pl.position::text as bucket,
      coalesce(s.points, 0) * (case when d.player_id = st.player_id then 2 else 1 end) as points
    from starters st
    join players pl on pl.id = st.player_id
    left join doubled d on d.gameweek_id = st.gameweek_id
    left join player_gameweek_scores s
      on s.player_id = st.player_id
     and s.gameweek_id = st.gameweek_id
     and s.league_id = (select league_id from team)
  ),
  counted as (select count(*)::integer as weeks from played)
  select
    c.bucket,
    (select weeks from counted),
    round(sum(c.points), 1),
    round(sum(c.points) / nullif((select weeks from counted), 0), 1)
  from contributions c
  group by c.bucket
   union all
  select
    'TEAM',
    (select weeks from counted),
    round(coalesce(sum(c.points), 0), 1),
    round(coalesce(sum(c.points), 0) / nullif((select weeks from counted), 0), 1)
  from contributions c;
$$;

comment on function team_scoring_breakdown(uuid) is
  'Per-position and whole-team scoring averages across every completed '
  'gameweek. Returns nothing to callers outside the league. The captain''s '
  'double counts towards his own position, so the positions add up to the team.';

revoke all on function team_scoring_breakdown(uuid) from public;
grant execute on function team_scoring_breakdown(uuid) to authenticated, service_role;
