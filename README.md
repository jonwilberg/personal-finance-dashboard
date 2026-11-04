# personal-finance-dashboard
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
2. **Fetch history** per account gets the balance and as much transaction history as the bank allows. Many banks
   allow only about 4 fetches per account per day.
3. **Inspect fields** shows which transaction fields the bank fills in, without amounts or names.

Sessions, balances and raw transactions are stored as JSON under `backend/data/` (`backend/data/production/` for
production). They are git-ignored.

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
```

With an `https` redirect URL, `connect` asks you to paste the URL the bank redirects to. The web app avoids this.

## Development

```bash
cd backend && uv run pytest                      # backend tests
uv run finance --env production serve            # API on https://localhost:8765
```

For frontend hot reload, set `FINANCE_FRONTEND_URL=http://localhost:5173/` in the env file, restart `serve`, and run
`npm run dev` in `frontend/`. Vite proxies `/api` to the backend.
