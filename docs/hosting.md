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
              nightly: encrypted backup ──▶ Cloudflare R2
              daily:   refresh-all (new transactions)
```

- **Access.** Cloudflare Access asks for a Google login and lets through only the emails on its policy. The app then
  checks Cloudflare's signed token on every request itself (`backend/src/finance/access.py`), against its own list
  (`FINANCE_ALLOWED_EMAILS`). So a mistake in the Cloudflare settings doesn't open the door. Without those settings,
  the app refuses to listen anywhere but on its own machine.
- **No open ports.** The server's firewall lets in SSH only. The app is reached only through the Cloudflare tunnel,
  which the server opens from the inside.
- **Secrets stay on the server**, in ignored files next to `deploy/compose.yaml`: `app.env`, `.env`, `backup.env`,
  `secrets/enablebanking.pem`. Nothing secret is in the image or the repo. The allowed emails live in `app.env`,
  never in code.
- **Backups.** Every night the database is snapshotted, checked, compressed and encrypted *on the server*, then
  uploaded to Cloudflare R2. That's a different company from Hetzner. The daily copies are kept 35 days and the 1st of
  each month for about 13 months. Only your private age key, kept off the server, can read them.

## One-time setup

Rough order: Cloudflare and the other accounts first, then the server, then moving the data in. Placeholders:
`finance.example.com` is your app's address, and `yourteam` is your Cloudflare Zero Trust team name.

### 1. Cloudflare: domain, Google login, Access, tunnel

1. **Domain.** Register a domain at Cloudflare (or move one there). The app gets a subdomain, e.g.
   `finance.example.com`.
2. **Zero Trust.** Open *Zero Trust* in the Cloudflare dashboard and pick a team name. That gives you
   `yourteam.cloudflareaccess.com`. The free plan is enough.
3. **Google login.**
   1. In the [Google Cloud console](https://console.cloud.google.com/), create a project.
   2. Configure the OAuth consent screen (External; app name of your choice).
   3. Create an *OAuth client ID* of type *Web application*, with this authorized redirect URI:
      `https://yourteam.cloudflareaccess.com/cdn-cgi/access/callback`
   4. In Zero Trust go to *Settings → Authentication → Login methods → Add → Google*, and paste in the client ID
      and secret.
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
      container. A second connector anywhere else would get some of the requests, and they would fail.
   3. Under *Routes → Add route → Published application*, set the hostname to `finance.example.com` and the
      service URL to `http://app:8765`. `app` is the app container's name on the compose network. Use plain
      `http://`, since that connection never leaves the server, and leave the path empty. The tunnel shows as
      down until the server is running.
6. **R2 bucket for backups.**
   1. Go to *R2 → Create bucket*, e.g. `finance-backups`, in the EU jurisdiction.
   2. Under *Manage API tokens*, create a token with *Object Read & Write* on that bucket only.
   3. Note the access key ID, the secret and the endpoint (`https://<account-id>.r2.cloudflarestorage.com`, or the
      `eu.` variant for an EU bucket).

### 2. Backup key (on your PC)

Install [age](https://github.com/FiloSottile/age) and make a key pair:

```bash
age-keygen -o finance-backup.key
```

It prints the public key (`age1…`), which goes in `BACKUP_AGE_RECIPIENT` on the server. Keep `finance-backup.key`
in your password manager and **not** on the server. Without it, the backups can't be read, by anyone, including you.

### 3. Enable Banking

In the [control panel](https://enablebanking.com/cp/applications), add `https://finance.example.com/callback` to
the application's redirect URLs. Keep the localhost one for running the app locally. Bank connections belong to the
application, not to its address, so the existing ones keep working on the server.

### 4. Hetzner server

1. In [Hetzner Cloud](https://console.hetzner.cloud/), create a project.
2. Add your **SSH public key**. Password logins get switched off.
3. Create a **firewall** with one inbound rule: TCP 22 from your home IP (or from anywhere, if your IP changes;
   SSH accepts keys only).
4. Create a **server**:
   - Location: Helsinki
   - Image: Ubuntu 24.04
   - Type: the smallest shared x86 (CX22)
   - Your SSH key and the firewall attached
   - *Backups* ticked (about €1 a month)
5. Log in, make your own user and fetch the code:

   ```bash
   ssh root@<server-ip>
   adduser jon && usermod -aG sudo jon
   rsync --archive --chown=jon:jon ~/.ssh /home/jon   # your SSH key for the new user
   mkdir -p /opt/finance && chown jon:jon /opt/finance
   exit
   ssh jon@<server-ip>
   git clone https://github.com/jonwilberg/personal-finance-dashboard.git /opt/finance
   cd /opt/finance
   sudo deploy/scripts/setup-server.sh jon
   ```

   `setup-server.sh` does the following:
   - installs Docker, automatic security updates and the backup tools
   - sets up the firewall and key-only SSH
   - sets the time zone
   - creates the settings files from their examples
   - installs the daily jobs (`deploy/cron/finance`)

   Log out and back in afterwards, so you can use Docker without `sudo`.

6. Fill in the settings (`nano` or similar):
   - `deploy/app.env`:
     - the Enable Banking app ID
     - the public callback URL
     - `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`
     - `FINANCE_ALLOWED_EMAILS`, the two Google addresses, comma-separated
   - `deploy/.env`: the tunnel token
   - `deploy/backup.env`: the age public key, the R2 bucket, endpoint and token, and optionally the
     [healthchecks.io](https://healthchecks.io) ping URLs
7. Copy the Enable Banking key from your PC and lock it down:

   ```bash
   scp C:/path/to/<application-id>.pem jon@<server-ip>:/tmp/enablebanking.pem   # from your PC
   sudo install -m 0640 -o root -g 10001 /tmp/enablebanking.pem /opt/finance/deploy/secrets/enablebanking.pem
   rm /tmp/enablebanking.pem
   ```

### 5. Move the data in

On your PC, stop the local app (Ctrl+C in its terminal). Take a consistent copy of the live database and send it
over:

```bash
cd backend
uv run python -c "import sqlite3; s = sqlite3.connect('data/production/finance.db'); d = sqlite3.connect('finance-move.db'); s.backup(d); d.close()"
scp finance-move.db jon@<server-ip>:/tmp/
```

On the server:

```bash
cd /opt/finance
sudo deploy/scripts/restore.sh --file /tmp/finance-move.db && rm /tmp/finance-move.db
deploy/scripts/deploy.sh
```

Delete `finance-move.db` on your PC afterwards. Then open `https://finance.example.com`, sign in with Google, and
check that the Overview looks as it did locally.

### 6. Check the backups once

```bash
sudo deploy/scripts/backup.sh        # should print "Backed up finance-<date>.db.gz.age"
```

To try a restore, copy your `finance-backup.key` to the server for the duration only and run
`sudo deploy/scripts/restore.sh ~/finance-backup.key`. It keeps the current database aside as
`finance.db.before-restore-<time>`. Delete the key from the server afterwards.

## Day to day

| What | How (on the server, in `/opt/finance`) |
|---|---|
| Deploy the latest `main` | `deploy/scripts/deploy.sh` |
| App logs | `docker compose -f deploy/compose.yaml logs --tail 100 app` |
| Did this morning's refresh work? | `journalctl -t finance-refresh --since today` |
| Did last night's backup work? | `journalctl -t finance-backup --since yesterday` |
| Refresh now | `deploy/scripts/refresh.sh` |
| Restore a backup | `sudo deploy/scripts/restore.sh <key file> [finance-YYYY-MM-DD.db.gz.age]` |
| Restart | `docker compose -f deploy/compose.yaml restart` |

- **Bank consents** last up to about 180 days. When one expires, the morning refresh reports
  "consent expired" (and the healthchecks ping turns red, if set up). Reconnect the bank from the app's Accounts page.
- **Running locally** works as before (`uv run finance --env production serve`, against `backend/data/production`).
  That's a separate copy, though: once the server is live, change data on the server only, or the two drift apart.
- **Updates to the server itself** install automatically. It reboots at 04:00 when an update needs it, and the
  containers start again on their own.
