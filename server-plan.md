# Ukeplan – Hetzner VPS backend plan

*Written 2026-07-02. Companion to `audit-teacher-ui.md` §5 (traffic/endpoints).
Goal: replace the Apps Script backend with a real server, drop request latency
from 1–3 s to tens of ms, and unlock the migration items from the audit.*

## 0. Before anything: clearance

This is a school tool. Before moving data off Google, check with Nes kommune
whether a **databehandleravtale (DPA)** or an approval is needed for hosting on
a private VPS. Points in your favor: Hetzner is EU-based (Germany/Finland),
and the app **stores no personal data by design** (no pupil names, opaque
adapted-plan codes, teacher first names only). Keep that design; it is the
strongest privacy argument you have.

## 1. Provision the server

- **Instance:** smallest is plenty — CX22 (2 vCPU, 4 GB, ~€4/mo) or the ARM
  CAX11 (~€3.8/mo). This app would run on a tenth of that.
- **Location:** Falkenstein or Helsinki (both ~30–40 ms from Oslo; pick either).
- **Image:** Ubuntu 24.04 LTS.
- **SSH key:** add it at creation time; never enable password login.
- The included 20 TB traffic is ~100× your worst-case month — ignore it.

## 2. Base hardening (15 minutes)

```bash
adduser ukeplan && usermod -aG sudo ukeplan     # daily-driver user
# /etc/ssh/sshd_config: PasswordAuthentication no, PermitRootLogin no
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
apt install unattended-upgrades                  # auto security patches
```

Optionally use a Hetzner Cloud Firewall (same three ports) instead of/on top
of ufw, and enable Hetzner's automated backups (+20% ≈ €1/mo) for the whole VM.

## 3. Domain + TLS

You need a hostname for HTTPS (PWA + sane cookies require it):

- Best: a subdomain of a domain the school/kommune controls
  (e.g. `ukeplan.runni.no` style), pointed as an A/AAAA record at the VPS.
- Otherwise: any cheap domain you register yourself.

Then install **Caddy** as the web server — it gets and renews Let's Encrypt
certificates automatically, and gives you gzip + HTTP/2 + ETags for free.
The entire config (`/etc/caddy/Caddyfile`):

```caddyfile
ukeplan.example.no {
    encode zstd gzip

    handle /api/* {
        reverse_proxy 127.0.0.1:3000
    }

    root * /srv/ukeplan
    file_server
}
```

That one block covers three audit items at once: compression, static-file
ETags/304s, and same-origin hosting (frontend + API on one host = no CORS,
so the "form-encoded POST only" constraint disappears).

## 4. Backend stack: Node + SQLite

Matches the no-build-system philosophy of the project:

- **Node LTS** (from nodesource or `apt`), **Fastify or Express**, and
  **better-sqlite3**. SQLite is the right call at this scale: one file on
  disk (`/srv/ukeplan-data/ukeplan.db`), no DB server to run, transactional,
  and backup = copy one file. Postgres would be pure overhead here.
- Two tables mirroring the sheets:
  `plan_elements (id, timestamp, type, classes, week, day, subject, description, teacher, week_to)`
  and (when you migrate it) `assessments (id, date, subject, classes, description, teacher)`.
  Index on `(week, week_to)` and `classes`.

**Phase 1 – drop-in replacement.** Implement the exact GAS API (same action
names, same params, same JSON responses, incl. `login`/token, `week`,
`public`, `all`, `create`/`update`/`delete`, `clone` with
`subjects`/`general`/`toClasses`). Then the ONLY frontend change is the
`SCRIPT_URL` constant in `script.js`/`teacher.js`. Low-risk cutover, easy
rollback (point the constant back at GAS).

**Phase 2 – the audit's improvements**, once stable:

- `?from=&to=` range queries replacing the `public` full dumps
- ETag/304 on API responses (bump a revision counter on every write)
- batch create (array body) for multi-class saves and row-copy
- sliding sessions via httpOnly cookie; per-teacher accounts
- `updatedAt` optimistic-locking check on `update`
- login rate limiting (e.g. 5 attempts/min/IP) — matters with a shared password

**Run it under systemd** (`/etc/systemd/system/ukeplan.service`):

```ini
[Unit]
Description=Ukeplan API
After=network.target

[Service]
User=ukeplan
WorkingDirectory=/srv/ukeplan-api
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

## 5. Data migration

1. File → Download → CSV for the `Planelementer` sheet (and the
   vurderingskalender sheet when its turn comes).
2. One-off import script into SQLite (keep the existing UUIDs as primary keys
   so nothing else changes).
3. Diff-check: `?action=public` from GAS vs. the new server should return the
   same rows.

**Vurderingskalender backend:** can stay on GAS initially — the app keeps
using `VURD_URL` unchanged, so migrate it as a second step (own table + same
API mirror). Migrating both eventually lets you merge plan + assessments into
one read (audit §5.2.5).

## 6. Frontend hosting

Move the static files from GitHub Pages to `/srv/ukeplan` on the VPS (same
origin as the API). Deployment = `scp`/`rsync` of the `ukeplan-app` folder,
or a tiny GitHub Action if you want push-to-deploy. Keep the sw.js CACHE-bump
routine. GitHub Pages can keep serving as a fallback during the transition.

## 7. Backups & monitoring

- Nightly cron: `sqlite3 ukeplan.db ".backup /backups/ukeplan-$(date +%F).db"`,
  keep ~30, and copy off-box (Hetzner Storage Box is €4/mo, or any other
  location). The DB will be a few MB — trivial.
- Hetzner VM backups as the second layer.
- Free uptime ping (UptimeRobot or similar) against `/api/health`.
- Logs: journald (`journalctl -u ukeplan`) is enough.

## 8. Cutover checklist

1. Server up, Caddy serving the frontend over HTTPS, API mirroring GAS.
2. Import data; diff against GAS output.
3. Point `SCRIPT_URL` at `https://ukeplan.example.no/api/` in both JS files,
   bump sw.js CACHE, deploy.
4. Watch for a week; keep GAS untouched as instant rollback.
5. Then: phase 2 endpoints, vurderingskalender migration, retire GAS.

**Monthly cost: ~€5–9** (VM ~€4 + backups ~€1 + optional Storage Box €4 +
domain ~€1–2/mo amortized).
