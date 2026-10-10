# SupaConsole ops

Host setup and end-to-end regression for the SupaConsole test VPS.

## Layout

| File | Purpose |
| --- | --- |
| `vps-setup.sh` | One-shot Ubuntu 24.04 host setup. Installs Docker, configures the DOCKER-USER lockdown, installs Node 22, creates the `supaconsole` and `dev` users, clones SupaConsole, builds it, and starts it under systemd on `127.0.0.1:3000`. |
| `e2e.sh` | End-to-end regression against a running SupaConsole. Drives `setup → deploy → verify → delete` over the project's own HTTP API. Used as a release gate for persistent projects. |
| `realtime-check/` | Pinned realtime client (`@supabase/supabase-js`, `ws`) used by `e2e.sh verify` for the realtime round-trip. |
| `test-e2e-log-gate.sh` | Unit test for `e2e.sh`'s gateway access-log key gate against a stubbed `docker logs` (unreadable log, empty log, clean, leaked keys). No Docker needed. |
| `README.md` | This file. |

Both scripts come from the preview host (`supaconsole-preview`, root@157.230.168.87) and have been adapted for the repo. `vps-setup.sh` makes the cloned SupaConsole branch a parameter (`BRANCH=…`, default `main`) instead of hardcoding `fix/supabase-2026-compat`; `e2e.sh` adds a non-zero-exit gate around `verify` and `delete` (see below).

## Users on the preview host

`vps-setup.sh` provisions two non-root accounts. The build is reproducible: on a fresh droplet the script creates both, sets their docker membership, and chowns the relevant directories.

| User | Role | Why |
| --- | --- | --- |
| `supaconsole` | System user. Member of `docker`; no login shell; no sudo. Owns `/opt/supaconsole`. | The Next.js process drives docker via the unix socket and writes under `/opt/supaconsole` (`supabase-projects/`, `prisma/supaconsole.db`, `supabase-core/`). Group `docker` is sufficient for the socket access; ownership of `/opt/supaconsole` covers the rest. |
| `dev` | Regular user. Member of `docker`, `users`; linger enabled; npm prefix `~/.npm-global`. | The non-root account that owns agents and dev work. SSH alias `supaconsole-preview-dev` lands here; the Traycer host runs as `ai.traycer.host.service` under `dev`. |

UIDs are assigned by `useradd`/`adduser` and are not pinned in the script. Look at
`id <user>` on a live host for the current values.

The script does **not** install Traycer, Claude Code, or Codex for `dev`. Those are owner-only steps (they require interactive sign-in); see [Owner-only steps](#owner-only-steps).

The `supaconsole` service unit sets `User=supaconsole` / `Group=supaconsole`, and `vps-setup.sh` ships the same file on a fresh install. To change which user the service runs as, edit both files in the same commit.

## Rebuild a host

Target: a fresh Ubuntu 24.04 droplet or VM with SSH access as root.

```sh
# from your laptop
scp ops/vps-setup.sh root@<host>:/root/vps-setup.sh
ssh root@<host> 'BRANCH=main bash /root/vps-setup.sh'
```

`vps-setup.sh` is idempotent in effect (it clears the build outputs and clones from
`BRANCH`) but not in state: it will reset the DOCKER-USER unit and the `supaconsole`
systemd service on every run. To pin a different SupaConsole branch on a rebuild, set
`BRANCH`:

```sh
ssh root@<host> 'BRANCH=fix/supabase-2026-compat bash /root/vps-setup.sh'
```

`vps-setup.sh` fails loud if the DOCKER-USER `DROP` rule did not land. Without that
rule, Supabase's compose file publishes the gateway and pooler on `0.0.0.0`, so the
firewall unit is required for any public-internet host. On a private-only host you can
skip the unit, but the script does not currently branch on that — change it if needed.

The DOCKER-USER script uses a guard-first swap: a temporary comment-tagged DROP is
inserted at position 1, the existing RETURN/DROP pair is removed, the new RETURN and
DROP are inserted at the head, and the guard is removed by its comment. The WAN
interface is never without a DROP during the swap, and rules unrelated to this
script (e.g. agent-managed `-i lo -j ACCEPT`, comment-marked `RETURN`s) survive
untouched. The setup script's readiness probe accepts HTTP 200 from
`http://127.0.0.1:3000/` and fails the build with the last response code and journal
tail otherwise.

## Run the regression script

After `vps-setup.sh` finishes, SupaConsole is running on `http://127.0.0.1:3000` and
the `supaconsole` systemd service is enabled. Drive the regression on the host:

```sh
# from the host
scp <laptop>:ops/e2e.sh /root/e2e.sh    # or copy the file however you prefer
chmod +x /root/e2e.sh
# verify's realtime check uses the pinned helper package in ops/realtime-check/.
# A copied-alone e2e.sh finds it in the installed app ($E2E_APP_DIR/ops/realtime-check,
# default /opt/supaconsole/ops/realtime-check); copy it next to the script, or set
# E2E_REALTIME_DIR, to use another copy. verify runs `npm ci` there on first use.
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
- `verify` checks container health, the gateway table below, and a SQL → PostgREST
  round trip with the seeded anon key. Each row is checked against its allowed
  status codes; any row that does not match, any unhealthy container, or a missing
  data-path row makes `verify` exit non-zero and print `RESULT: FAIL`. A clean run
  prints `RESULT: PASS` and exits 0.
- `verify` also runs a realtime round-trip (subscribe with the anon key, insert with
  the service key, INSERT event received through the gateway) with the pinned client
  in `ops/realtime-check/` (`@supabase/supabase-js` and `ws`, exact versions, locked).
  The client sends the apikey as a websocket handshake header, never in the URL, and
  `verify` then checks that the gateway's access log contains neither key. Both count
  toward the summary.
- `E2E_BASE`, `E2E_WORKDIR`, `E2E_APP_DIR` and `E2E_REALTIME_DIR` point the script at
  another instance; the defaults are the VPS layout above.
- `delete` removes the project and counts what is left: containers, project
  directories, Docker volumes, and Docker networks, all filtered by the project's
  compose project name. Anything > 0 makes `delete` exit non-zero.

The `verify` step requires `ALLOW_REGISTRATION=true` in the unit's environment so
the second-user authorization check can register a fresh user. The shipped
`vps-setup.sh` leaves it unset (bootstrap mode is the safe default). Operators
enable it for an `e2e.sh verify` run via a systemd drop-in (creating the drop-in
adds the variable, removing it takes it back to bootstrap), and reload between
changes:

```sh
# Enable open registration for the e2e window. A drop-in file MUST name its
# section (here [Service]) for partial overrides to merge into the parent
# unit; a bare `Environment=` line without a section header is treated as a
# whole-unit replacement and silently drops everything else.
ssh root@<host> 'mkdir -p /etc/systemd/system/supaconsole.service.d && printf "[Service]\nEnvironment=ALLOW_REGISTRATION=true\n" > /etc/systemd/system/supaconsole.service.d/allow-registration.conf && systemctl daemon-reload && systemctl restart supaconsole'
# ...run ops/e2e.sh setup / deploy / verify / delete ...
# Disable:
ssh root@<host> 'rm -f /etc/systemd/system/supaconsole.service.d/allow-registration.conf && systemctl daemon-reload && systemctl restart supaconsole'
```

The drop-in survives `vps-setup.sh` re-runs: the script removes it during the
service-user step so a fresh install always starts in bootstrap mode.

### Expected gateway table (what `verify` checks)

| Request | Allowed codes |
| --- | --- |
| REST root, anon key | 403 |
| REST root, no key | 401 |
| Auth health, anon key | 200 |
| Auth admin/users, service key | 200 |
| Auth admin/users, anon key (role check) | 403 |
| Auth admin/users, forged signature | 401, 403 |
| Storage buckets, service key | 200 |
| Studio via gateway, dashboard creds | 200, 307 |
| Studio via gateway, no creds | 401 |

REST root with the anon key returns 403, not 200, because the upstream Supabase
REST service is now admin-only (Supabase discussion #42949). The forged-JWT row
accepts either 401 or 403 because upstream behaviour has been inconsistent in the
past; both prove the signature check is rejecting the forged token.

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

## Owner-only steps

`vps-setup.sh` does not install the per-user tools the owner uses for Traycer
agents. They require interactive sign-in and are run once on a fresh host as
`dev`. From an SSH session as `dev`:

```sh
# npm prefix + PATH
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
if ! grep -q '.npm-global/bin' ~/.profile; then
  printf '\nexport PATH="$HOME/.npm-global/bin:$PATH"\n' >> ~/.profile
fi
if ! grep -q '.npm-global/bin' ~/.bashrc; then
  tmp=$(mktemp)
  {
    printf 'export PATH="$HOME/.npm-global/bin:$PATH"\n'
    cat ~/.bashrc
  } > "$tmp"
  mv "$tmp" ~/.bashrc
fi
loginctl enable-linger dev

# Traycer CLI
npm i -g @traycerai/cli
traycer host service install           # installs ai.traycer.host.service as a user unit

# Claude Code + Codex (interactive sign-in)
npm i -g @anthropic-ai/claude-code
npm i -g @openai/codex
```

The `dev` user needs the same SSH public keys the root account uses so the owner
can `ssh supaconsole-preview-dev` without re-distributing keys. `vps-setup.sh`
copies `/root/.ssh/authorized_keys` into `~dev/.ssh` with mode 600 and ownership
`dev:dev`; on a host that was set up before that step ran, do it by hand:

```sh
ssh root@<host>
install -d -m 0700 -o dev -g dev /home/dev/.ssh
install -m 0600 -o dev -g dev /root/.ssh/authorized_keys /home/dev/.ssh/authorized_keys
```

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

## Shared host rules

The preview host is a shared resource: more than one agent may be deploying or
testing on it at a time, and the running state (the `supaconsole` service,
`/opt/supaconsole/prisma/supaconsole.db`, the Supabase core checkout, the live
projects under `/opt/supaconsole/supabase-projects`) is the regression baseline
for everyone. The rules below keep that baseline intact.

- **Acquire the droplet lock before any deploy/test.** Agents that need to run
  `vps-setup.sh` or apply changes to the host's running state must take
  `/root/droplet-lock/owner` first:

  ```sh
  until ssh supaconsole-preview 'mkdir /root/droplet-lock 2>/dev/null && echo <HANDLE> > /root/droplet-lock/owner'; do
    sleep 120
  done
  ```

  The lock has no timeout beyond what the holder chooses. Other agents see the
  owner file and wait their turn; a stale owner (no SSH session from that handle)
  is fair game.

- **Never reset `prisma/supaconsole.db`.** The DB carries the project's users,
  projects, and generated env vars, and the `verify` step relies on the seeded
  e2e user existing. Resetting it loses the regression baseline for every other
  agent. If you need a clean DB, take a fresh droplet.

- **Never run `vps-setup.sh` on the live preview host without the owner's
  say-so.** The script wipes `/opt/supaconsole` and re-clones from `BRANCH`. It
  is for fresh hosts and for owner-driven rebuilds; on the shared preview host,
  apply changes by hand using the same commands the script uses (or with a PR
  that lands them in `ops/` first).

- **Restore `main` and release the lock when done.** When you finish a deploy
  or test on the live host, leave `/opt/supaconsole` checked out at
  `origin/main` (`git checkout -B main origin/main` after fetching), remove any
  leftover docker containers / volumes / networks from your project, and release
  the lock with `rm -f /root/droplet-lock/owner && rmdir /root/droplet-lock` so
  the directory itself is gone (the next agent's `mkdir` only succeeds when the
  directory does not already). The host should look like a clean main build to
  the next agent.