# Ukeplan — Teacher UI & Server-Migration Audit

*Audited 2026-07-02 against commit `8ef8ed2` (Idiotsikring v1). Scope: teacher
workflow streamlining, idiot-proofing, and traffic planning for the move from
Apps Script to a real server.*

---

## 1. Executive summary

The teacher side is already in good shape: double-submit guards on every create
path, undo/redo with backend inverses, delete confirmation with restore,
loud save errors, vurdering date guards with plain-language echo, and the
±7-day conflict panel are all above the bar for a tool like this.

The remaining findings fall in three groups:

- **Workflow:** the board shows all 22 subjects to every teacher, clone is
  all-or-nothing (it copies *colleagues'* content too), and parallel-class
  teachers re-type content per class. These are the biggest daily time costs.
- **Idiot-proofing:** four real gaps — a background re-render can wipe
  in-progress typing, the add-modal discard guard misses the ×/Avbryt/Esc
  paths, clone duplicates multi-week elements, and opening a mistyped
  variant code silently forks an empty plan.
- **Traffic:** at this school's scale the app cannot realistically approach
  20 TB/month — worst case lands under ~100 GB/month. The changes worth making
  (compression, ETags, killing the full-table `action=public` dumps) matter
  for latency and server load, not for the cap.

---

## 2. What already works well (keep these patterns)

| Area | Mechanism |
|------|-----------|
| Duplicate prevention | `_busy`/`_pending` per field, `modalSaving`, `cloning` |
| Reversibility | undo/redo stack with backend inverses + mutable `ref.id` |
| Deletion safety | `confirmDeletion()` + `restoreRichCell()` on cancel |
| Save-failure visibility | red toast, `⚠ Ikke lagret!`, `.unsaved` outline |
| Vurdering dates | weekend/skoleruta block, `#dateEcho`, week-mismatch warning |
| Session | proactive expiry timer + 5-minute pre-logout warning |

Any new feature should follow the same guard patterns (CLAUDE.md already says
so for create paths).

---

## 3. Workflow streamlining (prioritized)

### T1 — "Mine fag": let the teacher hide subjects they don't teach ★ biggest win
The board renders all 22 `SUBJECTS` rows for every class. A KRLE teacher
scrolls past 21 irrelevant rows every week, in every class. The student side
already has exactly this mechanism (`up_electives` + `subjectVisible()`).

**Suggestion:** a "Mine fag" multi-select in the profile modal (stored in
`up_settings`), defaulting to all. Filter the board rows, the Oversikt subject
dropdown, and pre-select in the add modal. Keep a one-click "vis alle fag"
toggle above the board so nothing is ever unreachable. This also makes
`defaultSubject` mostly redundant for single-subject teachers.

### T2 — Scope "Kopier forrige uke" to the teacher's subjects
`clone` copies **every** element for the class — including other teachers'
subjects. In a multi-teacher reality, the math teacher cloning the week also
duplicates the Norwegian teacher's fresh entries (the warning fires, but the
teacher can't act on it selectively). Combined with T1: clone only "mine fag"
by default, with a checkbox list (pre-checked from Mine fag) in the confirm
dialog. Backend: `clone` takes an optional `subjects` filter.

### T3 — Make clone undoable (quick win, ~10 lines)
`cloneWeek` already returns `entries` with fresh ids — `teacher.js` ignores
them. Feed them to `recordCreateMany(result.entries.map(e => ({params:
elementCreateParams(e), id: e.id})), 'kopierte uke')` and the single scariest
bulk action becomes reversible. CLAUDE.md's "clone is not undoable" caveat
disappears.

### T4 — "Kopier raden til parallellklasser"
Teachers with 8A+8B in the same subject type everything twice (the modal
bulk-creates, but inline board edits — the primary flow — are single-class).

**Suggestion:** a small ⧉ icon per subject row that opens a class-checkbox
dialog and clones that row's elements (tema/ressurs/lekser) to the chosen
classes for the viewed week (N `create` calls, recorded via
`recordCreateMany`). This closes the gap between "inline is fast but
single-class" and "modal is multi-class but slow".

### T5 — Vurderinger table: default the date range to "fra i dag"
`renderVurdTable` sorts ascending with no default date filter — by May the
teacher scrolls past hundreds of past assessments to reach the relevant ones.
Default `vfStart` to today (clearable, and shown in the filter summary so it's
discoverable), or add an "skjul gamle" toggle.

### T6 — Cache assessments on the teacher page
`loadAssessments()` (teacher.js:630) fetches the **full** vurderingskalender
dump on every week navigation, class switch, refresh and after every vurdering
save — with no cache. The student side caches the same feed for 1 h. Mirror
that (short TTL, e.g. 5–10 min, + forced refresh after own writes). This is
also the single biggest teacher-side traffic item today, and week navigation
becomes noticeably snappier.

### T7 — Batch create on the new server
The modal's multi-class save loops `create` sequentially — on Apps Script
that's ~1–2 s *per class*, so 6 classes locks the modal for ~10 s. On the new
server, add a batch-create endpoint (one request, N rows, returns N ids) and
keep the sequential loop only as the GAS fallback.

### T8 — Sessions and accounts (server move)
The 4 h token is not renewed on use, so a teacher planning through an
afternoon gets logged out mid-work (the 5-min warning helps but doesn't fix
it). On the new server: sliding expiry (renew on activity) via an httpOnly
cookie, and per-teacher accounts. Accounts also fix the free-text name problem
— today "Kari", "Kari N." and "KN" fragment the Lærer filter chips and the
`teacher` field is unverifiable.

---

## 4. Idiot-proofing (prioritized)

### I1 — Background re-render can wipe in-progress typing ★ fix first
Every data arrival calls `render()`, and `renderBoard()`/`renderGeneral()`
rebuild via `innerHTML = ''`. Sequence: teacher clicks ↻ (or saves from the
modal → `refreshAfterChange()` → background `loadData()`), immediately clicks
into a cell and starts typing; 1–2 s later the fetch resolves, `render()`
rebuilds the board, and the focused field — with its uncommitted text — is
destroyed. No error, no toast; the text is simply gone. `loadAssessments()`
makes it worse by triggering a second render per `loadData()`.

**Fix:** before re-rendering the ukeplan pane, check whether
`document.activeElement` is inside `#board`/`#generalSection` (a `.rich-field`
or homework row). If so, defer: stash the fresh data and re-render on the
field's next blur (after its commit). Cheap addition: skip the
assessments-triggered render when the fetched JSON equals the current
`vurdData`.

### I2 — Add-modal discard guard misses ×, Avbryt and Esc
`closeAddModal()` only asks "Forkaste endringer?" when `viaOverlay` is set.
The × button and Avbryt discard unsaved text silently, and there is no
Escape handler at all (the `buildUiDialog` dialogs have one — teachers will
expect it here too). **Fix:** route all three paths through the same dirty
check (`descInput` vs `modalInitialDesc`), and add a `keydown` Escape handler
while the modal is open. Same treatment for a dirty date/class/day change if
you want to be thorough — but text is the main loss.

### I3 — Clone duplicates multi-week elements
`cloneWeek` copies every element *overlapping* `fromWeek` as a new
single-week element in `toWeek`. A tema spanning uke 34–40, cloned from 35
into 36, gets a duplicate in 36 — where the original **already applies**. The
generic "kan gi dobbeltoppføringer" warning fires, but the teacher who accepts
it expects simple repeats, not silent duplication of range elements.
**Fix (backend, 1 line):** skip source entries where
`entry.week <= toWeek && (entry.weekTo || entry.week) >= toWeek`.

### I4 — Mistyped variant code silently forks an empty plan
`openVariantFromInput()` accepts any `[A-Z0-9]{3,}` suffix and starts editing
it — no existence check. A teacher who typo-es an existing code gets an empty
board (plausibly "the week just hasn't been filled in"), writes a week of
content under the wrong key, and the pupil never sees it. **Fix:** after
`applyVariant`, if the initial `loadData` comes back empty for a code opened
via the input field (not newly generated), show a prominent, actionable
warning: "Denne koden har ikke noe innhold fra før. Er du sikker på at koden
er riktig? (Ny kode: bruk «Lag ny tilpasset plan».)" — ideally checking a
couple of recent weeks, not just the viewed one. Also consider a persistent
colored banner while a variant is active ("Du redigerer tilpasset plan
K7X9M — endringer vises bare for eleven med koden"); the pill text alone is
easy to miss, and the variant survives browser restarts via localStorage.

### I5 — Session expiry mid-edit loses the last commit
A blur-commit after the 4 h token dies returns `Unauthorized` →
`handleExpired()` swaps to the login screen; the field's text (and its
`.unsaved` marker) are unmounted, and after re-login the board rebuilds from
the server — the edit is gone. The 5-min warning mitigates but doesn't cover
"laptop lid closed, reopened later". **Fix:** when a write fails with
`Unauthorized`, stash `{type, subject, week, classes, html}` in
`sessionStorage` and replay (or at least restore into the cell with `.unsaved`)
after the next successful login. T8's sliding sessions shrink this whole class
of problem.

### I6 — Multi-teacher concurrency: last write wins, silently
`commitRichCell` with multiple ids updates `ids[0]` with the merged cell text
and **deletes the rest** — if two co-teachers each created a læringsmål for
the same subject/week, the next inline edit by either merges and deletes the
other's element. Updates also blindly overwrite a colleague's newer version.
Fine for now (content survives merged, undo exists), but on the new server add
an `updatedAt` optimistic-concurrency check: reject the write if the row
changed since it was loaded, and offer "last inn på nytt / overskriv".

### I7 — Small guards
- **Profile name can be cleared:** the input writes `teacherName` on every
  keystroke; an emptied field means subsequent entries save with
  `teacher: ''`. Enforce non-empty on modal close (fall back to previous).
- **`update` blanks omitted fields** (`updateEntry` writes all columns from
  `p`): today every caller sends the full set, but it's a foot-gun for future
  callers. On the new server use explicit PATCH semantics.
- **Login rate limiting** doesn't exist on GAS; add it (plus a short lockout)
  on the new server — one shared password makes this matter more.

---

## 5. Server migration & the 20 TB question

### 5.1 The math — you are nowhere near the cap

Rough sizing for Runni (≈540 students + ≈60 staff ≈ 600 users):

| Flow | Size (raw) | Volume | Month |
|------|-----------|--------|-------|
| App shell (600 users × 3 loads/day × 20 days) | ~250 KB, ~65 KB gzipped, ~5 KB with 304s | 36k loads | 2–9 GB |
| `?action=week` (students+teachers, cached 1 h) | 5–20 KB | ~50k req | ~1 GB |
| `?action=public` plan dump (Fag tab / Progresjon) — grows to ~40k rows ≈ 8–12 MB by June | ~10 MB worst | ~12k req | ~60–120 GB worst case |
| Vurd `?action=public` (assessments, few hundred KB by June) | ~0.3 MB | ~40k req | ~12 GB |

**Worst case, uncompressed, with today's code: on the order of 100–150 GB/month
— under 1 % of 20 TB.** Even a 10× miss in these estimates leaves 90 %+
headroom. So treat the items below as latency/cost/robustness work, not as
required to stay under the cap.

### 5.2 What actually moves the needle

1. **Enable gzip/brotli** (Apps Script can't; any real server can). JSON
   compresses 5–10×. One config line erases most of the table above.
2. **Replace `?action=public` with range/delta queries.** It's the only
   payload that grows all year. Add
   `?action=range&classes=…&from=YYYY-Www&to=YYYY-Www` for the student Fag tab
   and teacher Progresjon (both only ever *display* a week range), and ideally
   `?since=<timestamp>` delta sync against the localStorage cache. Same for
   the assessments feed (`?from=&to=` on dates).
3. **ETag/`Last-Modified` on API responses.** Keep a per-dataset revision
   counter (bump on write); unchanged polls become 304s of ~200 bytes. This
   pairs perfectly with the existing localStorage + background-revalidate
   pattern — revalidation becomes near-free.
4. **Static assets:** either keep the current SW network-first approach (it
   sends conditional requests — make sure the server serves ETags so those are
   304s, which GitHub Pages did automatically), or switch to hashed filenames
   + `Cache-Control: immutable` with a tiny always-revalidated `index.html`.
   The current approach is fine and simpler; just don't lose the ETags.
5. **Merge the two backends' reads.** Same origin now — one
   `?action=week` response can embed that week's assessments (plan + vurd in
   one request), halving request count and removing the second fetch/render
   cycle (see I1). Writes can keep separate endpoints.
6. **Batch endpoints** for multi-class create and clone (see T7) — a latency
   win more than a traffic one.
7. **Housekeeping the move enables:** POSTs can become JSON (same-origin kills
   the CORS-preflight constraint — update the CLAUDE.md note when it happens);
   real DB with indexes instead of full-sheet scans; httpOnly session cookies
   instead of tokens in `sessionStorage`; per-teacher accounts (T8); login
   rate limiting (I7). Keep `isoWeekString`/`dateToWeek` parity when porting.

### 5.3 Suggested endpoint shape for the new server

```
GET  /api/plan?classes=8A&week=2026-W36          (today's `week`)
GET  /api/plan?classes=8A&from=2026-W34&to=W40   (replaces `public`)
GET  /api/vurd?classes=8A&from=2026-08-01        (replaces vurd `public`)
POST /api/plan          (create; accepts an array → batch)
PATCH /api/plan/:id     (partial update + If-Unmodified-Since / rev check)
DELETE /api/plan/:id
POST /api/plan/clone    (fromWeek, toWeek, classes, subjects?, toClasses?)
```
All GETs: ETag + gzip. All writes: return the full row(s) incl. id + rev.

---

## 6. Priority order

| # | Item | Effort | Payoff |
|---|------|--------|--------|
| 1 | I1 render-race guard | S | stops silent text loss |
| 2 | I2 modal discard guard (×/Avbryt/Esc) | S | stops silent text loss |
| 3 | T3 undoable clone | S | reversibility for the scariest action |
| 4 | I3 clone multi-week skip | S | stops duplicate rows |
| 5 | I4 variant-code existence warning + banner | S | stops lost weeks of work |
| 6 | T6 teacher assessments cache | S | snappier + less traffic |
| 7 | T1 "Mine fag" board filter | M | biggest daily time save |
| 8 | T2 subject-scoped clone | M | multi-teacher safety + speed |
| 9 | T5 vurd table default date range | S | usability from ~October on |
| 10 | T4 copy row to parallel classes | M | parallel-class teachers |
| 11 | I5 replay unsaved edit after re-login | M | rare but nasty loss |
| 12 | Server move items (5.2): compression, range endpoints, ETags, merged reads, accounts/sessions, I6 rev check, T7/T8 | L | latency, robustness, hygiene |

Items 1–6 are all small and could ship as one "Idiotsikring v2" commit before
the server work starts.
