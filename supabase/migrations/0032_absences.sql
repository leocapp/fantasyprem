-- 0032_absences.sql
-- Injuries and suspensions from Sportmonks.
--
-- Better data than FPL gave us: a real expected return date rather than a
-- percentage guess. That lets the projection ask a sharper question — not "is
-- this player injured" but "will they be back before this gameweek's deadline".
--
-- players.availability keeps the same letter codes the UI already understands:
--   a available   d doubtful   i injured   s suspended
-- so nothing downstream changes.

alter table players
  add column if not exists expected_return date,
  add column if not exists games_missed integer;

comment on column players.availability is
  'a available, d doubtful, i injured, s suspended. Maintained by the Sportmonks '
  'ingestion from each club''s sidelined list. Null means no absence recorded.';

comment on column players.expected_return is
  'When they are expected back, where the provider gives a date. Null with a '
  'non-null availability means out indefinitely, which is the worse case.';
