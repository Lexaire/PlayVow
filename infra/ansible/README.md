# PlayVow infrastructure (Ansible)

Provisions a fresh Ubuntu VPS into a hardened host that runs the PlayVow
TanStack Start app directly under `systemd`, fronted by Caddy. No Docker.

## What it does

1. **Bootstrap** — creates a `deploy` user with sudo + your SSH key (one-time, run as root).
2. **Harden** — applies [`konstruktoid.hardening`](https://github.com/konstruktoid/ansible-role-hardening) baseline (SSH lockdown, UFW, sysctl, auditd, etc.).
3. **Runtime** — installs Node.js (NodeSource LTS) and Caddy (cloudsmith repo), drops the `Caddyfile`, starts Caddy.
4. **Deploy scaffolding** — creates `/opt/playvow/{releases,shared}`, installs the `playvow-web.service` and `playvow-worker.service` systemd units, and seeds `shared/.env`.
5. **Backup** — installs `rclone` + a 2-hourly `playvow-backup.timer` that snapshots the libSQL embedded replica and uploads it to a Backblaze B2 bucket. See [Database backups](#database-backups) below.

Code releases themselves are shipped by [`infra/deploy.sh`](../deploy.sh) (or `make deploy` from the repo root) — rsync to a timestamped release dir, flip the `current` symlink, restart both units.

## Prerequisites

```sh
pipx install ansible-core ansible-lint
```

Then install the third-party roles & collections:

```sh
cd infra/ansible
ansible-galaxy install -r requirements.yml
ansible-galaxy collection install -r requirements.yml
```

## Configure

The repo only commits templates. Copy each one to its real (gitignored)
counterpart and fill in your values:

```sh
cp inventory/production.example.yml             inventory/production.yml
cp inventory/group_vars/all/local.example.yml   inventory/group_vars/all/local.yml
```

1. Edit [`inventory/production.yml`](inventory/production.yml) — set `ansible_host` to the VPS IP.
2. Edit [`inventory/group_vars/all/local.yml`](inventory/group_vars/all/local.yml) — paste your SSH public key into `deploy_authorized_key`. Ansible auto-loads every YAML in `group_vars/all/`, so `local.yml` merges with the committed [`vars.yml`](inventory/group_vars/all/vars.yml) at runtime.
3. Edit [`inventory/group_vars/all/vars.yml`](inventory/group_vars/all/vars.yml) — set `app_domain`. Other knobs (hardening overrides, backup config) have sane defaults.
4. For secrets (Backblaze B2 keys, healthchecks URL), create the vault:
   ```sh
   echo 'your-vault-password' > .vault_pass && chmod 600 .vault_pass
   ansible-vault create inventory/group_vars/all/vault.yml
   ```
   See [`vault.example.yml`](inventory/group_vars/all/vault.example.yml) for the expected keys. The vault password file `.vault_pass` is already wired into [`ansible.cfg`](ansible.cfg).

## Run

**One-time bootstrap** (connects as root, creates the `deploy` user):

```sh
ansible-playbook playbooks/bootstrap.yml -u root -e ansible_user=root
```

**Provision** (idempotent — re-run any time):

```sh
ansible-playbook playbooks/site.yml
```

Or run individual stages:

```sh
ansible-playbook playbooks/harden.yml
ansible-playbook playbooks/runtime.yml
ansible-playbook playbooks/deploy.yml
ansible-playbook playbooks/backup.yml
```

## Production secrets

Create `infra/.env.production` on your laptop with the real values for every
key in [`.env.example`](../../.env.example). It's gitignored. `infra/deploy.sh`
`scp`s it to `/opt/playvow/shared/.env` (mode `0600`, owned by `deploy`) on
every release, so rotating a secret is just an edit + redeploy.

Override the path with `PLAYVOW_ENV_FILE=/somewhere/else.env` if you want it
outside the repo (e.g. in `~/.config/playvow/`).

## Ship a release

From the repo root on your laptop:

```sh
make deploy                                  # uses defaults from infra/deploy.sh
PLAYVOW_HOST=deploy@<vps-ip> make deploy     # override the SSH target
make deploy-check                            # preflight only (no build, no ship)
```

`make deploy` shells out to [`infra/deploy.sh`](../deploy.sh), which:

1. **Preflights** — verifies `bun`, `ssh`, `scp`, `rsync` are installed; that
   `infra/.env.production` exists with every key from `.env.example` populated;
   that the SSH target is reachable without a password prompt; and that the
   on-host layout + systemd units are in place. Each failure prints a remedial
   command (e.g. _"run `ansible-playbook playbooks/site.yml`"_).
2. **Builds** — `bun install --frozen-lockfile` + `bun run build` (which now
   produces both `.output/server/index.mjs` and `.output/server/worker.mjs`).
3. **Ships** — rsyncs `.output/` to `/opt/playvow/releases/<timestamp>/`,
   uploads `infra/.env.production` atomically to `/opt/playvow/shared/.env`.
4. **Activates** — flips the `/opt/playvow/current` symlink, restarts
   `playvow-web.service` + `playvow-worker.service`, waits 2s, and bails out
   if either unit isn't `is-active` (with a hint to `journalctl` and how to
   roll back).

## Database backups

`playbooks/backup.yml` installs a 2-hourly snapshot pipeline: `sqlite3 .backup`
on `/opt/playvow/shared/web-replica.db` → zstd → `rclone` PUT to a Backblaze
B2 bucket. The timer stays disabled until B2 credentials are filled in.

**One-time bucket setup** (Backblaze console):

1. Create B2 bucket `playvow-db-backups`: Files in Bucket = **Private**;
   Object Lock = **Enabled**; Default Retention = **Compliance, 30 days**.
   Object Lock can ONLY be set at bucket creation, so get this right the
   first time.
2. Add a Lifecycle Rule giving the desired net TTL (currently configured
   for ~62 days; e.g. uploading→hiding = 61 + hiding→deleting = 1). The
   30-day Compliance retention always expires before lifecycle deletes,
   so the engine is allowed to clean up. The B2 console is the source of
   truth for the exact breakdown.
3. Create an Application Key: Bucket = this one only. Capabilities =
   `listFiles`, `readFiles`, `writeFiles`. **Do NOT enable `deleteFiles`
   or `bypassGovernance`.** This way the on-host credential lacks the
   delete capability entirely — defense in depth on top of Object Lock.
   Save the keyID and the applicationKey.

**Wire credentials into Ansible:**

```sh
ansible-vault edit inventory/group_vars/all/vault.yml
# fill in vault_b2_application_key_id, vault_b2_application_key
ansible-playbook playbooks/backup.yml
```

**Operate:**

```sh
ssh deploy@<vps-ip> 'systemctl list-timers playvow-backup.timer --no-pager'
ssh deploy@<vps-ip> 'sudo systemctl start playvow-backup.service'   # run now
ssh deploy@<vps-ip> 'journalctl -u playvow-backup -n 50 --no-pager'

# List backups
ssh deploy@<vps-ip> 'rclone --config /opt/playvow/shared/.backup/rclone.conf ls b2:playvow-db-backups'

# Restore + verify a specific snapshot (does NOT touch live DB)
ssh deploy@<vps-ip> 'playvow-restore 2026/04/2026-04-28T15-00-00Z.db.zst'
```

**Failure alerting (healthchecks.io):**

The script pings a healthchecks.io URL at `/start`, on success, and `/fail`.
If pings stop arriving, healthchecks.io alerts you via your configured
notification channel (email/Slack/etc.) — a deadman's switch for silent
backup outages.

1. Sign up at <https://healthchecks.io> (free tier covers 20 checks).
2. Create a check: name "playvow backup", schedule = cron `0 * * * *`,
   grace = 10 minutes (covers the 5-minute timer jitter + job runtime).
3. Add a notification channel (email is fine; Slack/Discord/Pushover work too).
4. Copy the ping URL (`https://hc-ping.com/<uuid>`) and paste it into vault:
   ```sh
   ansible-vault edit inventory/group_vars/all/vault.yml
   # set vault_healthchecks_backup_url: 'https://hc-ping.com/<uuid>'
   ansible-playbook playbooks/backup.yml
   ```
5. Trigger one backup manually and confirm the check shows "up" in the
   healthchecks.io dashboard:
   ```sh
   ssh deploy@<vps-ip> 'sudo systemctl start playvow-backup.service'
   ```

Leaving `vault_healthchecks_backup_url` empty disables pinging — useful for
local/test runs.

## Verify

```sh
ansible-playbook playbooks/site.yml --syntax-check
ansible-lint playbooks/
ssh deploy@<vps-ip> 'systemctl status playvow-web playvow-worker --no-pager'
ssh deploy@<vps-ip> 'journalctl -u playvow-web -u playvow-worker -n 50 --no-pager'
ssh deploy@<vps-ip> 'ls -lt /opt/playvow/releases | head'
curl -I https://<app_domain>
```

## Layout

```
infra/
├── deploy.sh                      # local build → rsync → flip symlink → restart
└── ansible/
    ├── ansible.cfg
    ├── requirements.yml           # External roles & collections
    ├── inventory/
    │   ├── production.yml
    │   ├── group_vars/all/        # vars.yml (public) + vault.yml (secrets stub)
    │   └── host_vars/playvow-prod.yml
    ├── playbooks/                 # bootstrap → harden → runtime → deploy
    └── files/
        ├── caddy/Caddyfile                  # /etc/caddy/Caddyfile
        ├── backup/
        │   ├── playvow-backup.sh            # /usr/local/bin/playvow-backup
        │   └── playvow-restore.sh           # /usr/local/bin/playvow-restore
        └── systemd/
            ├── playvow-web.service          # /etc/systemd/system/playvow-web.service
            ├── playvow-worker.service       # /etc/systemd/system/playvow-worker.service
            ├── playvow-backup.service       # /etc/systemd/system/playvow-backup.service
            └── playvow-backup.timer         # /etc/systemd/system/playvow-backup.timer
```

## On-host layout (what `deploy.sh` writes)

```
/opt/playvow/
├── current -> releases/20260425T004237Z   # symlink, atomically swapped
├── releases/
│   ├── 20260425T004237Z/.output/server/   # current — index.mjs + worker.mjs share node_modules/
│   └── 20260424T231104Z/.output/          # previous (kept for quick rollback)
└── shared/
    └── .env                                # persists across releases
```

Both systemd units run from the same release tree:

- `playvow-web.service` → `node .output/server/index.mjs` (Nitro server)
- `playvow-worker.service` → `node .output/server/worker.mjs` (cron-driven scrape + playtime poll)

Rolling back:

```sh
ssh deploy@<vps-ip>
ln -sfn /opt/playvow/releases/<older-id> /opt/playvow/current
sudo systemctl restart playvow-web playvow-worker
```
