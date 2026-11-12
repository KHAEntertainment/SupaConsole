<div align="center">

[![SupaConsole](https://ascii.rest/banner/SupaConsole.svg?color=3fb950&font=tall&shadow=heavy&size=l)](https://ascii.rest/banner/)

### Throwaway Supabase backends for every pull request

**Send it your `supabase/` folder, and SupaConsole provisions an isolated Supabase backend for each branch, migrations, seed data, and edge functions included.**

[![License](https://img.shields.io/github/license/KHAEntertainment/SupaConsole)](LICENSE) [![Built with Showrunner](https://svg.khaentertainment.com/badge.svg?theme=midnight&anim=both&project=KHAEntertainment/SupaConsole)](https://svg.khaentertainment.com/go?project=KHAEntertainment/SupaConsole)

[Try it](#try-it) | [Preview environments](#preview-environments) | [What it does](#the-solution) | [Credits](#credits)

</div>

## The problem

You let agents work on a self-hosted Supabase app, and several pull requests come back at once, each one touching the database schema. Point them all at a single staging backend and their migrations overwrite each other, so the first to merge breaks the rest. You either merge blind or serialize the PRs one at a time.

The Supabase CLI's `start` gives you a stack, but it's a development-grade one, and it doesn't match the trimmed topology you run in production.

## The solution

SupaConsole turns a branch into a disposable environment. Send it the `supabase/` folder, and it provisions an isolated stack, applies the migrations and seed, and hands back a URL and an anon key you can give a client. Calls are keyed by repository and branch: repeating `ensure` for the same branch returns the existing environment and doesn't read the new bundle, so a new commit doesn't update it yet (that comes with the GitHub Action, Phase 5). Destroy it and the whole stack goes with it.

Isolation is the point, so each preview gets its own Postgres, not a shared cluster. The bundle is untrusted code, so a path that escapes the project directory or a hardlink is rejected, and setuid, setgid, and sticky bits are stripped before files are written. Preview tokens are hashed at rest and scoped to one repository.

A trimmed preview (db, Envoy, auth, rest, realtime, storage, imgproxy, functions) idled at about 630 MiB in a one-off `docker stats` reading on the 4 vCPU / 8 GB test droplet, versus roughly 1.15 to 1.26 GiB for the full upstream stack. Treat these as observed estimates, not a benchmark.

It's also still the tool it was forked from: a dashboard that creates and manages long-lived Supabase projects.

## Try it

You need Node.js 20+, Docker with Compose, and git. SMTP is only for password-reset emails.

1. Clone and install:

   ```bash
   git clone https://github.com/KHAEntertainment/SupaConsole.git
   cd SupaConsole
   npm install
   ```

2. Copy the config and set a secret:

   ```bash
   cp .env.example .env
   ```

   Set `NEXTAUTH_SECRET` to a random string. Also change `DATABASE_URL`: the default (`file:/app/data/db.sqlite`) is a path inside the container. Running on your host, use something writable like `file:./dev.db`, which resolves to `prisma/dev.db`. The other defaults work for a first run.

3. Set up the database and start:

   ```bash
   npm run db:migrate
   npm run dev
   ```

4. Open http://localhost:3000, register the first account, and click Initialize to clone the pinned Supabase release.

Registration starts in bootstrap mode, so only the first user can sign up unless you set `ALLOW_REGISTRATION=true`.

## Preview environments

The preview flow is three calls, all authenticated with a scoped token:

- `ensure` takes the `supabase/` bundle and returns an operation id. The worker extracts it, provisions a stack bound to loopback, applies migrations and seed, waits for real health (gateway, auth, a REST query, a realtime round-trip), then adds a Cloudflare tunnel route. The health probe targets `127.0.0.1`, so it works when SupaConsole runs on the same host as the previews. In the [Dokploy container deployment](DOKPLOY_SETUP.md), `127.0.0.1` is the container itself and the gate fails, so previews aren't supported there yet.
- `status` reports the state and, once ready, the HTTPS hostname and anon key.
- `destroy` removes the route and tears down every container, volume, and directory.

> **Work in progress.** The provisioning engine, real health checks, scoped token auth, bundle ingest, migration import, and the `ensure`/`status`/`destroy` API are built and merged. The Cloudflare tunnel adapter that gives each preview its HTTPS hostname is merged, with its worker wiring in review. Next up: a GitHub Action that calls these on PR open and close (Phase 5), frontend coupling (Phase 6), and hardening (Phase 7). The first production app hasn't been onboarded; `fixtures/preview-sample` is the stand-in demo.

## Want the details?

- [`DOKPLOY_SETUP.md`](DOKPLOY_SETUP.md) deploys the control plane on Dokploy.
- [`fixtures/preview-sample/`](fixtures/preview-sample/) is the synthetic Supabase app used to exercise the preview flow.
- [`ops/`](ops/README.md) has the VPS setup and end-to-end regression scripts.
- The phased plan lives in the project's planning artifacts, not this repo.

## Credits

SupaConsole is a fork of [sharonpraju/SupaConsole](https://github.com/sharonpraju/SupaConsole), detached from the fork network. The preview-environments work builds on Supabase's self-hosted Docker tooling (Apache-2.0).

## License

[MIT](LICENSE). Upstream declared MIT but never shipped a LICENSE file; this fork carries it over with the original author's notice preserved.
