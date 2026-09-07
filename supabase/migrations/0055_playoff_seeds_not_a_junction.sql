-- 0055_playoff_seeds_not_a_junction.sql
-- Undo an accidental many-to-many.
--
-- playoff_seeds was created with two foreign keys — leagues and fantasy_teams —
-- and a primary key made of exactly those two columns. That is the precise
-- shape PostgREST looks for when it decides a table is a junction, so it began
-- offering a many-to-many relationship between leagues and fantasy_teams.
--
-- Those two tables already have a direct foreign key. Adding a second path made
-- every embed between them ambiguous, and PostgREST refuses an ambiguous embed
-- rather than picking one. The navigation asks fantasy_teams for its leagues on
-- every page, got an error back, and — because it reads `data` and ignores
-- `error` — rendered as though the user belonged to no leagues at all. Signed
-- in, own team invisible, nothing on screen explaining why.
--
-- The table only ever needed one row per team per league. A surrogate key gets
-- that without looking like a join table.

alter table playoff_seeds
  drop constraint if exists playoff_seeds_pkey;

alter table playoff_seeds
  add column if not exists id uuid not null default gen_random_uuid();

alter table playoff_seeds
  add constraint playoff_seeds_pkey primary key (id);

-- The guarantee that mattered, kept as a constraint instead of as the identity
-- of the row: one seed per team, one team per seed.
alter table playoff_seeds
  drop constraint if exists playoff_seeds_one_per_team;

alter table playoff_seeds
  add constraint playoff_seeds_one_per_team unique (league_id, team_id);

-- PostgREST caches the schema and will keep serving the old, ambiguous
-- relationship graph until told otherwise.
notify pgrst, 'reload schema';

-- -------------------------------------------------------------- verify ----
-- Two foreign keys are fine. Two foreign keys that are also the primary key is
-- what triggers the junction detection, so that is what to watch for.

do $$
declare
  v_pk text;
begin
  select string_agg(a.attname, ', ' order by a.attnum) into v_pk
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
   where c.conrelid = 'playoff_seeds'::regclass
     and c.contype = 'p';

  if v_pk <> 'id' then
    raise exception 'playoff_seeds primary key is (%) — it must be id alone.', v_pk;
  end if;

  raise notice 'playoff_seeds keyed on id; leagues and fantasy_teams are unambiguous again.';
end $$;
