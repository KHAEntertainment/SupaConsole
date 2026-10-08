-- The baseline marker is 20261008000400; this is the independently applied delta.
alter table public.sample_catalog add column is_featured boolean not null default false;
create index sample_catalog_featured_idx on public.sample_catalog(id) where is_featured;
create or replace function public.sample_featured_count()
returns bigint language sql stable security invoker set search_path = ''
as $$ select count(*) from public.sample_catalog where is_featured $$;
grant execute on function public.sample_featured_count() to anon, authenticated;
-- Reintroduce operational state to exercise neutralisation after delta application.
select cron.schedule('preview-sample-delta-probe', '0 0 * * *', 'select public.sample_dispatch_probe()');
select public.sample_dispatch_probe();
notify pgrst, 'reload schema';
