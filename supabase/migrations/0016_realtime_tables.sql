-- 0016_realtime_tables.sql
-- Make sure every table the UI subscribes to is actually published.
--
-- A table missing from supabase_realtime fails silently: the channel
-- subscribes fine and simply never delivers anything, which looks exactly like
-- a broken page.
--
-- Also sets REPLICA IDENTITY FULL on the published tables. Without it Postgres
-- only sends the primary key in the old record on UPDATE and DELETE, and
-- Realtime cannot evaluate row filters against rows it cannot see.

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'draft_picks', 'trades', 'trade_items', 'trade_vetoes',
    'league_messages', 'matchups', 'roster_entries'
  ]
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    exception
      when duplicate_object then null;
    end;

    execute format('alter table public.%I replica identity full', v_table);
  end loop;
end;
$$;
