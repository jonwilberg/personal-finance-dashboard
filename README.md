# personal-finance-dashboard

[![CI](https://github.com/jonwilberg/personal-finance-dashboard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jonwilberg/personal-finance-dashboard/actions/workflows/ci.yml?query=branch%3Amain)
[![App health](https://healthchecks.io/badge/e8a4d710-d6b0-4bf7-9742-a7bca8/dKQ1pfKY-2/wilberg-finance.svg)](docs/hosting.md#knowing-its-up)

Personal finance app that pulls bank transactions via the Enable Banking API, automatically categorizes spending, and shows clear statistics on where your money goes.

- `backend/`: Python (uv). Enable Banking client, FastAPI web app and the `finance` CLI.
- `frontend/`: React + TypeScript (Vite), served by the backend once built.
- `docs/design.md`: the visual design ("Editorial paper"). Tokens are in `frontend/src/theme.css`.

Bank access is read-only (Account Information). The app can't initiate payments.

## Setup

1. **Install tools:** [uv](https://docs.astral.sh/uv/) (`winget install astral-sh.uv`) and Node.js LTS
   (`winget install OpenJS.NodeJS.LTS`). Restart your terminal so both are on `PATH`.
2. **Install dependencies and build the frontend:**
   ```bash
   cd backend && uv sync
   cd ../frontend && npm install && npm run build
   ```
3. **Register an Enable Banking application** at <https://enablebanking.com/cp/applications> and let the
   browser generate the private key. Move the downloaded `<application-id>.pem` outside the repo,
   e.g. `~/.enablebanking/`.
   - **Sandbox** (test banks): redirect URL `http://localhost:8765/callback`. Configure it in `backend/.env`.
   - **Production** (your own accounts): redirect URL `https://localhost:8765/callback` (production only accepts
     https). Fill in privacy and terms URLs, then click **"Activate by linking accounts"** and link every account
     you want to use. This is restricted mode for non-commercial use, and only linked accounts return data.
     Configure it in `backend/.env.production`.

   Create the config files from [`backend/.env.example`](backend/.env.example). They are git-ignored.

## Running the web app

```bash
cd backend
uv run finance --env production serve    # or just `uv run finance serve` for the sandbox
```

Open <https://localhost:8765/>. The app uses a self-signed certificate for `localhost` (stored in `backend/data/`),
so the first time your browser warns: choose **Advanced → Proceed to localhost**. Then:

1. **Connect a bank:** pick the bank, click Connect, log in at the bank and approve. The bank redirects back to
   `/callback`, and the connection appears in the list.
2. **Refresh all** (top right of Accounts) gets every account’s balance and as much transaction history as the bank
   allows, keeping older history it already has. Hover the last-refreshed time to see each account. Many banks allow
   only about 4 fetches per account per day.
3. **Transactions** groups uncategorized payments by payee; pick a category once and save it as a rule.
4. **Categories** lets you rename, add and delete categories, set their type (spending, income, saving, loan) and
   mark costs as fixed or adjustable. The defaults follow SSB's consumption groups and SIFO's reference budget
   (see `backend/src/finance/categories.py`).
5. **Whose accounts:** under People on Accounts, add the people in the household; then mark each account as one
   person’s or Shared (the default). On Overview, switch each person and Shared in or out to see just those
   accounts. Money moved between any two of your accounts is a transfer, never spending or income, whoever they
   belong to.
6. **Recurring payments** on Overview lists what's paid about once a month (rent, subscriptions, insurance, power)
   with each one's usual month, and flags new payees, changed amounts and stopped ones. Open a row and choose
   **Not a recurring payment** for one that only looks regular, such as a card bill. How payments are matched is in
   [`recurring.py`](backend/src/finance/recurring.py).

Everything the app stores lives in a SQLite database, `backend/data/finance.db` (`backend/data/production/finance.db`
for production). That includes bank connections, accounts, balances, raw transactions as the banks sent them, and
your category choices and rules. The schema is in [`storage.py`](backend/src/finance/storage.py). The data folder is
git-ignored, so back it up by copying `finance.db` while the app is stopped. Data from older versions, which used JSON
files, is imported on first start and the old files are moved to `json-backup/`.

## CLI

The same features are available from `backend/` without the web app:

```bash
uv run finance --env production app                        # check credentials, environment, redirect URLs
uv run finance --env production banks --country NO         # list banks
uv run finance --env production connect --bank "DNB" --country NO --days 180
uv run finance --env production accounts                   # accounts and balances
uv run finance --env production transactions <account-uid> --longest
uv run finance --env production inspect <account-uid>      # field coverage only
uv run finance --env production disconnect <session-id>    # revoke a consent
uv run finance --env production refresh-all                # fetch new transactions for every account
```

With an `https` redirect URL, `connect` asks you to paste the URL the bank redirects to. The web app avoids this.

## Hosting

The app is hosted on a small Hetzner server behind Cloudflare Access (Google login, two allowed accounts), with a
daily refresh and nightly backups to Cloudflare R2. CI checks every pull request; each merge to `main` is published
as an image with a signed attestation, which the server verifies and deploys by itself. Setup and day-to-day commands are in [docs/hosting.md](docs/hosting.md);
the server files are in [`deploy/`](deploy/).

## Development

```bash
cd backend && uv run pytest                      # backend tests
uv run finance --env production serve            # API on https://localhost:8765
```

For frontend hot reload, set `FINANCE_FRONTEND_URL=http://localhost:5173/` in the env file, restart `serve`, and run
`npm run dev` in `frontend/`. Vite proxies `/api` to the backend.
