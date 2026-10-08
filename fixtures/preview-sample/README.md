# Preview sample

Synthetic Supabase fixture for T6 and later preview integration checks. It contains
no production data or credentials. Target: self-hosted `self-hosted/v0.8.2`,
Postgres 17, Supabase CLI `v2.120.0`.

| Migration | Exercises |
| --- | --- |
| `20261008000100` | Catalog/category tables, nullable `auth.users` reference, anon/authenticated RLS, excluded notes |
| `20261008000200` | Invoker RPC and service-only named Vault lookup |
| `20261008000300` | Import write fence and audit trigger |
| `20261008000400` | Daily cron, pg_net request to reserved `example.invalid` |
| `20261008000500` | Baseline delta: featured column, index, RPC and another cron job |

The seed inserts 12 categories, 301 titles (300 public, one hidden), 10 synthetic
private notes, and 301 audit records. It uses an explicit import-session setting
to pass the write fence. No auth users are seeded.

From this directory, replay into an empty pinned Supabase project:

```sh
supabase db push --db-url "$PREVIEW_DB_URL" --include-seed --yes
```

For a baseline, apply migrations 1–4 to a source at the same pin. Dump roles
without passwords using Supabase's managed-role exclusions, and dump application
schema only (`public`). Preserve destination platform parameter ACLs too: CLI
v2.120.0's recipe still emits a `log_min_messages` grant for
`supabase_realtime_admin` that the published-port `postgres` user cannot restore.

Restore roles, then run `supabase/baseline-prelude.sql` and the schema dump in one
transaction. The prelude bootstraps `pg_cron` and clears destination application
owner defaults before object creation; otherwise service-only functions inherit
extra anon/authenticated execution grants. The dump restores source defaults
at its end. Apply migration 5 with `psql -X -v ON_ERROR_STOP=1` and record the
baseline marker and delta version in a separate preview-local history table.
Never restore source role passwords, Supabase-managed auth/storage state or
Vault data into a preview.

Run `supabase/neutralise.sql` after either build path. It deactivates all cron
jobs, clears all queued pg_net requests, replaces source Vault entries with one
fake fixture token, and stubs the fixture's outbound dispatcher. This is a
fixture-specific policy, not a generic safe rewrite of arbitrary app SQL.
Post-restore cleanup cannot prevent jobs/HTTP calls from running during import;
production automation must quiesce workers before applying untrusted SQL.

Snapshot allowlist: `public.sample_categories`, `public.sample_catalog` only.
Dump data only, explicitly null `submitted_by` in an export staging table, and
restore within a transaction using `SET LOCAL session_replication_role = replica`.
`sample_private_notes` and `sample_write_audit` must remain empty. A normal
restore should fail the write fence. Disabling triggers also bypasses foreign
keys, so verify category references and null user references afterward.

`supabase/functions/echo/index.ts` uses a pinned supabase-js version to read the
first visible catalog row. Copy its directory to `/home/deno/functions/echo` in
the functions container (`docker cp`), then call `/functions/v1/echo` through the
gateway with the project's anon key in both `apikey` and `Authorization: Bearer`.
Later automation should copy the bundle into the per-project functions mount
before starting edge runtime; Supabase CLI's hosted function deploy is not used
for this self-hosted stack.
