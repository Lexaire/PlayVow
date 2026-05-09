# PlayVow

Tracks whether [SteamGifts](https://www.steamgifts.com/) group giveaway winners actually play the games they win.

## What it is

Some SteamGifts groups (taleplay, Playing Appreciated, …) have a "play within N days" rule. Enforcing that rule is currently a manual, per-mod chore: scrape the group's wins page, click into each winner's Steam profile, eyeball their playtime, then mark them played / kicked / exempt by hand.

PlayVow is the dashboard that does steps 1–3 automatically and gives mods a one-click UI for step 4.

- Daily scrape of each group's SteamGifts wins page.
- Hourly playtime poll against the Steam Web API for every pending win.
- An immutable `playtime_at_win` baseline captured on the first poll after a win, so "owned and played before winning" is distinguishable from "actually played the gift."
- Mod actions (`mark played` / `kick` / `exempt` / notes) write to an append-only audit log in the same DB transaction.
- Steam OpenID sign-in for users; admins can assign staff roles from the user admin UI.

Steam playtime, review presence, and screenshot count are surfaced as **evidence** in the UI but never auto-flip a win's status — mods are the only source of "played" truth.

## Stack

| Layer        | Choice                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime      | [Bun](https://bun.sh/)                                                                                                                                                     |
| Framework    | [TanStack Start](https://tanstack.com/start) (SSR + Nitro server bundle)                                                                                                   |
| Frontend     | React 19, Tailwind 4, Recharts                                                                                                                                             |
| DB           | [Turso](https://turso.tech/) (libSQL) via [Drizzle](https://orm.drizzle.team/) — free tier, embedded replica in production                                                 |
| Scheduling   | [Croner](https://github.com/Hexagon/croner) inside a long-running worker process                                                                                           |
| Tests        | [Vitest](https://vitest.dev/), fixture-driven for external clients                                                                                                         |
| Lint/format  | [oxlint](https://oxc.rs/) + [oxfmt](https://oxc.rs/)                                                                                                                       |
| Hosting      | 1 GB [RackNerd](https://www.racknerd.com/) VPS, [Caddy](https://caddyserver.com/) reverse proxy, three `systemd` units (`playvow-web`, `playvow-worker`, `playvow-backup`) |
| Backups      | 2-hourly SQLite snapshot to [Backblaze B2](https://www.backblaze.com/cloud-storage), driven by `playvow-backup.timer`                                                      |
| Monitoring   | [healthchecks.io](https://healthchecks.io/) pings from the worker and the backup unit                                                                                      |
| Provisioning | Ansible (see [`infra/ansible/`](infra/ansible/))                                                                                                                           |

## Project layout

```
src/
├── routes/         TanStack Start file-based routes (public, /mod/*, /admin/*, /auth/*)
├── server/         server functions (queries, auth, mod/admin handlers)
├── db/             Drizzle schema, migrations, client wrappers, seed scripts
├── repos/          per-entity repository modules (groups, wins, giveaways, …)
├── domain/         pure domain logic (status transitions, audit payloads, win helpers)
├── external/       Steam Web API + Steam Community HTML + SteamGifts HTML clients (with HTML/JSON fixtures)
├── worker/         cron-driven background process (scrape, poll, sync app details)
├── scripts/        one-shot CLI entry points (scrape-once, poll-once, smoke-verify)
├── lib/            small utilities (logger, rate limiter, Result type, TTL cache)
└── components/     React components

infra/
├── ansible/        VPS bootstrap + hardening + runtime + backup playbooks
└── deploy.sh       rsync-based release flip + systemd restart
```

## Getting started

Prereqs: [Bun](https://bun.sh/) and [mise](https://mise.jdx.dev/) (used to pin Node/Bun versions).

```sh
mise install                # installs Bun + Node from mise.toml
bun install
cp .env.example .env        # then edit .env — see "Environment" below
bun run db:migrate
bun run db:seed             # inserts the taleplay group row
bun run dev                 # http://localhost:3000
```

## Try it in GitHub Codespaces

You can preview PlayVow in a browser without installing anything locally or using production secrets:

1. Open the repository on GitHub.
2. Choose **Code → Codespaces → Create codespace**.
3. Wait for setup to finish.
4. Open the forwarded **PlayVow** port.

The Codespace installs the pinned tools with `mise`, runs `bun install`, creates `.env` from `.env.example`, migrates a local `local.db`, seeds fake data, and starts the dev server on port `3000`. This is meant for UI and workflow previews, such as changing homepage buttons or table copy with GitHub Copilot and seeing the result immediately.

The demo environment is local-only. It does not connect to Turso, Steam, SteamGifts, PostHog, or the VPS.

In a separate terminal, run the worker (cron-driven scraping + polling):

```sh
bun run worker
```

Or trigger one-shot variants without waiting for the cron:

```sh
bun run scrape:once taleplay
bun run poll:once
bun run smoke:verify
```

## Environment

All env keys are documented inline in [`.env.example`](.env.example). The notable ones:

- `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — remote libSQL endpoint.
- `DB_MODE` — `local` (file-only, dev), `remote` (direct Turso, slower reads), or `replica` (embedded replica synced from Turso, fast reads).
- `ENCRYPTION_KEY` — 32+ char symmetric key used to encrypt SteamGifts cookies at rest. Generate with `openssl rand -hex 32`.
- `STEAM_WEB_API_KEY` — get one at <https://steamcommunity.com/dev/apikey>.
- `STEAM_OPENID_REALM` — origin used for the OpenID return URL. `http://localhost:3000` for dev.
- `SG_COOKIE` — authenticated SteamGifts session cookie used by the scraper. Copy from a logged-in browser session.
- `ADMIN_STEAM_IDS` — comma-separated SteamID64s auto-elevated to `admin` on first sign-in.

## Database modes

The libSQL client supports three connection styles, selected via `DB_MODE`:

| Mode      | Use for                                | Notes                                                                                                                                   |
| --------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `local`   | Dev, tests                             | Pure SQLite file. No network.                                                                                                           |
| `remote`  | Worker in prod, local CLI against prod | Every read is a network round-trip. Safe for concurrent writers.                                                                        |
| `replica` | Web in prod                            | Embedded replica synced from Turso. Reads are local (sub-ms); writes go through a separate `dbWrite` client to avoid racing the syncer. |

In production the web service uses `replica` and the worker uses `remote` — set per-service via `Environment=` in their respective systemd units.

## Tests

```sh
bun run test          # vitest run, all suites
bun run typecheck     # tsgo --noEmit (TypeScript 7 native preview)
bun run lint          # oxlint
bun run format        # oxfmt --check
bun run check         # oxfmt + oxlint --fix
```

External clients (Steam Web API, Steam Community HTML, SteamGifts HTML) are tested against captured fixtures in [`src/external/__fixtures__/`](src/external/__fixtures__/) — the tests never hit the live network.

## Production deployment

End-to-end VPS provisioning lives in [`infra/ansible/README.md`](infra/ansible/README.md). The short version:

1. Provision a fresh Ubuntu VPS, point DNS at it.
2. Copy `inventory/production.example.yml` → `production.yml`, fill in the IP. Same for `local.example.yml`.
3. `ansible-playbook playbooks/bootstrap.yml -u root` (creates `deploy` user).
4. `ansible-playbook playbooks/site.yml` (hardens host, installs Caddy + Node, drops the three systemd units, sets up Backblaze B2 backups + healthchecks.io pings).
5. From [`infra/`](infra/): `make deploy` — builds, rsyncs to a timestamped release dir, flips the `current` symlink, restarts `playvow-web` + `playvow-worker`.

## License

[GNU AGPL v3.0 or later](LICENSE).

If you run a modified version of PlayVow as a network service, you must offer your modifications' source to the users of that service.

Copyright © 2026 PlayVow Contributors.
