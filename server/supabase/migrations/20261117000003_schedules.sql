-- Scheduled jobs (pg_cron). Turn on pg_cron first:
-- Supabase dashboard > Database > Extensions > pg_cron.
-- Skipped silently where pg_cron is not installed (e.g. local tests).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- ERD rule 3 / B·C 규칙 3: mark stuck AI requests as timeout every minute
    perform cron.schedule('rowflow-expire-ai-requests', '* * * * *',
                          'select public.expire_ai_requests()');
    -- ERD rule 15: clear data of users inactive for a month, daily at 04:00 KST (19:00 UTC)
    perform cron.schedule('rowflow-cleanup-inactive-users', '0 19 * * *',
                          'select public.cleanup_inactive_users()');
  end if;
end $$;
