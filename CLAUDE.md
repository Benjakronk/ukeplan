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

`rich.js` also hosts the app's **in-app dialogs** (`uiAlert` / `uiConfirm` /
`uiPrompt` / `uiLinkDialog`, built on `buildUiDialog`) that replace native
`alert`/`confirm`/`prompt` — promise-based, built dynamically, styled via
`.ui-dialog*` in `styles.css`. The link toolbar button opens `uiLinkDialog`,
which takes both the URL and an optional display text; the editor selection is
captured before the modal and restored after (the blur-driven reset is
suppressed via `ed._linking` so the saved Range stays valid).

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
  per-item list that may carry a `day`. The teacher board columns are Fag · Tema
  og læringsmål · Ressurser · Lekser · Vurdering. The student weekly board is
  slimmer: Fag · Tema og læringsmål · Lekser — Ressurser is rendered as a
  "Ressurser" subheading at the bottom of the Tema-cell (`buildGoalsCell`), and
  Vurdering as a full-width "Vurdering:" strip under the subject's row when it
  has one that week. The Fag-progresjon tab keeps the full Ressurser + Vurdering
  columns. The allowed `type` list also lives in `ukeplan_GAS.js` (`TYPES`) —
  adding a type means redeploying the GAS.
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
  panel was removed. **Beskjeder/praktisk info also surface a day early**: a
  day-specific general element appears both on its day and on the previous
  school day. Mon–Thu pull the next weekday from `planData`; Friday needs the
  *next week's* Monday, so `ensureNextWeekData()` loads that week (reusing the
  per-week cache, `previewWeekData`) and re-renders.
- Homework rows have local check-off boxes (`localStorage: up_done`, keyed by
  element id).
- Subject board shows only subjects with content.
- **Fag tab** = subject progression for the student's class, week by week (rows =
  weeks with content). Loads all plan elements via `?action=public` (cached in
  `up_all`, 1 h) into `allPlanData`.

## Teacher page (`teacher.js`)

- Login screen (with a required name field) → dashboard. Token in
  `sessionStorage` (`up_token`); a write returning `Unauthorized` forces re-login.
- **Tabs:** Ukeplan (the editable board + beskjeder), Vurderinger, and Oversikt.
  The **Vurderinger** tab has two views — Tabell and Kalender (`vurdView`) — over
  the same filtered set (`getVurdFiltered`). Filters (`vfClasses`, `vfSubjects`,
  `vfTeachers`, `vfDesc`, `vfStart`/`vfEnd`; empty = all) are decoupled from the
  global class pill and edited via a single filter modal (`#vurdFilterModal`)
  opened by clicking any table **column header** or the "Filtrer" button (the
  button shows an active-filter count; a summary line sits above the views). The
  table has Dato·Uke·Klasse(r)·Fag·Beskrivelse·Lærer columns with edit/delete +
  "Ny vurdering"; the calendar is month cards with a dot per assessment, and
  clicking a day shows that day's assessments (editable) plus a "+ legg til"
  for that date. The add/edit modal shows a ±7-day conflict panel and a Lærer
  field (defaults to the dashboard name, overridable per entry). Oversikt has two
  modes:
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

## Adapted plans (individuell tilrettelegging)

A pupil who needs an adapted weekly plan gets an opaque **code** instead of any
stored identity. The stored key is `<CLASS>-<SUFFIX>` (uppercase, e.g.
`8A-K7X9M`), but **pupils and teachers only ever see/enter the SUFFIX**
(`K7X9M`) — the class comes from the class choice, so a code resolves only
together with the right class and never reveals which class it belongs to (a
second factor + privacy). `planKey()` returns `variantCode || selectedClass`;
`variantCode` is the full key built as `selectedClass + '-' + suffix`;
`parseVariantClass()` / `variantSuffix()` split the stored key.

- **No identifying data is stored.** Plan content lives as ordinary elements
  with `classes = <CLASS>-<SUFFIX>`; the code↔pupil mapping stays with the
  teacher offline. There is no registry sheet.
- **Wrong class or suffix → empty plan** (no match), shown with a "check class
  and code" hint rather than an error.
- **Plan content** (board, inline edits, clone, add-modal, Fag-tab, day-view
  preview) is keyed by `planKey()`. **Assessments, the calendar and the class
  label** keep using the base class (`selectedClass`), so an adapted plan
  inherits its class's vurderinger.
- **Student:** picks their class (required) and types the code in a discreet
  "Har du fått en egen kode?" field in the class modal (`up_variant` holds the
  full key). The plan view is identical to a normal class (anti-stigma) — the
  pill shows the base class, no markers anywhere others see.
- **Teacher:** the class modal's "Tilpasset plan" box generates a code for the
  currently-selected class (the SUFFIX is shown once via `uiAlert` to hand to
  the pupil) or opens an existing suffix; editing a variant sets
  `variantCode` (pill shows the code). The add-modal hides the class picker for
  plan elements (saves under the code) but keeps it for `vurdering` (class-wide).
  "Hent fra klassen" seeds the variant from its base class via `clone` with the
  new optional `toClasses` param (class → code, same week). Picking a normal
  class exits variant editing.

## Class & subject lists

`CLASSES` (8A–10F) and `SUBJECTS` are hardcoded in `script.js` and `teacher.js`.
`SUBJECTS = [...CORE_SUBJECTS, ...ELECTIVE_SUBJECTS]`. Update each school year.

Students pick which electives (valgfag/tilvalgsfag) they have in the class modal
(stored in `localStorage: up_electives`; `null` = not chosen yet → show all).
`subjectVisible(subject)` filters the student's views so elective subjects they
did not choose are hidden everywhere (board, day view, calendar, Fag tab). The
teacher always sees all subjects.

## Notes

- POST uses `application/x-www-form-urlencoded` (via `URLSearchParams`) to avoid
  a CORS preflight against Apps Script. Do not switch to JSON bodies.
- `curl` cannot reliably test POST endpoints (Apps Script 302-redirects POSTs);
  verify login/CRUD in the browser.
- The school-calendar iCal feed is the same Nes-kommune endpoint used by
  vurderingskalender; events are cached 24 h in `localStorage` (`up_school_cal`).
- `sw.js` serves the app shell **network-first** (fresh when online, cached copy
  only as an offline fallback), so HTML/JS/CSS changes appear on the next load.
  Still bump `CACHE` (`ukeplan-shell-vNN`) when you change assets — the new
  version precaches fresh copies on install and purges the old cache on activate.
  Apps Script requests are never intercepted (data caching is `localStorage`).
```
