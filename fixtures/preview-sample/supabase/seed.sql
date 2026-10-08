begin;
set local preview_sample.allow_write = 'on';
insert into public.sample_categories(id, name)
select n, 'Category ' || n from generate_series(1, 12) as n
on conflict (id) do nothing;
insert into public.sample_catalog(id, category_id, title, is_public, submitted_by)
select n, 1 + (n - 1) % 12, 'Synthetic title ' || n, n <= 300, null
from generate_series(1, 301) as n
on conflict (id) do nothing;
insert into public.sample_private_notes(id, note)
select n, 'Synthetic off-list note ' || n from generate_series(1, 10) as n
on conflict (id) do nothing;
commit;
