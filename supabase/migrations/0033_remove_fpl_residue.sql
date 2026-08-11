-- 0033_remove_fpl_residue.sql
-- Delete the FPL dataset that the Sportmonks switch left behind.
--
-- The switch changed what the ingestion writes and what the app reads, but
-- never removed the old rows. Both provider id columns are unique and a unique
-- constraint doesn't apply to NULLs, so an FPL row (external_id set,
-- sportmonks_id null) and a Sportmonks row for the same thing never collided.
-- The result was two parallel datasets: ~43 clubs, ~1,160 players and ~1,140
-- fixtures where there should be 23, ~584 and 760.
--
-- It stayed invisible because the two halves never met — FPL players sit on FPL
-- clubs and score in FPL fixtures, and no league rosters any of them. The club
-- filter was the one place both halves were listed side by side.
--
-- Nothing is lost that can't be re-fetched: every row deleted here came from
-- the FPL API and its ingestion is idempotent. Reverting to FPL means running
-- that job again, not restoring a backup.

-- ------------------------------------------------------- 1. refuse to guess ----
-- The reference check runs inside the migration rather than being trusted from
-- a query someone ran earlier. If a league has touched an FPL player since,
-- this stops before deleting anything.

do $$
declare
  v_refs integer;
begin
  select
      (select count(*) from roster_entries r
         join players p on p.id = r.player_id where p.sportmonks_id is null)
    + (select count(*) from draft_picks d
         join players p on p.id = d.player_id where p.sportmonks_id is null)
    + (select count(*) from lineup_players l
         join players p on p.id = l.player_id where p.sportmonks_id is null)
    + (select count(*) from trade_items t
         join players p on p.id = t.player_id where p.sportmonks_id is null)
    + (select count(*) from player_gameweek_scores s
         join players p on p.id = s.player_id where p.sportmonks_id is null)
    into v_refs;

  if v_refs > 0 then
    raise exception
      'Aborting: % league row(s) reference FPL-era players. They must be '
      'repointed at their Sportmonks equivalents before this can run.', v_refs;
  end if;
end $$;

-- --------------------------------------------------------- 2. the deletion ----
-- Order matters. player_match_stats cascades from both fixtures and players,
-- so it empties itself; clubs go last because fixtures reference them with
-- on delete restrict and would block an earlier attempt.

delete from fixtures where sportmonks_id is null;
delete from players  where sportmonks_id is null;

-- A surviving row pointing at a club we're about to delete would be silently
-- nulled by on delete set null — a club_id quietly becoming NULL is exactly the
-- kind of damage that shows up weeks later, so check instead.
do $$
declare
  v_orphans integer;
begin
  select
      (select count(*) from players p
         join clubs c on c.id = p.club_id where c.sportmonks_id is null)
    + (select count(*) from player_match_stats s
         join clubs c on c.id = s.club_id where c.sportmonks_id is null)
    into v_orphans;

  if v_orphans > 0 then
    raise exception
      'Aborting: % surviving row(s) still point at an FPL club.', v_orphans;
  end if;
end $$;

delete from clubs where sportmonks_id is null;

-- ------------------------------------------------------------- 3. verify ----

do $$
declare
  v_clubs integer;
begin
  select count(*) into v_clubs from clubs;

  -- 20 current clubs plus those relegated from the season we backfilled. Fewer
  -- than 20 means the deletion took something it shouldn't have.
  if v_clubs < 20 then
    raise exception 'Aborting: only % clubs left, expected at least 20.', v_clubs;
  end if;
end $$;

-- ---------------------------------------------------------- 4. keep it so ----
-- The invariant the schema was missing. Two providers' ids are two ways of
-- naming the same club, so it's the row that must be unique, not each id.

create unique index if not exists clubs_one_row_per_name
  on clubs (lower(name));

-- ------------------------------------------- 5. clubs worth filtering by ----
-- Relegated clubs keep their rows so last season's fixtures and stats still
-- resolve, but they have no active players — offering one in a filter offers a
-- guaranteed empty result.

create or replace view current_clubs
with (security_invoker = true) as
select c.*
  from clubs c
 where exists (
   select 1 from players p where p.club_id = c.id and p.is_active
 );

comment on view current_clubs is
  'Clubs with at least one active player — this season''s league. Use for filter '
  'dropdowns; use clubs itself when resolving historical fixtures.';

grant select on current_clubs to authenticated;
