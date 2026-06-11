# CLAUDE.md

This file guides Claude Code when working in the `ukeplan` repository.

## Project overview

A static frontend web app (Norwegian: "ukeplan") for Runni ungdomsskole.
Students browse a weekly plan for their class (subject rows: learning goals,
homework, assessments). Teachers manage entries on an authenticated page with
inline editing, a "copy from last week" action, bulk class assignment, and
print.

Built as a sibling to `vurderingskalender` and deliberately leaves that
project (code, sheet, and Apps Script) untouched. Assessments are read-only
here — they are fetched from the existing vurderingskalender backend and
merged into the "Vurdering" column at read time.

No build system, package manager, or test framework — plain HTML/CSS/JS.

## Folder structure

```
ukeplan/                           ← parent folder (not pushed to GitHub)
  ukeplan_GAS.js                   ← Apps Script source for the NEW sheet
  reset_password.txt               ← teacher password instructions
  roadmap.md                       ← design decisions
  CLAUDE.md                        ← this file

  ukeplan-app/                     ← GitHub Pages repo root
    index.html / script.js / styles.css      ← student weekly plan
    teacher.html / teacher.js / teacher.css   ← teacher editor (links styles.css + teacher.css)
    rich.js                                   ← shared rich-text editor + HTML sanitizer
    docx.js                                   ← dependency-free .docx (OOXML zip) generator
    sw.js / manifest.json / icon.svg          ← PWA
```

## Rich text (`rich.js`)

Loaded before `script.js`/`teacher.js` on both pages. Teachers format content
(læringsmål/tema, lekser, beskjeder) with a floating toolbar (bold / underline /
link) on contenteditable fields (`createRichField`). Content is stored as a
constrained HTML subset and `sanitizeHtml()`-cleaned on both save and render —
allowed tags: `<strong> <em> <u> <a href> <br>`; links must be http(s)/mailto.
The student side renders it with `renderRich()`. Assessment descriptions stay
plain text (authored via the modal, stored in the old backend).

## Running locally

```bash
cd ukeplan-app
python -m http.server 8000
# student:  http://localhost:8000
# teacher:  http://localhost:8000/teacher.html
```

## Backend (Apps Script)

`ukeplan_GAS.js` backs the NEW "Planelementer" sheet. Same auth model as
vurderingskalender: SHA-256 password hash in Script Properties → short-lived
UUID token in `sessionStorage`. All errors return HTTP 200 with `{ error }`.

`getSheet()` auto-creates the "Planelementer" sheet with its header on first
run. Sheet columns:
`id | timestamp | type | classes | week | day | subject | description | teacher | weekTo`

- `week` = start of the range (weekFrom); `weekTo` = end (empty = single week).
  `getWeekData` returns elements where `week <= W <= weekTo` (ISO strings sort
  lexically). Adding `weekTo` was a schema change — redeploy the GAS.
- `day` is a comma-separated list of weekday keys (e.g. `man,ons`); empty = whole week.

Endpoints:

| Action | Method | Auth | Purpose |
|--------|--------|------|---------|
| `public` | GET | none | All plan elements (fallback) |
| `week` | GET | none | Elements for `classes`+`week` (server-side filtered) |
| `login` | POST | none | Password → token |
| `all` | GET | token | All elements (teacher) |
| `create` / `update` / `delete` | POST | token | CRUD by `id` |
| `clone` | POST | token | Copy `fromWeek`→`toWeek` for `classes` |

`isoWeekString()` (backend) and `dateToWeek()` (frontend) produce identical
`YYYY-Www` strings — keep them in sync if either changes.

Deployment URL is set as `SCRIPT_URL` in both `script.js` and `teacher.js`.
The vurderingskalender URL is `VURD_URL` in both (for the assessment merge).

## Data model conventions

- **Subject-cell types** (`SUBJECT_TYPES = ['læringsmål','ressurs','lekse']`):
  always carry a `subject`. `læringsmål` (Tema og læringsmål) and `ressurs`
  (Ressurser, e.g. textbook pages) are week-level rich cells; `lekse` is a
  per-item list that may carry a `day`. The board columns are Fag · Tema og
  læringsmål · Ressurser · Lekser · Vurdering. The allowed `type` list also
  lives in `ukeplan_GAS.js` (`TYPES`) — adding a type means redeploying the GAS.
- **General types** (`GENERAL_TYPES = ['beskjed','timeendring','utstyr',
  'aktivitet','annet']`): `subject` is OPTIONAL (shown as "Fag:" prefix when set),
  may carry day(s). Rendered grouped one box per type in the banner (student) /
  "Beskjeder og praktisk info" section (teacher); teacher lines open the modal.
- **Multi-week / multi-day:** any element may span a week range and several days.
  On the teacher week board, single-week/≤1-day elements edit inline; multi-week
  or multi-day ones show as clickable chips that open the modal. The modal
  (create + edit, with Delete) is the editor for week range, day(s) and subject.
- **Progresjon is editable:** Tema og Ressurser cells edit per week inline;
  "+ Tema for periode" sets a tema across the from–til range.
- **Assessments** (`vurdering`) are NOT stored in this sheet. They are read
  from `VURD_URL?action=public` (filtered client-side by class + derived week)
  and written back to the vurderingskalender backend's own
  `create`/`update`/`delete` endpoints — that backend stays the single source.
  An assessment carries a `date` (not a `week`/`day`) and may list several
  classes in one space-separated `classes` field, per that system's convention.
  Legacy Forms entries have no `id` and are read-only.

## Student page (`script.js`)

- Single class choice, remembered in `localStorage` (`up_class`).
- Week navigation (◀ ▶ / arrow keys / "Denne uka"). Per class+week localStorage
  cache (`up_weeks`, 1 h) with background revalidation.
- **Tabs:** Ukeplan and Vurderingskalender. The Vurderingskalender tab is a
  3-month grid of the class's assessments; clicking a day shows that day's
  assessments inline (`#vurdDetail`).
- **Ukeplan tab** has a Uke/Dag toggle. Uke = the fag-rader board + Mon–Fri
  strip. Dag = clicking a strip day shows everything for that day inline
  (vurderinger, that day's lekser, week-general beskjeder). The old slide-in
  panel was removed.
- Homework rows have local check-off boxes (`localStorage: up_done`, keyed by
  element id).
- Subject board shows only subjects with content.
- **Fag tab** = subject progression for the student's class, week by week (rows =
  weeks with content). Loads all plan elements via `?action=public` (cached in
  `up_all`, 1 h) into `allPlanData`.

## Teacher page (`teacher.js`)

- Login screen (with a required name field) → dashboard. Token in
  `sessionStorage` (`up_token`); a write returning `Unauthorized` forces re-login.
- **Tabs:** Ukeplan (the editable board + beskjeder), Vurderinger (a table of the
  class's assessments with edit/delete + "Ny vurdering"; the add/edit modal shows
  a ±7-day conflict panel), and Oversikt. Oversikt has two modes:
  «Sammenlign klasser» (one week, rows = classes, fetched via `?action=week&week=…`
  with no class filter into `oversiktData`) and «Progresjon» (one class + subject,
  rows = weeks, fetched via `?action=public` into `allPlanData`). Progresjon mode
  has an "Eksporter .docx" button that builds a fagrapport for the class+subject
  via `docx.js` (`buildDocx` → `saveBlob`).
- The add modal's week dropdown lets you write to a week other than the one shown.
- Editable board shows ALL `SUBJECTS` as rows. Each Læringsmål/Lekser cell is a
  textarea; on blur it creates/updates/deletes the element (empty = delete).
- The **Vurdering** column is editable too, but writes to the vurderingskalender
  backend: clicking a tag opens the modal in edit mode (with Delete); "+ legg
  til / + vurdering" adds one for that subject. The ukeplan teacher logs into
  that backend automatically with the same password (`vurdLogin` during login);
  if the passwords differ, `ensureVurdToken` prompts for it on first write. The
  second token is stored in `sessionStorage` (`up_vurd_token`).
- General elements are editable cards (text + delete); created via the modal.
- Add modal: type → (subject + date for vurdering | subject for cell types |
  day for general), multi-class selection, description. For `vurdering` a single
  entry is created with all selected classes; for the others, one element per
  class.
- "Kopier forrige uke" calls `clone`. Print via the browser.
- Teacher name remembered in `localStorage` (`up_teacher_name`).

## Class & subject lists

`CLASSES` (8A–10F) and `SUBJECTS` are hardcoded in `script.js` and `teacher.js`.
Update each school year. Not all parallels exist everywhere — unused ones are
simply never selected.

## Notes

- POST uses `application/x-www-form-urlencoded` (via `URLSearchParams`) to avoid
  a CORS preflight against Apps Script. Do not switch to JSON bodies.
- `curl` cannot reliably test POST endpoints (Apps Script 302-redirects POSTs);
  verify login/CRUD in the browser.
- The school-calendar iCal feed is the same Nes-kommune endpoint used by
  vurderingskalender; events are cached 24 h in `localStorage` (`up_school_cal`).
```
