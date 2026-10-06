# SupaConsole ops

Host setup and end-to-end regression for the SupaConsole test VPS.

## Layout

| File | Purpose |
| --- | --- |
| `vps-setup.sh` | One-shot Ubuntu 24.04 host setup. Installs Docker, configures the DOCKER-USER lockdown, installs Node 22, clones SupaConsole, builds it, and starts it under systemd on `127.0.0.1:3000`. |
| `e2e.sh` | End-to-end regression against a running SupaConsole. Drives `setup → deploy → verify → delete` over the project's own HTTP API. Used as a release gate for persistent projects. |
| `README.md` | This file. |

The scripts are byte-for-byte the same as the copies on the preview host (`supaconsole-preview`, root@157.230.168.87) except that `vps-setup.sh` makes the cloned SupaConsole branch a parameter (`BRANCH=…`, default `main`) instead of hardcoding `fix/supabase-2026-compat`.

## Rebuild a host

Target: a fresh Ubuntu 24.04 droplet or VM with SSH access as root.

```sh
# from your laptop
scp ops/vps-setup.sh root@<host>:/root/vps-setup.sh
ssh root@<host> 'BRANCH=main bash /root/vps-setup.sh'
```

`vps-setup.sh` is idempotent in effect (it wipes `/opt/supaconsole` before cloning) but
not in state: it will reset the DOCKER-USER unit and the `supaconsole` systemd service
on every run. To pin a different SupaConsole branch on a rebuild, set `BRANCH`:

```sh
ssh root@<host> 'BRANCH=fix/supabase-2026-compat bash /root/vps-setup.sh'
```

`vps-setup.sh` fails loud if the DOCKER-USER `DROP` rule did not land. Without that
rule, Supabase's compose file publishes the gateway and pooler on `0.0.0.0`, so the
firewall unit is required for any public-internet host. On a private-only host you can
skip the unit, but the script does not currently branch on that — change it if needed.

## Run the regression script

After `vps-setup.sh` finishes, SupaConsole is running on `http://127.0.0.1:3000` and
the `supaconsole` systemd service is enabled. Drive the regression on the host:

```sh
# from the host
scp <laptop>:ops/e2e.sh /root/e2e.sh    # or copy the file however you prefer
chmod +x /root/e2e.sh
/root/e2e.sh setup
/root/e2e.sh deploy
/root/e2e.sh verify
/root/e2e.sh delete
```

Expected:

- `setup` registers `e2e@example.com`, logs in, initializes the Supabase core clone,
  and creates a project named `compat-e2e`. Cookie jar and project metadata land in
  `/root/e2e/` (mode 700). No secret values are printed.
- `deploy` brings the project's compose stack up. Expect 11/11 containers healthy.
- `verify` checks container health, the gateway table from the
  [compatibility audit](../supabase-compat-audit), and a SQL → PostgREST round trip
  with the seeded anon key. The forged-JWT negative control must return 401/403.
- `delete` removes the project. Expect 0 containers and 0 project directories left.

## `verify` as a release gate

`e2e.sh verify` is the release gate for any change that affects SupaConsole's
runtime behaviour against a current Supabase self-hosted release. That includes:

- changes to `src/lib/project.ts` (env generation, JWT signing, container naming,
  compose manipulation);
- changes to the Supabase core pin or to `initializeSupabaseCore`;
- changes to the API routes called by `e2e.sh` (`/api/auth/*`, `/api/projects/*`,
  `/api/projects/:id/env`);
- any change to `Dockerfile`, `docker-compose.yml`, or the Prisma schema.

For preview environments (per-project ephemeral Supabase backends) the same script
will become the per-PR `verify` step. Until that lands, the persistent-project
regression is the only gate.

A green `verify` run is required before merging a change that touches the above.
Run it on the preview host (`supaconsole-preview`); a fresh-droplet run is the
stronger check and is preferred for releases that change the Supabase pin or the
DOCKER-USER lockdown.

## Secret handling in `e2e.sh`

`e2e.sh` keeps every secret it generates in `/root/e2e/`:

- The directory is created with `chmod 700` before anything is written.
- `cookies.txt` (the session cookie) and `vars.json` (the project's generated keys)
  live in that directory. `vars.json` is also `chmod 600`.
- The script never prints the cookie, the anon key, the service-role key, the
  dashboard username, or the dashboard password. The `verify` step prints only
  whether each value is set (`${ANON:+set}`-style markers), and the gateway
  checks operate on the variables in-process.

If you change `e2e.sh`, do not relax any of these. The script is run as root, so
the mode-700 directory is the only thing keeping the project's
`SERVICE_ROLE_KEY` and `POSTGRES_PASSWORD` off the host's other users.
