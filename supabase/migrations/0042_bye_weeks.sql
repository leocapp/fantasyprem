-- 0042_bye_weeks.sql
-- A bye is not a win.
--
-- With an odd number of teams, generate_schedule pads the rotation with a
-- phantom opponent, so one team each week gets a matchup with away_team_id
-- null. score_gameweek then settles it with away_points = 0.
--
-- league_standings counted that as a played game: points_for beat
-- points_against, so it registered as a win, with zero conceded. In a
-- seven-team season that is five or six free wins each — and not even equally,
-- because 38 gameweeks don't divide by 7 — plus a points-against tiebreak
-- flattered by every week someone sat out.
--
-- A bye is simply not a fixture. It contributes no result and no points, in
-- either direction. The remaining unfairness — some teams playing one more
-- match than others — is inherent to an odd league and far smaller than
-- handing out wins for weeks nobody played.

create or replace view league_standings as
with results as (
  select league_id, home_team_id as team_id, home_points as points_for,
         away_points as points_against, status
    from matchups
   -- The bye is on the home side: generate_schedule moves the real team there
   -- when the phantom is drawn away.
   where away_team_id is not null
   union all
  select league_id, away_team_id, away_points, home_points, status
    from matchups
   where away_team_id is not null
)
select
  league_id,
  team_id,
  count(*) filter (where status = 'final')                          as games_played,
  count(*) filter (where status = 'final' and points_for > points_against) as wins,
  count(*) filter (where status = 'final' and points_for < points_against) as losses,
  count(*) filter (where status = 'final' and points_for = points_against) as draws,
  coalesce(sum(points_for) filter (where status = 'final'), 0)      as points_for,
  coalesce(sum(points_against) filter (where status = 'final'), 0)  as points_against
from results
group by league_id, team_id;

alter view league_standings set (security_invoker = on);

grant select on league_standings to authenticated;
