-- Fixture-specific post-restore policy. Run as the preview database owner.
-- Workers should be stopped before restoring/applying untrusted SQL: this script
-- cannot undo HTTP requests or cron commands that ran before it acquired locks.
begin;
select cron.alter_job(jobid, active := false) from cron.job where active;
-- A preview has no legitimate queued requests, so discard every destination.
delete from net.http_request_queue;
-- No source secrets are retained. This value is synthetic and intentionally public.
delete from vault.secrets;
select vault.create_secret('preview-only-not-a-credential', 'preview_sample_token', 'Synthetic T6 fixture value');
-- Deactivating cron is insufficient if an RPC can enqueue another outside call.
create or replace function public.sample_dispatch_probe()
returns bigint language sql security definer set search_path = ''
as $$ select 0::bigint $$;
notify pgrst, 'reload schema';
commit;
