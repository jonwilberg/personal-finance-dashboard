# Hosting

The app runs on a small Hetzner Cloud server in the EU. Only two Google accounts can open it.

```
browser ──https──▶ Cloudflare (Access: Google login, two allowed emails)
                        │  tunnel (the server connects out; no open ports)
                        ▼
              Hetzner server: Docker
                ├─ tunnel   cloudflared
                └─ app      FastAPI + built frontend, plain HTTP on :8765
                             └─ deploy/data/finance.db
              nightly: backup ──▶ Cloudflare R2 (private bucket)
              daily:   refresh-all (new transactions)
              every minute: new image from CI? verify, deploy, check health

GitHub: pull request ─▶ CI checks ─▶ merge ─▶ CI on main ─▶ image + signed attestation ─▶ ghcr.io
```

- **Access.** Cloudflare Access asks for a Google login and lets through only the emails on its policy, so who may
  use the app is decided in Cloudflare alone. The app checks Cloudflare's signed token on every request
  (`backend/src/finance/access.py`), so nothing reaches it without passing that login, even through some other way
  in. Without the Access settings, the app refuses to listen anywhere but on its own machine.
- **No open ports.** The server's firewall lets in SSH only. The app is reached only through the Cloudflare tunnel,
  which the server opens from the inside.
- **Secrets stay on the server**, in ignored files next to `deploy/compose.yaml`: `app.env`, `.env`, `backup.env`,
  `secrets/enablebanking.pem`. Nothing secret is in the image or the repo. The allowed emails live only in the
  Cloudflare Access policy, never in code.
- **Deploys.** CI (`.github/workflows/ci.yml`) runs the backend tests, the frontend build, the image build and checks
  of the deploy files on every pull request; branch protection on `main` requires them. When `main` passes, CI
  publishes the image to `ghcr.io` with a signed provenance attestation. Every minute the server's deploy timer
  (`deploy/scripts/auto-deploy.sh`) looks for a new image, verifies its attestation (built by this repository's
  `ci.yml` from `main`, on GitHub's runners), snapshots the database, and switches over. If the new version isn't
  healthy within two minutes it puts the previous image and the snapshot back. GitHub has no access to the server and
  holds no secrets: the server pulls.
- **Backups.** Every night the database is snapshotted, checked and compressed, then uploaded to a private Cloudflare
  R2 bucket. That's a different company from Hetzner. The daily copies are kept 35 days and the 1st of each month for
  about 13 months. The backups aren't encrypted, so keep the bucket private (no public access or custom domain on it)
  and protect the Cloudflare account with two-step verification. That account guards the live app too.

## One-time setup

Rough order: Cloudflare and the other accounts first, then the server, then moving the data in. Placeholders:
`finance.example.com` is your app's address, and `yourteam` is your Cloudflare Zero Trust team name.

### 1. Cloudflare: domain, Google login, Access, tunnel

1. **Domain.** Register a domain at Cloudflare, or use one from another registrar: add it to Cloudflare
   (*Add a site*, Free plan) and switch its nameservers to Cloudflare's at the registrar. Cloudflare must run the
   domain's DNS for the tunnel and Access to work. The app gets a subdomain, e.g. `finance.example.com`.
2. **Zero Trust.** Open *Zero Trust* in the Cloudflare dashboard and pick a team name. That gives you
   `yourteam.cloudflareaccess.com`. The free plan is enough.
3. **Google login.**
   1. In the [Google Cloud console](https://console.cloud.google.com/), create a project.
   2. Configure the OAuth consent screen (External; app name of your choice). While it's in *Testing*, only the
      test users you list can sign in, so either add both Google addresses as test users or publish it. Publishing
      needs no review, since Access only asks for the basic email and profile.
   3. Create an *OAuth client ID* of type *Web application*, with this authorized redirect URI:
      `https://yourteam.cloudflareaccess.com/cdn-cgi/access/callback`
   4. In Zero Trust go to *Settings → Authentication → Login methods → Add → Google*, and paste in the client ID
      and secret. Use *Test* there to check that the login works.
4. **Access application.**
   1. Go to *Access → Applications → Add → Self-hosted*.
   2. Domain: `finance.example.com`. Session duration: e.g. 1 month.
   3. Login methods: Google only, with *instant auth* on.
   4. Policy: *Allow*, rule *Emails*, listing the two Google addresses.
   5. Save, then copy the *Application Audience (AUD) Tag* from the application's overview. It goes in
      `CF_ACCESS_AUD`.
5. **Tunnel.**
   1. Go to *Networks → Tunnels → Create → Cloudflared*. Name it e.g. `finance`.
   2. From the Docker install command, copy only the token (the long string after `--token`). It goes in
      `deploy/.env`. Don't run the install command itself: the connector runs on the server, in the `tunnel`
      container. A second connector anywhere else would get some of the requests, and they would fail. If you
      did run it on your PC, remove it (`cloudflared service uninstall` in an administrator PowerShell, then
      uninstall cloudflared) and use *Rotate token*, so only the server holds a working token.
   3. Under *Routes → Add route → Published application*, set the hostname to `finance.example.com` and the
      service URL to `http://app:8765`. `app` is the app container's name on the compose network. Use plain
      `http://`, since that connection never leaves the server, and leave the path empty. The tunnel shows as
      down until the server is running.
6. **R2 bucket for backups.**
   1. Go to *R2 → Create bucket*, e.g. `finance-backups`, in the EU jurisdiction.
   2. Under *Manage API tokens*, create a token with *Object Read & Write* on that bucket only.
   3. Note the access key ID, the secret and the endpoint: `https://<account-id>.r2.cloudflarestorage.com`, or
      `https://<account-id>.eu.r2.cloudflarestorage.com` for an EU bucket. The secret is shown only once.

### 2. Enable Banking

In the [control panel](https://enablebanking.com/cp/applications), add `https://finance.example.com/callback` to
the redirect URLs of your **production** application (not the sandbox one). Keep the localhost one for running the
app locally. Bank connections belong to the application, not to its address, so the existing ones keep working on
the server. A restricted application can only read the accounts linked to it in the control panel, so link any new
bank or account there before connecting it in the app.

### 3. Hetzner server

1. In [Hetzner Cloud](https://console.hetzner.cloud/), create a project.
2. Add your **SSH public key**. Password logins get switched off.
3. Create a **firewall** with one inbound rule: TCP 22 from your home IP (or from anywhere, if your IP changes;
   SSH accepts keys only).
4. Create a **server**:
   - Location: Helsinki
   - Image: Ubuntu 24.04
   - Type: the smallest shared x86, currently **CX23** (2 vCPU, 4 GB). Hetzner raised prices in 2026, and its
     cheapest "cost-optimized" plans can't always be ordered. If CX23 isn't available, take the smallest regular
     shared plan (CPX); the app needs very little.
   - Your SSH key and the firewall attached
   - *Backups* ticked (about €1 a month)
5. Log in, make your own user and fetch the code:

   ```bash
   ssh root@<server-ip>
   adduser jon && usermod -aG sudo jon
   cp -r ~/.ssh /home/jon && chown -R jon:jon /home/jon/.ssh   # your SSH key for the new user
   mkdir -p /opt/finance && chown jon:jon /opt/finance
   exit
   ssh jon@<server-ip>
   git clone https://github.com/jonwilberg/personal-finance-dashboard.git /opt/finance
   cd /opt/finance
   sudo deploy/scripts/setup-server.sh jon
   ```

   `setup-server.sh` does the following:
   - adds a 2 GB swap file
   - installs Docker, the GitHub CLI (to verify images), automatic security updates and the backup tools
   - sets up the firewall and key-only SSH
   - sets the time zone
   - creates the settings files from their examples
   - installs the daily jobs (`deploy/cron/finance`) and the deploy timer (`deploy/systemd/`)

   Log out and back in afterwards, so you can use Docker without `sudo`.

6. Fill in the settings (`nano` or similar):
   - `deploy/app.env`:
     - the Enable Banking app ID (the production application's)
     - the public callback URL
     - `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`
   - `deploy/.env`: the tunnel token
   - `deploy/backup.env`: the R2 bucket, endpoint and token, and optionally the
     [healthchecks.io](https://healthchecks.io) ping URLs
7. Copy the production application's Enable Banking key from your PC (the file `ENABLE_BANKING_KEY_PATH` points to
   in `backend/.env.production`) and lock it down:

   ```bash
   scp C:/path/to/<application-id>.pem jon@<server-ip>:/tmp/enablebanking.pem   # from your PC
   sudo install -m 0640 -o root -g 10001 /tmp/enablebanking.pem /opt/finance/deploy/secrets/enablebanking.pem
   rm /tmp/enablebanking.pem
   ```

### 4. Move the data in

On your PC, stop the local app (Ctrl+C in its terminal). From the repo folder, take a consistent copy of the live
database and send it over:

```bash
cd backend
uv run python -c "import sqlite3; s = sqlite3.connect('data/production/finance.db'); d = sqlite3.connect('finance-move.db'); s.backup(d); d.close()"
scp finance-move.db jon@<server-ip>:/tmp/
```

On the server:

```bash
cd /opt/finance
sudo deploy/scripts/restore.sh --file /tmp/finance-move.db && rm /tmp/finance-move.db
sudo deploy/scripts/deploy.sh
```

`deploy.sh` pulls the latest image CI published from `main`, after verifying its attestation, and starts the app.
Once the containers are up, the tunnel shows as healthy in Cloudflare. From then on the deploy timer deploys every new
`main` by itself.

Delete `finance-move.db` on your PC afterwards. Then open `https://finance.example.com`, sign in with Google, and
check that the Overview looks as it did locally.

### 5. Check the backups once

```bash
sudo deploy/scripts/backup.sh        # should print "Backed up finance-<date>.db.gz"
sudo deploy/scripts/restore.sh       # puts the newest backup back, as a test
```

The restore keeps the current database aside as `finance.db.before-restore-<time>`, so the test loses nothing.

## Knowing it's up

- **In the app:** the footer of every page shows the version running, when it was deployed, and whether it's the
  latest `main` ("up to date"), or that a newer version is on its way (CI builds it and the server picks it up within
  minutes). It asks GitHub's public API for the latest `main` from your browser.
- **By email, when something's wrong:** [healthchecks.io](https://healthchecks.io) (free) emails you when a check
  reports a failure or stops reporting. Create three checks, and put their ping URLs in `deploy/backup.env`:

  | Check | Period | Grace | Setting | Emails you when |
  |---|---|---|---|---|
  | Deploys and app | 1 minute | 5 minutes | `HEALTHCHECK_DEPLOY_URL` | a deploy fails or rolls back, the app is unhealthy, the tunnel stops, or the server or its timer is down |
  | Backup | 1 day | 2 hours | `HEALTHCHECK_BACKUP_URL` | last night's backup failed or didn't run |
  | Refresh | 1 day | 2 hours | `HEALTHCHECK_REFRESH_URL` | the morning refresh failed (often an expired bank consent) or didn't run |

  The scripts add the run's exit status to the URL (`…/0` for success), which healthchecks.io understands. The server
  only calls out; nothing reaches in.

## Day to day

| What | How (on the server, in `/opt/finance`) |
|---|---|
| Deploy a change | Merge its pull request. CI publishes the image and the server deploys it within about a minute |
| Deploy the latest `main` now | `sudo deploy/scripts/deploy.sh` |
| What did the deploys do? | `journalctl -t finance-deploy --since today` (quiet when there's nothing new) |
| Pause automatic deploys | `sudo systemctl stop finance-deploy.timer` (`start` to resume) |
| Go back to the previous version | `docker tag finance-app:previous finance-app:current && docker compose -f deploy/compose.yaml up -d`, then stop the timer until `main` is fixed |
| App logs | `docker compose -f deploy/compose.yaml logs --tail 100 app` |
| Did this morning's refresh work? | `journalctl -t finance-refresh --since today` |
| Did last night's backup work? | `journalctl -t finance-backup --since yesterday` |
| Refresh now | `deploy/scripts/refresh.sh` |
| Restore a backup | `sudo deploy/scripts/restore.sh [finance-YYYY-MM-DD.db.gz]` (default: the newest) |
| Restart | `docker compose -f deploy/compose.yaml restart` |

- **Bank consents** last up to about 180 days. When one expires, the morning refresh reports
  "consent expired" (and the healthchecks ping turns red, if set up). Reconnect the bank from the app's Accounts page.
- **Running locally** works as before (`uv run finance --env production serve`, against `backend/data/production`).
  That's a separate copy, though: once the server is live, change data on the server only, or the two drift apart.
  Refreshing locally also uses up the banks' few fetches a day.
- **Updates to the server itself** install automatically. It reboots at 04:00 when an update needs it, and the
  containers start again on their own.
