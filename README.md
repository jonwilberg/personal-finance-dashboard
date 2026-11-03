# personal-finance-dashboard
Personal finance app that pulls bank transactions via the Enable Banking API, automatically categorizes spending, and shows clear statistics on where your money goes.

## Enable Banking setup

1. **Create an application** at <https://enablebanking.com/cp/applications>:
   - Keep the **Sandbox** environment while developing.
   - Add the redirect URL `http://localhost:8765/callback` (the CLI listens there and captures the bank's redirect).
   - Let the browser generate the private key. A file named `<application-id>.pem` is downloaded.
     Move it somewhere outside the repo, e.g. `~/.enablebanking/`.
2. **Install [uv](https://docs.astral.sh/uv/)** (`winget install astral-sh.uv`) and dependencies:
   ```bash
   cd backend
   uv sync
   ```
3. **Configure** by copying `backend/.env.example` to `backend/.env` and setting `ENABLE_BANKING_APP_ID`
   and `ENABLE_BANKING_KEY_PATH`.

## Connecting a bank (CLI)

Run from `backend/`:

```bash
uv run finance app                                   # check credentials; shows environment + redirect URLs
uv run finance banks --country FI                    # list banks
uv run finance connect --bank "Mock ASPSP" --country FI
uv run finance accounts                              # accounts and balances in saved sessions
uv run finance transactions <account-uid> --days 90  # fetch and save transactions
uv run finance disconnect <session-id>               # revoke a consent
```

`connect` opens the bank's login page. Once you approve access, the session is saved to
`backend/data/sessions.json`, and `transactions` writes raw transactions to
`backend/data/transactions/<account-uid>.json`. Both are git-ignored.

In the sandbox, **Mock ASPSP** needs no credentials. See the
[sandbox docs](https://enablebanking.com/docs/api/sandbox/) for test logins to other banks.

## Production (your own accounts)

1. Register a **Production** application with the same redirect URL. Production asks for privacy and terms URLs.
2. Click **"Activate by linking accounts"** and link every account you want to use. This is restricted mode for
   non-commercial use, and only linked accounts return data.
3. Create `backend/.env.production` from `.env.example` with the production app ID and key, then add
   `--env production` to every command. Its data is kept apart from the sandbox in `backend/data/production/`.

```bash
uv run finance --env production banks --country NO
uv run finance --env production connect --bank "<bank name>" --country NO --days 180
uv run finance --env production transactions <account-uid> --longest
uv run finance --env production inspect <account-uid>   # field coverage only, no amounts or names
```

Many banks allow only about 4 background transaction fetches per account per day, so don't loop `transactions`.

## Development

```bash
cd backend
uv run pytest
```
