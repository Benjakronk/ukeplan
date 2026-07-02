# ukeplan-server

Node + SQLite drop-in replacement for the Apps Script backend
(`ukeplan_GAS.js`). Same actions, same params, same JSON responses, same
"errors are HTTP 200 with `{ error }`" convention – so the only frontend
change at cutover is the `SCRIPT_URL` constant in `script.js` and
`teacher.js`. See `../server-plan.md` for the full VPS plan and
`../audit-teacher-ui.md` §5 for the phase 2 endpoint improvements.

## Files

| File | Purpose |
|------|---------|
| `server.js` | The API (Express + better-sqlite3, ~350 lines) |
| `db.js` | Opens/creates the SQLite DB (schema mirrors the sheet) |
| `setup-password.js` | Stores the SHA-256 hash of the teacher password |
| `import-csv.js` | One-off import of the Planelementer sheet CSV |
| `deploy/ukeplan.service` | systemd unit |
| `deploy/Caddyfile` | HTTPS + static frontend + API proxy |

## Local test run

```bash
npm install
node setup-password.js <samme passord som i dag>
node import-csv.js sti/til/Planelementer.csv   # optional – empty DB works too
npm start                                       # http://127.0.0.1:3000
```

Point the frontend at it: set `SCRIPT_URL = 'http://127.0.0.1:3000/api/plan'`
in `script.js`/`teacher.js` (any path under the server works) and open the
app via `python -m http.server 8000` as usual. CORS is open, so the two ports
coexist. Unlike the GAS, POSTs are curl-testable here:

```bash
curl 'http://127.0.0.1:3000/api/plan?action=week&classes=8A&week=2026-W36'
curl -d 'action=login&password=...' http://127.0.0.1:3000/api/plan
```

## Server install (after `server-plan.md` §1–3: VPS, hardening, DNS)

```bash
# Node LTS (NodeSource) + build tools for better-sqlite3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential

# App
sudo mkdir -p /srv/ukeplan-api /srv/ukeplan-data /srv/ukeplan
sudo chown ukeplan: /srv/ukeplan-api /srv/ukeplan-data /srv/ukeplan
rsync -av ukeplan-server/ ukeplan@SERVER:/srv/ukeplan-api/   # from your machine
cd /srv/ukeplan-api && npm install --omit=dev

# Data + password (UKEPLAN_DB must match the systemd unit)
UKEPLAN_DB=/srv/ukeplan-data/ukeplan.db node setup-password.js <passord>
UKEPLAN_DB=/srv/ukeplan-data/ukeplan.db node import-csv.js Planelementer.csv

# Service
sudo cp deploy/ukeplan.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ukeplan
curl http://127.0.0.1:3000/api/health          # → {"ok":true}

# Caddy (https + static frontend)
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit hostname first!
sudo systemctl reload caddy
rsync -av ukeplan-app/ ukeplan@SERVER:/srv/ukeplan/   # the static frontend
```

## Cutover

1. Diff-check: `curl https://host/api/plan?action=public` vs. the GAS
   `?action=public` – same rows (order may differ; compare sorted by id).
2. Repoint `SCRIPT_URL` in both JS files, bump `CACHE` in `sw.js`, deploy the
   frontend.
3. Keep the GAS deployment untouched for a week – rollback = revert the
   constant.
4. `VURD_URL` (vurderingskalenderen) stays on GAS until that backend gets the
   same treatment.

## Notes

- Tokens are in-memory: a server restart logs teachers out. The frontend
  already handles this (re-login + pending-write replay), but do restarts
  outside school hours anyway.
- Login is rate-limited (10 attempts / 10 min / IP) – new vs. the GAS.
- Backup = copy one file: `sqlite3 /srv/ukeplan-data/ukeplan.db ".backup ..."`
  nightly via cron, plus Hetzner VM backups (see `server-plan.md` §7).
- Keep `TYPES`/`GENERAL_TYPES` and the ISO-week helpers in sync with
  `teacher.js`/`script.js` – same rule as the GAS had.
