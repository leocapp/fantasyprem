-- dry_run_playoffs.sql
-- Rehearse a whole playoff run against a throwaway league, then throw it away.
--
--   Paste into the Supabase SQL editor and run. Nothing is kept.
--
-- Everything in 0054 would otherwise execute for the first time in April, on
-- the one occasion it matters, having never run. This project has already been
-- caught by that three times — carry_forward_lineup, claim_player, and a
-- KeyError in the reminder that survived seventeen days because no reminder was
-- ever due. Code that has never executed looks exactly like code that works.
--
-- The report is delivered by raising an exception with the whole thing in the
-- message. That is deliberate: it displays in the editor, and it guarantees the
-- transaction rolls back, so a fabricated league cannot possibly survive a
-- mistake in this script. Seeing "ERROR" at the end means it worked.

do $$
declare
  v_playoff_teams constant integer := 7;   -- change to 6 or 4 to rehearse those

  v_season   uuid;
  v_league   uuid;
  v_owners   uuid[];
  v_teams    uuid[];
  v_rounds   integer;
  v_last     integer;
  v_result   text;
  v_report   text := '';
  v_row      record;
  v_champion uuid;
  i          integer;
begin
  -- --- a season and some owners -------------------------------------------
  select id into v_season from seasons where is_current limit 1;
  if v_season is null then
    raise exception 'No current season.';
  end if;

  select array_agg(id) into v_owners from (select id from profiles limit 7) as p;

  if coalesce(array_length(v_owners, 1), 0) < 7 then
    raise exception 'Need seven profiles to fake seven managers; found %.',
      coalesce(array_length(v_owners, 1), 0);
  end if;

  -- --- a league -------------------------------------------------------------
  insert into leagues (
    name, season_id, commissioner_id, join_code, max_teams,
    roster_size, min_gk, min_def, min_mid, min_fwd,
    status, playoff_teams
  )
  values (
    'DRY RUN — delete me', v_season, v_owners[1],
    upper(substr(md5(random()::text), 1, 6)), 12,
    17, 2, 3, 3, 3,
    'active', v_playoff_teams
  )
  returning id into v_league;

  for i in 1 .. 7 loop
    insert into fantasy_teams (league_id, owner_id, name, draft_position)
    values (v_league, v_owners[i], 'Team ' || i, i);
  end loop;

  select array_agg(id order by draft_position) into v_teams
    from fantasy_teams where league_id = v_league;

  v_rounds := playoff_rounds(v_playoff_teams);
  v_last := playoff_start_week(v_league);

  v_report := format(
    E'Bracket of %s from %s teams, %s round(s), opening in gameweek %s.\nThe league programme runs to the end regardless.\n',
    power(2, v_rounds)::integer, v_playoff_teams, v_rounds, v_last
  );

  perform generate_schedule(v_league);

  v_report := v_report || format(
    E'Schedule: %s league matchups across the whole season.\n\n',
    (select count(*) from matchups where league_id = v_league)
  );

  -- Only up to the week the bracket opens. The fixtures during the bracket are
  -- left unplayed on purpose: seeding must not wait for them, and this is where
  -- the old sequential design would have hung forever.
  --
  -- Team 1 beats everyone, team 7 loses to everyone, so the seeding is entirely
  -- predictable and anything odd below is the bracket's doing, not the scoring's.
  update matchups m
     set status = 'final',
         home_points = 100 - array_position(v_teams, m.home_team_id),
         away_points = case
                         when m.away_team_id is null then 96
                         else 100 - array_position(v_teams, m.away_team_id)
                       end
    from gameweeks g
   where g.id = m.gameweek_id
     and m.league_id = v_league
     and m.stage = 'regular'
     and g.number < v_last;

  -- --- run the tournament ---------------------------------------------------
  for i in 1 .. v_rounds loop
    v_result := advance_playoffs(v_league);
    v_report := v_report || format(E'advance_playoffs -> %s\n', coalesce(v_result, 'null'));

    if v_result is null then
      v_report := v_report || E'  STOPPED: nothing was created. The rest is untested.\n';
      exit;
    end if;

    for v_row in
      select m.bracket_slot,
             h.name as home, a.name as away,
             m.home_points, m.away_points,
             hs.seed as home_seed, aseed.seed as away_seed
        from matchups m
        join fantasy_teams h on h.id = m.home_team_id
        left join fantasy_teams a on a.id = m.away_team_id
        left join playoff_seeds hs on hs.league_id = v_league and hs.team_id = m.home_team_id
        left join playoff_seeds aseed on aseed.league_id = v_league and aseed.team_id = m.away_team_id
       where m.league_id = v_league and m.stage = 'playoff' and m.round = i
       order by m.bracket_slot
    loop
      v_report := v_report || format(
        E'  slot %s: (%s) %s  v  %s\n',
        v_row.bracket_slot, v_row.home_seed, v_row.home,
        coalesce('(' || v_row.away_seed || ') ' || v_row.away, 'BYE')
      );
    end loop;

    -- The point of the whole rework: the same gameweek also holds a full round
    -- of league fixtures, and every team appears in one.
    v_report := v_report || format(
      E'  alongside: %s league fixture(s) the same week, %s team(s) involved\n',
      (select count(*) from matchups m
         join gameweeks g on g.id = m.gameweek_id
        where m.league_id = v_league and m.stage = 'regular' and g.number = v_last + i - 1),
      (select count(distinct t) from (
         select m.home_team_id as t from matchups m
           join gameweeks g on g.id = m.gameweek_id
          where m.league_id = v_league and m.stage = 'regular' and g.number = v_last + i - 1
          union
         select m.away_team_id from matchups m
           join gameweeks g on g.id = m.gameweek_id
          where m.league_id = v_league and m.stage = 'regular'
            and g.number = v_last + i - 1 and m.away_team_id is not null
       ) as involved)
    );

    -- Three different outcomes on purpose: a favourite winning, an upset, and a
    -- draw that has to be broken on seed. A rehearsal where the better team
    -- always wins never touches playoff_winner's tiebreak.
    update matchups m
       set status = 'final',
           home_points = case when m.bracket_slot % 3 = 0 then 50
                              when m.bracket_slot % 3 = 2 then 40 else 60 end,
           away_points = case when m.away_team_id is null then 0
                              when m.bracket_slot % 3 = 0 then 50
                              when m.bracket_slot % 3 = 2 then 60 else 40 end
     where m.league_id = v_league and m.stage = 'playoff' and m.round = i;

    v_report := v_report || E'\n';
  end loop;

  -- --- who won --------------------------------------------------------------
  select playoff_winner(id) into v_champion
    from matchups
   where league_id = v_league and stage = 'playoff'
     and round = v_rounds and bracket_slot = 1;

  v_report := v_report || format(
    E'Champion: %s\n',
    coalesce((select name from fantasy_teams where id = v_champion), 'NOBODY — check the final')
  );

  -- Finish the league programme, including the weeks the bracket was played in.
  -- This is the season ending, and the table should now count every gameweek.
  update matchups m
     set status = 'final',
         home_points = 100 - array_position(v_teams, m.home_team_id),
         away_points = case
                         when m.away_team_id is null then 96
                         else 100 - array_position(v_teams, m.away_team_id)
                       end
   where m.league_id = v_league and m.stage = 'regular' and m.status <> 'final';

  v_report := v_report || format(
    E'Standings count %s game(s) after the final day — bracket results excluded.\n',
    (select coalesce(max(games_played), 0) from league_standings where league_id = v_league)
  );

  v_report := v_report || format(
    E'Seeds frozen: %s. Bracket ties: %s. League fixtures: %s.\n',
    (select count(*) from playoff_seeds where league_id = v_league),
    (select count(*) from matchups where league_id = v_league and stage = 'playoff'),
    (select count(*) from matchups where league_id = v_league and stage = 'regular')
  );

  -- Rolls everything back. The word ERROR below is the success condition.
  raise exception E'\n\n%\n--- dry run complete, nothing was saved ---', v_report;
end $$;
