-- 0021_settle_all_trades.sql
-- League-wide trade settlement for the scheduled job.
--
-- execute_due_trades() works one league at a time and runs when someone opens
-- the trades page. This is the same thing across every active league, so a
-- cron can settle trades whether or not anyone is looking.

create or replace function execute_all_due_trades()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade record;
  v_done  integer := 0;
begin
  for v_trade in
    select id from trades
     where status = 'accepted'
       and veto_deadline <= now()
  loop
    perform execute_trade(v_trade.id);
    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;

revoke all on function execute_all_due_trades() from public;
grant execute on function execute_all_due_trades() to service_role;
