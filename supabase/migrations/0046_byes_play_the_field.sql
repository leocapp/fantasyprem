-- 0046_byes_play_the_field.sql
-- A bye week becomes a match against everybody else's average.
--
-- 0042 took byes out of the standings entirely, which fixed the worse problem
-- — they had been registering as free wins — but left two of its own. Your own
-- score in a bye week vanished, so points-for, the seeding tiebreak, was a
-- total over 32 games for some managers and 33 for others. And one week in
-- seven was dead: score 110 on your bye and it bought you nothing.
--
-- So the bye gets an opponent: the mean of every other team's points that
-- gameweek. Beat it and it's a win. Everybody now plays all 38, points-for and
-- points-against are comparable across the table, and no week is wasted.
--
-- The average is a steadier opponent than any one manager — averaging six
-- scores cuts the week-to-week swing by about sixty percent — so byes reward
-- consistency and throw up fewer upsets than a head-to-head does. That is a
-- deliberate trade, not an oversight.

-- ------------------------------------------------------- settle matchups ----
-- Lifted out of score_gameweek rather than edited in place. score_gameweek is
-- a hundred and seventy lines of scoring arithmetic that has nothing to do with
-- who played whom, and every past change to these nine lines has meant
-- restating all hundred and seventy — 0020, 0028 and 0034 each did. Now it is
-- one small function that can be replaced on its own.

create or replace function settle_matchups(p_league_id uuid, p_gameweek_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_complete boolean;
  v_settled  integer;
begin
  select status = 'complete' into v_complete from gameweeks where id = p_gameweek_id;

  update matchups m
     set home_points = coalesce(team_gameweek_points(m.home_team_id, p_gameweek_id), 0),
         away_points = case
           when m.away_team_id is not null
             then coalesce(team_gameweek_points(m.away_team_id, p_gameweek_id), 0)
           -- A bye. The opponent is the field: every other team in the league,
           -- including anyone who forgot to set a lineup and scored nothing.
           -- They are part of the week that actually happened.
           else coalesce((
             select avg(coalesce(team_gameweek_points(ft.id, p_gameweek_id), 0))
               from fantasy_teams ft
              where ft.league_id = p_league_id
                and ft.id <> m.home_team_id
           ), 0)
         end,
         status = case when v_complete then 'final'::matchup_status
                       else 'live'::matchup_status end
   where m.league_id = p_league_id
     and m.gameweek_id = p_gameweek_id;

  get diagnostics v_settled = row_count;
  return v_settled;
end;
$$;

comment on function settle_matchups(uuid, uuid) is
  'Write each matchup''s points and status for a gameweek. A bye is scored '
  'against the mean of every other team in the league that week.';

revoke all on function settle_matchups(uuid, uuid) from public;
grant execute on function settle_matchups(uuid, uuid) to service_role;

-- ------------------------------------------------------- score_gameweek ----
-- Byte-for-byte the definition from 0034, with the closing matchup update
-- replaced by a call to settle_matchups and v_complete — used by nothing else —
-- dropped from the declarations.

create or replace function score_gameweek(p_league_id uuid, p_gameweek_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scored integer;
  v_carry  boolean;
  v_team   record;
begin
  with keys as (
    select distinct stat_key from scoring_rules where league_id = p_league_id
  ),
  positions as (
    select unnest(enum_range(null::player_position)) as position
  ),
  resolved as (
    select
      p.position,
      k.stat_key,
      coalesce(
        (select points from scoring_rules s
          where s.league_id = p_league_id and s.stat_key = k.stat_key
            and s.applies_to = p.position),
        (select points from scoring_rules s
          where s.league_id = p_league_id and s.stat_key = k.stat_key
            and s.applies_to is null),
        0
      ) as points
    from positions p
    cross join keys k
  ),
  rules as (
    select
      position,
      max(points) filter (where stat_key = 'minutes_played')      as r_minutes_played,
      max(points) filter (where stat_key = 'minutes_full')        as r_minutes_full,
      max(points) filter (where stat_key = 'goals')               as r_goals,
      max(points) filter (where stat_key = 'assists')             as r_assists,
      max(points) filter (where stat_key = 'clean_sheet')         as r_clean_sheet,
      max(points) filter (where stat_key = 'goals_conceded_2')    as r_conceded,
      max(points) filter (where stat_key = 'saves_3')             as r_saves,
      max(points) filter (where stat_key = 'penalties_saved')     as r_pen_saved,
      max(points) filter (where stat_key = 'penalties_missed')    as r_pen_missed,
      max(points) filter (where stat_key = 'own_goals')           as r_own_goals,
      max(points) filter (where stat_key = 'yellow_cards')        as r_yellow,
      max(points) filter (where stat_key = 'red_cards')           as r_red,
      max(points) filter (where stat_key = 'shots_on_target')     as r_shots,
      max(points) filter (where stat_key = 'key_passes')          as r_key_passes,
      max(points) filter (where stat_key = 'tackles')             as r_tackles,
      max(points) filter (where stat_key = 'interceptions')       as r_interceptions,
      max(points) filter (where stat_key = 'big_chances_created') as r_big_chances,
      max(points) filter (where stat_key = 'duels_won')           as r_duels
    from resolved
    group by position
  ),
  totals as (
    select
      pms.player_id,
      pl.position,
      sum(pms.minutes)           as minutes,
      sum(pms.goals)             as goals,
      sum(pms.assists)           as assists,
      count(*) filter (where pms.clean_sheet) as clean_sheets,
      sum(pms.goals_conceded)    as goals_conceded,
      sum(pms.own_goals)         as own_goals,
      sum(pms.penalties_saved)   as penalties_saved,
      sum(pms.penalties_missed)  as penalties_missed,
      sum(pms.saves)             as saves,
      sum(pms.yellow_cards)      as yellow_cards,
      sum(pms.red_cards)         as red_cards,
      coalesce(sum(pms.shots_on_target), 0)     as shots_on_target,
      coalesce(sum(pms.key_passes), 0)          as key_passes,
      coalesce(sum(pms.tackles), 0)             as tackles,
      coalesce(sum(pms.interceptions), 0)       as interceptions,
      coalesce(sum(pms.big_chances_created), 0) as big_chances_created,
      coalesce(sum(pms.duels_won), 0)           as duels_won
    from player_match_stats pms
    join fixtures f on f.id = pms.fixture_id
    join players pl on pl.id = pms.player_id
    where f.gameweek_id = p_gameweek_id
    group by pms.player_id, pl.position
  ),
  computed as (
    select
      t.player_id,
      jsonb_strip_nulls(jsonb_build_object(
        'appearance', case when t.minutes >= 60 then r.r_minutes_full
                           when t.minutes > 0  then r.r_minutes_played else 0 end,
        'goals',            r.r_goals      * t.goals,
        'assists',          r.r_assists    * t.assists,
        'clean_sheet',      r.r_clean_sheet * t.clean_sheets,
        'goals_conceded',   r.r_conceded   * floor(t.goals_conceded / 2.0),
        'saves',            r.r_saves      * floor(t.saves / 3.0),
        'penalties_saved',  r.r_pen_saved  * t.penalties_saved,
        'penalties_missed', r.r_pen_missed * t.penalties_missed,
        'own_goals',        r.r_own_goals  * t.own_goals,
        'yellow_cards',     r.r_yellow     * t.yellow_cards,
        'red_cards',        r.r_red        * t.red_cards,
        'shots_on_target',     r.r_shots        * t.shots_on_target,
        'key_passes',          r.r_key_passes   * t.key_passes,
        'tackles',             r.r_tackles      * t.tackles,
        'interceptions',       r.r_interceptions * t.interceptions,
        'big_chances_created', r.r_big_chances  * t.big_chances_created,
        'duels_won',           r.r_duels        * t.duels_won,
        'minutes',          t.minutes
      )) as breakdown,
      (case when t.minutes >= 60 then r.r_minutes_full
            when t.minutes > 0  then r.r_minutes_played else 0 end)
      + r.r_goals      * t.goals
      + r.r_assists    * t.assists
      + r.r_clean_sheet * t.clean_sheets
      + r.r_conceded   * floor(t.goals_conceded / 2.0)
      + r.r_saves      * floor(t.saves / 3.0)
      + r.r_pen_saved  * t.penalties_saved
      + r.r_pen_missed * t.penalties_missed
      + r.r_own_goals  * t.own_goals
      + r.r_yellow     * t.yellow_cards
      + r.r_red        * t.red_cards
      + r.r_shots         * t.shots_on_target
      + r.r_key_passes    * t.key_passes
      + r.r_tackles       * t.tackles
      + r.r_interceptions * t.interceptions
      + r.r_big_chances   * t.big_chances_created
      + r.r_duels         * t.duels_won as points
    from totals t
    join rules r on r.position = t.position
  )
  insert into player_gameweek_scores (league_id, player_id, gameweek_id, points, breakdown, computed_at)
  select p_league_id, c.player_id, p_gameweek_id, c.points, c.breakdown, now()
  from computed c
  on conflict (league_id, player_id, gameweek_id)
  do update set points = excluded.points,
                breakdown = excluded.breakdown,
                computed_at = excluded.computed_at;

  get diagnostics v_scored = row_count;

  select carry_forward_lineups into v_carry from leagues where id = p_league_id;

  if coalesce(v_carry, false) then
    for v_team in select id from fantasy_teams where league_id = p_league_id loop
      perform carry_forward_lineup(v_team.id, p_gameweek_id);
    end loop;
  end if;

  -- Must come after the scores are written: a bye's opponent is an average of
  -- the other teams' totals, and those totals are read back out of the rows
  -- this function has just inserted.
  perform settle_matchups(p_league_id, p_gameweek_id);

  return v_scored;
end;
$$;

revoke all on function score_gameweek(uuid, uuid) from public;
grant execute on function score_gameweek(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------ league standings ----
-- The bye row comes back in. It is a real result now, so it counts for the
-- home side exactly like any other match — generate_schedule always puts the
-- real team home when the phantom is drawn away, so there is never a bye row
-- whose points belong to the away side.
--
-- The second branch still skips byes: there is no away team to credit them to.

create or replace view league_standings as
with results as (
  select league_id, home_team_id as team_id, home_points as points_for,
         away_points as points_against, status
    from matchups
   union all
  select league_id, away_team_id, away_points, home_points, status
    from matchups
   where away_team_id is not null
)
select
  league_id,
  team_id,
  count(*) filter (where status = 'final')                                as games_played,
  count(*) filter (where status = 'final' and points_for > points_against) as wins,
  count(*) filter (where status = 'final' and points_for < points_against) as losses,
  count(*) filter (where status = 'final' and points_for = points_against) as draws,
  coalesce(sum(points_for) filter (where status = 'final'), 0)             as points_for,
  coalesce(sum(points_against) filter (where status = 'final'), 0)         as points_against
from results
group by league_id, team_id;

alter view league_standings set (security_invoker = on);

grant select on league_standings to authenticated;

-- ------------------------------------------------------------- backfill ----
-- Byes already played still hold away_points = 0, and 0045 freezes settled
-- gameweeks so the cron will never revisit them. Left alone they would show as
-- wins by however many points the manager scored, against nil — the exact bug
-- 0042 was written to kill.
--
-- This rewrites history on purpose, and it can turn a result: a manager who
-- byed with a poor week now has a loss where before he had no fixture at all.
-- One gameweek in is the cheapest this will ever be.
--
-- settle_matchups is safe to re-run over frozen gameweeks: team_gameweek_points
-- reads the stored player_gameweek_scores rather than recomputing them, so
-- home_points lands on the same number it already held.

do $$
declare
  v_bye record;
begin
  for v_bye in
    select distinct m.league_id, m.gameweek_id
      from matchups m
     where m.away_team_id is null
       and m.status <> 'scheduled'
  loop
    perform settle_matchups(v_bye.league_id, v_bye.gameweek_id);
  end loop;
end $$;

-- -------------------------------------------------------------- verify ----
-- Every settled bye should now carry a non-zero opponent score. A zero here
-- means either a league where nobody scored — possible in preseason, not in a
-- played gameweek — or that the backfill loop missed it.

do $$
declare
  v_empty integer;
begin
  select count(*) into v_empty
    from matchups m
   where m.away_team_id is null
     and m.status = 'final'
     and m.away_points = 0;

  if v_empty > 0 then
    raise warning 'Check these: % settled bye(s) still have a zero opponent score.', v_empty;
  end if;
end $$;
