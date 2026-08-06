-- 0022_player_availability.sql
-- Injury and availability, straight from the FPL feed.
--
-- `availability` is their single-letter status code:
--   a  available        d  doubtful
--   i  injured          s  suspended
--   u  unavailable      n  not in squad
--
-- `news` is the human explanation ("Knee injury - 75% chance of playing") and
-- `chance_of_playing` the percentage where FPL gives one.

alter table players
  add column if not exists availability      text,
  add column if not exists news              text,
  add column if not exists news_added_at     timestamptz,
  add column if not exists chance_of_playing integer;

-- Cheap lookup for "show me everyone carrying a knock".
create index if not exists players_availability_idx
  on players (availability)
  where availability is not null and availability <> 'a';
