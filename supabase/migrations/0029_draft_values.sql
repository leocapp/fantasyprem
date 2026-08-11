-- 0029_draft_values.sql
-- Draft rankings from last season's real performances.
--
-- "What would this player have scored in THIS league last season" is the right
-- answer to "who should I draft" — and it's a fact rather than a projection.
-- A league paying 8 for a defender's clean sheet gets a genuinely different
-- board from one paying 4, which no generic ranking can offer.
--
-- Materialised rather than computed on demand: the draft room sorts hundreds of
-- players by this, and evaluating scoring rules per row per request would be
-- slow and repetitive. Recomputed by the scheduled job.

create table if not exists draft_values (
  league_id    uuid not null references leagues (id) on delete cascade,
  player_id    uuid not null references players (id) on delete cascade,
  season_id    uuid not null references seasons (id) on delete cascade,
  points       numeric(7, 1) not null default 0,
  appearances  integer not null default 0,
  computed_at  timestamptz not null default now(),
  primary key (league_id, player_id, season_id)
);

create index if not exists draft_values_ranking
  on draft_values (league_id, points desc);

alter table draft_values enable row level security;

create policy "members read draft values"
  on draft_values for select to authenticated
  using (is_league_member(league_id) or is_league_commissioner(league_id));

-- ------------------------------------------------------------ recompute ----

create or replace function recompute_draft_values(p_league_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season_id uuid;
  v_rows      integer;
begin
  -- The most recently completed season we hold data for.
  select f.season_id into v_season_id
    from player_match_stats pms
    join fixtures f on f.id = pms.fixture_id
    join seasons s on s.id = f.season_id
   where not s.is_current
   order by s.ends_on desc
   limit 1;

  if v_season_id is null then
    return 0;
  end if;

  with totals as (
    select
      pms.player_id,
      pl.position,
      count(*) filter (where pms.minutes > 0)   as appearances,
      count(*) filter (where pms.minutes >= 60) as full_games,
      sum(pms.minutes)                          as minutes,
      sum(pms.goals)                            as goals,
      sum(pms.assists)                          as assists,
      count(*) filter (where pms.clean_sheet)   as clean_sheets,
      sum(pms.goals_conceded)                   as goals_conceded,
      sum(pms.own_goals)                        as own_goals,
      sum(pms.penalties_saved)                  as penalties_saved,
      sum(pms.penalties_missed)                 as penalties_missed,
      sum(pms.saves)                            as saves,
      sum(pms.yellow_cards)                     as yellow_cards,
      sum(pms.red_cards)                        as red_cards,
      coalesce(sum(pms.shots_on_target), 0)     as shots_on_target,
      coalesce(sum(pms.key_passes), 0)          as key_passes,
      coalesce(sum(pms.tackles), 0)             as tackles,
      coalesce(sum(pms.interceptions), 0)       as interceptions,
      coalesce(sum(pms.big_chances_created), 0) as big_chances_created,
      coalesce(sum(pms.duels_won), 0)           as duels_won
    from player_match_stats pms
    join fixtures f on f.id = pms.fixture_id
    join players pl on pl.id = pms.player_id
    where f.season_id = v_season_id
    group by pms.player_id, pl.position
  )
  insert into draft_values (league_id, player_id, season_id, points, appearances, computed_at)
  select
    p_league_id,
    t.player_id,
    v_season_id,
    round(
      (t.appearances - t.full_games) * rule_points(p_league_id, 'minutes_played', t.position)
      + t.full_games          * rule_points(p_league_id, 'minutes_full', t.position)
      + t.goals               * rule_points(p_league_id, 'goals', t.position)
      + t.assists             * rule_points(p_league_id, 'assists', t.position)
      + t.clean_sheets        * rule_points(p_league_id, 'clean_sheet', t.position)
      + floor(t.goals_conceded / 2.0) * rule_points(p_league_id, 'goals_conceded_2', t.position)
      + floor(t.saves / 3.0)  * rule_points(p_league_id, 'saves_3', t.position)
      + t.penalties_saved     * rule_points(p_league_id, 'penalties_saved', t.position)
      + t.penalties_missed    * rule_points(p_league_id, 'penalties_missed', t.position)
      + t.own_goals           * rule_points(p_league_id, 'own_goals', t.position)
      + t.yellow_cards        * rule_points(p_league_id, 'yellow_cards', t.position)
      + t.red_cards           * rule_points(p_league_id, 'red_cards', t.position)
      + t.shots_on_target     * rule_points(p_league_id, 'shots_on_target', t.position)
      + t.key_passes          * rule_points(p_league_id, 'key_passes', t.position)
      + t.tackles             * rule_points(p_league_id, 'tackles', t.position)
      + t.interceptions       * rule_points(p_league_id, 'interceptions', t.position)
      + t.big_chances_created * rule_points(p_league_id, 'big_chances_created', t.position)
      + t.duels_won           * rule_points(p_league_id, 'duels_won', t.position)
      , 1),
    t.appearances,
    now()
  from totals t
  on conflict (league_id, player_id, season_id)
  do update set points = excluded.points,
                appearances = excluded.appearances,
                computed_at = excluded.computed_at;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create or replace function recompute_all_draft_values()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league record;
  v_total  integer := 0;
begin
  for v_league in select id from leagues loop
    v_total := v_total + recompute_draft_values(v_league.id);
  end loop;

  return v_total;
end;
$$;

revoke all on function recompute_draft_values(uuid) from public;
revoke all on function recompute_all_draft_values() from public;

grant execute on function recompute_draft_values(uuid) to authenticated, service_role;
grant execute on function recompute_all_draft_values() to service_role;
