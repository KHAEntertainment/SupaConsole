create or replace function public.sample_catalog_count()
returns bigint language sql stable security invoker set search_path = ''
as $$ select count(*) from public.sample_catalog $$;
grant execute on function public.sample_catalog_count() to anon, authenticated;

-- Deliberately fails until preview setup supplies a named fake Vault entry.
-- Schema baselines include this function, but never Vault secret data.
create or replace function public.sample_vault_token()
returns text language plpgsql stable security definer set search_path = ''
as $$
declare token text;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name = 'preview_sample_token';
  if token is null then raise exception 'preview_sample_token is missing from Vault'; end if;
  return token;
end;
$$;
revoke all on function public.sample_vault_token() from public, anon, authenticated;
grant execute on function public.sample_vault_token() to service_role;
