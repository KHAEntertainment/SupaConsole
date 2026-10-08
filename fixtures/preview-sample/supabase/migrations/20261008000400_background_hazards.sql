create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
-- supabase_vault is already installed by the pinned self-hosted stack.
create or replace function public.sample_dispatch_probe()
returns bigint language sql security definer set search_path = ''
as $$ select net.http_get(url := 'https://example.invalid/preview-sample-probe', timeout_milliseconds := 1000) $$;
revoke all on function public.sample_dispatch_probe() from public, anon, authenticated;
grant execute on function public.sample_dispatch_probe() to service_role;
select cron.schedule('preview-sample-probe', '0 0 * * *', 'select public.sample_dispatch_probe()');
select public.sample_dispatch_probe();
