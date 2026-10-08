-- Fixture baseline imports only application objects in public. Managed schemas
-- and role credentials remain those of the destination at the identical pin.
create extension if not exists pg_cron;
-- pg_dump emits explicit source grants, but does not revoke extra destination
-- defaults on newly created objects. Clear them before schema import to avoid
-- widening a service-only Vault function (or excluded table) to anon/authenticated.
-- The source schema dump restores its own default grants after creating objects.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;
