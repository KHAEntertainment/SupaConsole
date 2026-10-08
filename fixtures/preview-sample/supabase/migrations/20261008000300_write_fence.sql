create table public.sample_write_audit (
  id bigint generated always as identity primary key,
  catalog_id integer not null,
  operation text not null
);
alter table public.sample_write_audit enable row level security;
revoke all on public.sample_write_audit from anon, authenticated;
create or replace function public.sample_guard_write()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if current_setting('preview_sample.allow_write', true) is distinct from 'on' then
    raise exception 'sample catalog writes require an import session';
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;
create trigger sample_catalog_write_fence before insert or update or delete on public.sample_catalog
for each row execute function public.sample_guard_write();
create or replace function public.sample_audit_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.sample_write_audit(catalog_id, operation) values (NEW.id, TG_OP);
  return NEW;
end;
$$;
create trigger sample_catalog_write_audit after insert or update on public.sample_catalog
for each row execute function public.sample_audit_write();
