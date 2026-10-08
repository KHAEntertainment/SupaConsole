-- Synthetic catalog; no real user, account or production data.
create table public.sample_categories (
  id integer primary key,
  name text not null unique
);
create table public.sample_catalog (
  id integer primary key,
  category_id integer not null references public.sample_categories(id),
  title text not null,
  is_public boolean not null default true,
  submitted_by uuid references auth.users(id)
);
create table public.sample_private_notes (
  id integer primary key,
  note text not null
);
alter table public.sample_categories enable row level security;
alter table public.sample_catalog enable row level security;
alter table public.sample_private_notes enable row level security;
create policy categories_read on public.sample_categories for select to anon, authenticated using (true);
create policy catalog_anon_read on public.sample_catalog for select to anon using (is_public);
create policy catalog_authenticated_read on public.sample_catalog for select to authenticated
  using (is_public or submitted_by = (select auth.uid()));
grant select on public.sample_categories, public.sample_catalog to anon, authenticated;
revoke all on public.sample_private_notes from anon, authenticated;
