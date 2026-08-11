'use strict';

// ─── Configuration ────────────────────────────────────────────

const SCRIPT_URL = 'https://api.ukeportalen.no';

// Auth is a per-teacher account with an httpOnly session cookie (set by the API).
// The frontend never holds the token; it just sends `credentials: 'include'` and
// asks `?action=me` on load. These localStorage keys are a cache of the profile.
const CLASS_KEY   = 'up_teacher_class';
const TNAME_KEY   = 'up_teacher_name';
const UNAME_KEY   = 'up_teacher_username';   // last username, prefilled on the login screen
const VARIANT_KEY = 'up_teacher_variant';   // adapted-plan code being edited, e.g. "8A-K7X9M"

const SCHOOL_CAL_URL    = 'https://sspkalender.prokom.no/api/iCalTidspunkt/?Kunde=nesakskoleruta&Id=0&Categories=438,439';
const SCHOOL_CAL_KEY    = 'up_school_cal';
const SCHOOL_CAL_TS_KEY = 'up_school_cal_ts';
const SCHOOL_CAL_TTL    = 24 * 60 * 60 * 1000;

const CLASS_GRADES = [
  { label: '8.',  classes: ['8A','8B','8C','8D','8E','8F'] },
  { label: '9.',  classes: ['9A','9B','9C','9D','9E','9F'] },
  { label: '10.', classes: ['10A','10B','10C','10D','10E','10F'] },
];
const CLASSES = CLASS_GRADES.flatMap(g => g.classes);

// The grade-year group a class belongs to (null for a variant/adapted-plan code).
function gradeGroupOf(cls) { return CLASS_GRADES.find(g => g.classes.includes(cls)) || null; }
function isElective(subject) { return ELECTIVE_SUBJECTS.includes(subject); }
// Electives are a year-level unit: a plan element covers the whole grade-year, so
// one shared plan reaches every student in the year who chose the elective.
function electiveYearClasses(cls) { const g = gradeGroupOf(cls); return g ? g.classes.slice() : [cls]; }
// The `classes` string to write for a new element: the whole year for an elective
// (variant codes never expand, since gradeGroupOf returns null), else the class.
function writeClassesFor(subject, cls) {
  return isElective(subject) && gradeGroupOf(cls) ? electiveYearClasses(cls).join(' ') : cls;
}
// The set of `classes` strings to write for a multi-class selection (add-modal):
// electives collapse to ONE element per grade-year (that has any selected class);
// everything else stays one element per class.
function electiveWriteGroups(subject, classesList) {
  if (!isElective(subject)) return classesList.slice();
  const years = CLASS_GRADES.filter(g => g.classes.some(c => classesList.includes(c))).map(g => g.classes.join(' '));
  return years.length ? years : classesList.slice();
}

const CORE_SUBJECTS = [
  'Norsk','Matematikk','Engelsk','Naturfag','Samfunnsfag','KRLE',
  'Kroppsøving','Musikk','Kunst og håndverk','Mat og helse','Utdanningsvalg',
];
const ELECTIVE_SUBJECTS = [
  'Spansk','Fransk','Tysk','Engelsk fordypning',
  'Arbeidslivsfag (ALF)','Fysisk aktivitet og helse (Fysak)','Friluftsliv',
  'Innsats for andre','Programmering','Teknologi og design','Design og redesign',
];
const SUBJECTS = [...CORE_SUBJECTS, ...ELECTIVE_SUBJECTS];
// Alphabetical (Norwegian) order for the dropdown menus. The board rows keep the
// curriculum order of SUBJECTS (see subjectSort).
const SUBJECTS_SORTED = [...SUBJECTS].sort((a, b) => a.localeCompare(b, 'no'));

const DAYS = ['man','tir','ons','tor','fre'];
const DAY_LABEL = { man: 'Man', tir: 'Tir', ons: 'Ons', tor: 'Tor', fre: 'Fre' };

// Types managed as subject cells vs. class-wide banner elements.
// 'vurdering' is special: it is date-specific rather than week-level and uses
// its own actions (vurderinger/vurdcreate/…) and table on the same backend.
const SUBJECT_TYPES = ['læringsmål', 'ressurs', 'lekse'];
const GENERAL_TYPES = ['beskjed', 'timeendring', 'utstyr', 'aktivitet', 'annet'];
const MODAL_TYPES   = ['lekse', 'læringsmål', 'ressurs', 'vurdering', 'beskjed', 'timeendring', 'utstyr', 'aktivitet', 'annet'];
const TYPE_LABEL = {
  'læringsmål': 'Tema og læringsmål', 'ressurs': 'Ressurser', 'lekse': 'Lekse', 'vurdering': 'Vurdering', 'beskjed': 'Beskjed',
  'timeendring': 'Timeendring', 'utstyr': 'Utstyr', 'aktivitet': 'Aktivitet', 'annet': 'Annet',
};
const GENERAL_ICON = { beskjed: '📣', timeendring: '🕑', utstyr: '🎒', aktivitet: '🚌', annet: '📌' };

// Teacher-side assessments cache. The assessments list only changes when a
// teacher writes, so cache it briefly instead of refetching on every week
// change. Separate keys from the student page's 1 h cache so the TTLs don't
// interfere. Own writes clear the TTL (see vurdApi); ↻ forces fresh.
const VURD_CACHE_KEY = 'up_teacher_vurd';
const VURD_TS_KEY    = 'up_teacher_vurd_ts';
const VURD_CACHE_TTL = 10 * 60 * 1000;

// Writes that failed on an expired session – replayed after re-login.
const PENDING_WRITES_KEY = 'up_pending_writes';

let loggedIn      = false;   // set once ?action=me / login / enroll confirms a session
let isAdmin       = false;   // current teacher is an administrator
let classesTaught = [];      // union of subjectClasses (derived; kept as a var for reuse)
let kontaktClasses = [];     // subset of classesTaught where the teacher is Kontaktlærer
let subjectClasses = {};     // { subject: [classes] } – which classes each subject is taught in (server relation)
let cloning       = false;   // true while a clone request is in flight (guards double-clicks)
let editingVurd   = null; // the vurdering object being edited in the modal, or null
let selectedClass = localStorage.getItem(CLASS_KEY) || null;
let variantCode   = null;   // adapted-plan code being edited, or null

// Plan content (board, inline edits, clone, add-modal) is keyed by the variant
// code when one is active; assessments + the Oversikt tab keep using the base
// class (selectedClass), so an adapted plan inherits its class's vurderinger.
function planKey() { return variantCode || selectedClass; }

// Stored key is "<CLASS>-<SUFFIX>", but only the SUFFIX is handed to pupils –
// the class comes from their class choice, so a code resolves only with the
// right class and never reveals which class it belongs to.
function parseVariantClass(code) {
  const m = /^(\d{1,2}[A-Z])-[A-Z0-9]{3,}$/.exec(String(code || '').trim().toUpperCase());
  return m && CLASSES.includes(m[1]) ? m[1] : null;
}
function variantSuffix(full) {
  const i = String(full || '').indexOf('-');
  return i < 0 ? '' : full.slice(i + 1);
}
function genSuffix() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  // no easily-confused chars
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
let teacherName   = localStorage.getItem(TNAME_KEY) || '';
let weekMonday    = mondayOf(new Date());
let planData      = [];
let vurdData      = [];
let schoolDays    = loadCachedSchoolDays() || {};

// Add-modal working state
let modalType       = 'lekse';
let modalClasses    = [];
let modalDays       = [];    // selected day keys (empty = whole week)
let modalWeekFrom   = null;  // Date (monday) – start of the week range the modal writes to
let modalWeekTo     = null;  // Date (monday) – end of the range
let editingElement  = null;  // plan element being edited in the modal, or null
let modalSaving     = false; // true while a save is in flight (guards double-submit)

let teacherTab   = 'hjem';  // 'hjem' | 'ukeplan' | 'vurd' | 'oversikt'

let copyingRow       = false;  // row-copy in flight (guards double-clicks)
let renderDeferred   = false;  // data arrived while the teacher was typing
let renderDeferTimer = null;

// Vurderinger-tab view + filters (independent of the global class pill)
let vurdView     = 'table';    // 'table' | 'cal'
let vfClasses    = [];         // selected class filter (empty = all classes)
let vfSubjects   = [];         // selected subject filter (empty = all subjects)
let vfTeachers   = [];         // selected teacher filter (empty = all teachers)
let vfDesc       = '';         // free-text search in the description (empty = all)
// Lower date bound defaults to today so months of past assessments don't pile
// up on top of the table («Tøm alle filtre» shows everything).
let vfStart      = toISODate(new Date());
let vfEnd        = '';         // ISO date – upper date bound (empty = none)
let oversiktMode = 'prog';  // 'prog' (one class, all weeks) | 'compare' (classes, one week)
let oversiktData = [];         // all-classes plan elements for the oversikt week (compare mode)
let oversiktWeek = null;
let hjemData     = [];         // all-classes plan elements for the dashboard's viewed week
let hjemWeek     = null;       // the week hjemData is for (cache guard; null = stale)
let kontaktViewClass = null;   // which of the teacher's kontaktlærer classes is shown
let kontaktTeam  = null;       // last class_team result { class, kontakt, subjects }
let kontaktWeekData = [];      // all-classes plan elements for the coverage week
let kontaktWeek  = null;       // the week kontaktWeekData is for (cache guard)
let allPlanData  = [];         // all plan elements (progresjon mode)
let allPlanTs    = 0;
let ovFrom       = null;       // week range filter (progresjon)
let ovTo         = null;

let modalInitialDesc = '';     // description value when the modal opened (dirty check)
let modalDescEd    = null;     // the modal's rich editor (null while the plain textarea is active)
let modalPendingDesc = null;   // description to seed into the editor on the next selectModalType

// ─── Local settings (profile modal) ───────────────────────────
const SETTINGS_KEY = 'up_settings';
let settings = loadSettings();
function loadSettings() {
  const defaults = { confirmDelete: true, mySubjects: [], subjectOrder: [],
                     viewMode: 'mine', viewSubjects: [], lekseDays: { bySubjectClass: {}, bySubject: {} },
                     pinnedClasses: [], pinnedSubjects: [],
                     onboardedAt: '' };
  let s;
  try { s = Object.assign(defaults, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); }
  catch { s = Object.assign({}, defaults); }
  return migrateSettings(s);
}
// Bring older cached/loaded settings up to the current shape (scalar lekse-day,
// boolean showAll → the newer structures). Safe to run on any settings object.
function migrateSettings(s) {
  if (typeof s.defaultLekseDay === 'string') {   // old scalar → legacy per-subject fallback holder
    if (!s.lekseDays) s.lekseDays = { bySubjectClass: {}, bySubject: {} };
    delete s.defaultLekseDay;
  }
  if (!s.lekseDays || typeof s.lekseDays !== 'object') s.lekseDays = { bySubjectClass: {}, bySubject: {} };
  // Lekse-days are now per-subject-per-class (`bySubjectClass`); the old global
  // `default` is dropped and `bySubject` kept only as a read-only resolution fallback.
  delete s.lekseDays.default;
  if (!s.lekseDays.bySubjectClass || typeof s.lekseDays.bySubjectClass !== 'object') s.lekseDays.bySubjectClass = {};
  if (!s.lekseDays.bySubject || typeof s.lekseDays.bySubject !== 'object') s.lekseDays.bySubject = {};
  if (!['mine', 'valgte', 'alle'].includes(s.viewMode)) s.viewMode = (s.showAll === true) ? 'alle' : 'mine';
  delete s.showAll;
  if (!Array.isArray(s.viewSubjects)) s.viewSubjects = [];
  if (!Array.isArray(s.pinnedClasses)) s.pinnedClasses = [];
  if (!Array.isArray(s.pinnedSubjects)) s.pinnedSubjects = [];
  if (typeof s.onboardedAt !== 'string') s.onboardedAt = '';
  return s;
}
// The teacher's preferred board order (persisted). Subjects not listed fall back
// to SUBJECTS order after the ordered ones.
function subjectOrder() {
  return Array.isArray(settings.subjectOrder) ? settings.subjectOrder.filter(s => SUBJECTS.includes(s)) : [];
}
// Order a set of subjects by the saved preference, then by curriculum order.
function orderedSubjects(list) {
  const pref = subjectOrder();
  const idx = s => { const i = pref.indexOf(s); return i < 0 ? pref.length + SUBJECTS.indexOf(s) : i; };
  return list.slice().sort((a, b) => idx(a) - idx(b));
}
// Dashboard prioritization: pinned classes/subjects float to the top of the
// dashboard (cards) / a card's checklist, keeping grade / normal order within.
function pinnedClasses()  { return Array.isArray(settings.pinnedClasses)  ? settings.pinnedClasses.filter(c => CLASSES.includes(c))   : []; }
function pinnedSubjects() { return Array.isArray(settings.pinnedSubjects) ? settings.pinnedSubjects.filter(s => SUBJECTS.includes(s)) : []; }
function orderedClasses(list) {
  const pins = pinnedClasses();
  return list.slice().sort((a, b) => {
    const pa = pins.includes(a), pb = pins.includes(b);
    if (pa !== pb) return pa ? -1 : 1;            // pinned first…
    return CLASSES.indexOf(a) - CLASSES.indexOf(b);  // …grade order within each group
  });
}
function toggleClassPin(cls) {
  const cur = pinnedClasses();
  settings.pinnedClasses = cur.includes(cls) ? cur.filter(c => c !== cls) : cur.concat(cls);
  saveSettings(); renderHjem();
}
function toggleSubjectPin(subject) {
  const cur = pinnedSubjects();
  settings.pinnedSubjects = cur.includes(subject) ? cur.filter(s => s !== subject) : cur.concat(subject);
  saveSettings(); renderHjem();
}
function saveSettings() {
  // Transactional profile: while the modal is open, defer BOTH the localStorage
  // write and the server push until "Lagre" (revert on discard).
  if (profileOpen) { dirtyPrefs = true; markProfileDirty(); return; }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  saveProfileToServer();
}
// The subjects the teacher teaches (profile modal). Empty = no filtering.
function mySubjects() {
  return Array.isArray(settings.mySubjects) ? settings.mySubjects.filter(s => SUBJECTS.includes(s)) : [];
}
// The custom subset shown in the «Valgte fag» board-visibility mode.
function viewSubjects() {
  return Array.isArray(settings.viewSubjects) ? settings.viewSubjects.filter(s => SUBJECTS.includes(s)) : [];
}
// Resolved standard lekse-days for a subject in a given class: the per-subject-
// per-class (or, for electives, per-grade-year) setting, else the legacy
// per-subject value (fallback for accounts set up before this), else none.
function lekseDaysFor(subject, cls) {
  const ld = settings.lekseDays || {};
  const key = (isElective(subject) && gradeGroupOf(cls)) ? gradeGroupOf(cls).label : cls;
  const byKey = ld.bySubjectClass && ld.bySubjectClass[subject];
  const perKey = byKey && key && byKey[key];
  let days = (Array.isArray(perKey) && perKey.length) ? perKey : null;
  if (!days) {
    const legacy = ld.bySubject && ld.bySubject[subject];
    days = Array.isArray(legacy) ? legacy : [];
  }
  return days.filter(d => DAYS.includes(d));
}

// ─── Undo / redo ──────────────────────────────────────────────
// Each entry knows how to undo and redo itself against the backend.
// ref.id is mutable so a redo (which re-creates and gets a new id) keeps the
// later undo pointing at the right row.
let undoStack = [];
let redoStack = [];

// ─── Anti-autofill ────────────────────────────────────────────
// Only the login username/password may be autofilled. Everywhere else browsers
// happily inject the saved name/e-mail into lone text fields; `autocomplete=off`
// is widely ignored, so we also open each field read-only and drop that on first
// focus (autofill only targets editable fields at load).
const AUTOFILL_KEEP = new Set(['usernameInput', 'passwordInput']);
const AUTOFILL_SKIP_TYPES = new Set(['checkbox', 'radio', 'range', 'color', 'file',
  'hidden', 'submit', 'button', 'image', 'reset', 'date', 'datetime-local', 'month', 'week', 'time', 'number']);
function guardAutofill(el) {
  if (!el || el.dataset.afGuarded || AUTOFILL_KEEP.has(el.id)) return;
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
  if (AUTOFILL_SKIP_TYPES.has((el.getAttribute('type') || 'text').toLowerCase())) return;
  el.dataset.afGuarded = '1';
  el.setAttribute('autocomplete', 'off');
  el.setAttribute('data-lpignore', 'true');
  el.setAttribute('data-1p-ignore', '');
  el.readOnly = true;
  el.addEventListener('focus', () => { el.readOnly = false; });
}
function guardAutofillAll(root) { (root || document).querySelectorAll('input, textarea').forEach(guardAutofill); }

// ─── Lifecycle ────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', init);

function init() {
  setupAuthListeners();
  setupDashboardListeners();
  setupModalListeners();
  loadSchoolCalendar();

  if (selectedClass && !CLASSES.includes(selectedClass)) selectedClass = null;
  variantCode = localStorage.getItem(VARIANT_KEY) || null;
  if (variantCode) {
    const base = parseVariantClass(variantCode);
    if (base) selectedClass = base; else variantCode = null;
  }
  document.getElementById('teacherName').value = teacherName;
  updateProfileButton();

  guardAutofillAll(document);   // block autofill everywhere except the login fields
  bootstrapSession();
}

// Ask the server whether the session cookie is valid; enter the dashboard if so,
// otherwise show the login/enrol screen.
async function bootstrapSession() {
  showOverlay();
  try {
    const res = await fetch(`${SCRIPT_URL}?action=me`, { credentials: 'include' });
    const data = await res.json();
    if (data && !data.error) { enterDashboard(data); return; }
  } catch { /* offline / network – fall through to login */ }
  hideOverlay();
  showLogin();
}

// ─── Authentication (per-teacher accounts + cookie session) ───

function setupAuthListeners() {
  document.getElementById('loginForm').addEventListener('submit', handleAuthSubmit);
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
  document.getElementById('toEnrol').addEventListener('click', () => setAuthMode('enrol'));
  document.getElementById('toLogin').addEventListener('click', () => setAuthMode('login'));
  // The username/password fields autofill in login mode; in enrol mode they're
  // guarded (below), so drop read-only on focus so a new teacher can still type.
  ['usernameInput', 'passwordInput'].forEach(id =>
    document.getElementById(id).addEventListener('focus', e => { e.target.readOnly = false; }));
}

function setAuthMode(mode) {
  const form = document.getElementById('loginForm');
  const enrol = mode === 'enrol';
  form.classList.toggle('enrol', enrol);
  document.getElementById('loginSub').textContent = enrol ? 'Opprett konto med koden fra skolen' : 'Logg inn for lærere';
  document.getElementById('loginSubmit').textContent = enrol ? 'Opprett konto' : 'Logg inn';
  document.getElementById('loginError').hidden = true;
  // Creating an account should never prefill a previous teacher's saved
  // credentials (shared computers); logging in should. Toggle the two fields.
  const user = document.getElementById('usernameInput');
  const pass = document.getElementById('passwordInput');
  if (enrol) {
    user.value = ''; pass.value = '';
    user.readOnly = true; pass.readOnly = true;
    user.setAttribute('autocomplete', 'off');
    pass.setAttribute('autocomplete', 'new-password');
  } else {
    user.readOnly = false; pass.readOnly = false;
    user.setAttribute('autocomplete', 'username');
    pass.setAttribute('autocomplete', 'current-password');
  }
  const focusId = enrol ? 'enrolCode' : 'usernameInput';
  setTimeout(() => { const el = document.getElementById(focusId); if (el) el.focus(); }, 30);
}

function showAuthError(msg) {
  const el = document.getElementById('loginError');
  el.textContent = msg; el.hidden = false;
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const enrol = document.getElementById('loginForm').classList.contains('enrol');
  document.getElementById('loginError').hidden = true;
  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  const params = { action: enrol ? 'enroll' : 'login', username, password };
  if (enrol) {
    params.enrolCode = document.getElementById('enrolCode').value;
    params.name = document.getElementById('enrolName').value.trim();
    if (!params.enrolCode || !params.name) { showAuthError('Fyll ut alle feltene.'); return; }
  }
  if (!username || !password) { showAuthError('Brukernavn og passord kreves.'); return; }
  showOverlay();
  try {
    const res  = await fetch(SCRIPT_URL, { method: 'POST', credentials: 'include', body: new URLSearchParams(params) });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    localStorage.setItem(UNAME_KEY, username);
    document.getElementById('passwordInput').value = '';
    document.getElementById('enrolCode').value = '';
    enterDashboard(data);
    replayPendingWrites();
  } catch (err) {
    hideOverlay();
    showAuthError(translateError(err.message) || 'Innlogging feilet');
  }
}

// Hydrate the profile from the server response and open the dashboard.
function enterDashboard(profile) {
  applyProfile(profile);
  loggedIn = true;
  hideOverlay();
  showDashboard();
  updateClassLabel();
  updateWeekLabel();
  if (needsOnboarding()) { showOnboarding(); return; }   // new account → first-run setup
  // Smart default: have a class ready for when they click into the board.
  if (!selectedClass && classesTaught.length) {
    selectedClass = classesTaught[0];
    localStorage.setItem(CLASS_KEY, selectedClass);
    updateClassLabel();
  }
  setTeacherTab('hjem');   // land on the dashboard, not the board/class modal
}

async function handleLogout() {
  try { await fetch(SCRIPT_URL, { method: 'POST', credentials: 'include', body: new URLSearchParams({ action: 'logout' }) }); }
  catch { /* best effort – cookie clears server-side anyway */ }
  loggedIn = false; isAdmin = false;
  showLogin();
}

// A request came back Unauthorized (session lost/expired server-side).
function onSessionLost() {
  if (!loggedIn) return;
  loggedIn = false; isAdmin = false;
  showLogin();
  showToast('Økten utløp – logg inn på nytt.');
}

// ─── Server-synced profile ────────────────────────────────────
// The account's name + preferences are the source of truth; localStorage stays
// a write-through cache (instant reads + pre-paint theme).
function applyProfile(profile) {
  isAdmin = !!profile.isAdmin;
  if (profile.name) { teacherName = profile.name; localStorage.setItem(TNAME_KEY, teacherName); }
  const p = profile.preferences || {};
  settings = migrateSettings({
    confirmDelete:   p.confirmDelete !== false,                                  // default true
    mySubjects:      Array.isArray(p.mySubjects) ? p.mySubjects : [],
    subjectOrder:    Array.isArray(p.subjectOrder) ? p.subjectOrder : [],
    viewMode:        p.viewMode,
    viewSubjects:    p.viewSubjects,
    lekseDays:       p.lekseDays,
    pinnedClasses:   Array.isArray(p.pinnedClasses) ? p.pinnedClasses : [],
    pinnedSubjects:  Array.isArray(p.pinnedSubjects) ? p.pinnedSubjects : [],
    onboardedAt:     typeof p.onboardedAt === 'string' ? p.onboardedAt : '',
    showAll:         p.showAll,               // legacy → viewMode
    defaultLekseDay: p.defaultLekseDay,       // legacy → lekseDays.bySubject fallback
  });
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));                 // cache only (no server echo)
  // The subject×class matrix (server relation) is the source of truth for taught
  // classes; classesTaught is its union. Fall back to the flat classes relation
  // for accounts that predate the matrix.
  subjectClasses = sanitizeMatrix(profile.subjectClasses);
  classesTaught  = Object.keys(subjectClasses).length
    ? taughtUnion()
    : (Array.isArray(profile.classes) ? profile.classes.filter(c => CLASSES.includes(c)) : []);
  kontaktClasses = Array.isArray(profile.kontakt) ? profile.kontakt.filter(c => classesTaught.includes(c)) : [];
  if (p.theme && window.UPTheme) UPTheme.set(p.theme);
  if (p.lastClass && CLASSES.includes(p.lastClass) && !variantCode) {
    selectedClass = p.lastClass; localStorage.setItem(CLASS_KEY, selectedClass);
  }
  document.getElementById('teacherName').value = teacherName;
  updateProfileButton();
  updateAdminButton();
  updateKontaktTab();
}

// Show the Kontaktlærer tab only if the teacher is kontaktlærer for ≥1 class.
function updateKontaktTab() {
  const btn = document.getElementById('tTabKontakt');
  if (!btn) return;
  const show = kontaktClasses.length > 0;
  btn.hidden = !show;
  if (!show && teacherTab === 'kontakt') setTeacherTab('hjem');
}

// Debounced push of name + preferences to the server (called by saveSettings,
// the name/theme/class change handlers).
// While the profile modal is open, server persistence is DEFERRED so we don't
// hit the backend on every click – local state + localStorage still update
// immediately (the UI stays live), and a single "Lagre" (or a safety flush on
// close) writes the changes once. `profileOpen` gates the three savers below;
// the granular `dirty*` flags say which of the three payloads actually changed.
let profileOpen = false;
let profileDirty = false;
let dirtyPrefs = false, dirtyClasses = false, dirtyMatrix = false;
let profileSnapshot = null;   // pre-edit state, restored on discard
function markProfileDirty() { profileDirty = true; updateProfileSaveBtn(); }

let profileSaveTimer = null;
function profilePreferences() {
  return {
    confirmDelete:   settings.confirmDelete !== false,
    mySubjects:      Array.isArray(settings.mySubjects) ? settings.mySubjects : [],
    subjectOrder:    Array.isArray(settings.subjectOrder) ? settings.subjectOrder : [],
    viewMode:        settings.viewMode || 'mine',
    viewSubjects:    Array.isArray(settings.viewSubjects) ? settings.viewSubjects : [],
    lekseDays:       settings.lekseDays || { bySubjectClass: {}, bySubject: {} },
    pinnedClasses:   Array.isArray(settings.pinnedClasses) ? settings.pinnedClasses : [],
    pinnedSubjects:  Array.isArray(settings.pinnedSubjects) ? settings.pinnedSubjects : [],
    onboardedAt:     settings.onboardedAt || '',
    theme:           window.UPTheme ? UPTheme.get() : 'auto',
    lastClass:       (!variantCode && selectedClass) || '',
  };
}
function doSaveProfile() {
  return api('profile', { name: teacherName, preferences: JSON.stringify(profilePreferences()) });
}
function saveProfileToServer() {
  if (!loggedIn) return;
  if (profileOpen) { dirtyPrefs = true; markProfileDirty(); return; }
  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(() => { doSaveProfile().catch(() => {}); }, 600);
}

// Persist the taught classes + Kontaktlærer subset (server relation, debounced).
// Routes through api() so it inherits Unauthorized stash/replay handling; the
// echoed response is the source of truth (server enforces kontakt ⊆ classes).
let classesSaveTimer = null;
function doSaveClasses() {
  return api('setclasses', { classes: classesTaught.join(','), kontakt: kontaktClasses.join(',') })
    .then(r => { if (r && Array.isArray(r.classes)) { classesTaught = r.classes; kontaktClasses = r.kontakt || []; updateKontaktTab(); } });
}
function saveClassesToServer() {
  if (!loggedIn) return;
  if (profileOpen) { dirtyClasses = true; markProfileDirty(); return; }
  clearTimeout(classesSaveTimer);
  classesSaveTimer = setTimeout(() => { doSaveClasses().catch(() => {}); }, 600);
}

// ── Subject×class matrix (which classes each subject is taught in) ────────────
function sanitizeMatrix(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.keys(raw).forEach(s => {
      if (SUBJECTS.includes(s) && Array.isArray(raw[s])) {
        const cls = raw[s].filter(c => CLASSES.includes(c)).filter((c, i, a) => a.indexOf(c) === i);
        if (cls.length) out[s] = cls;
      }
    });
  }
  return out;
}
function taughtUnion() { return CLASSES.filter(c => Object.values(subjectClasses).some(l => l.includes(c))); }
function classesForSubject(s) { return (subjectClasses[s] || []).filter(c => CLASSES.includes(c)); }

// Recompute the derived union + keep kontakt ⊆ union, and sync the classes
// relation (teacher_classes stays the taught-union + kontaktlærer mirror).
function recomputeTaught() {
  classesTaught = taughtUnion();
  kontaktClasses = kontaktClasses.filter(c => classesTaught.includes(c));
  saveClassesToServer();
}
function toggleSubjectClass(subject, cls) {
  const cur = classesForSubject(subject);
  subjectClasses[subject] = cur.includes(cls) ? cur.filter(c => c !== cls) : cur.concat(cls);
  if (!subjectClasses[subject].length) delete subjectClasses[subject];
  recomputeTaught();
  saveSubjectClassesToServer();
}
function setSubjectClasses(subject, list, on) {
  const cur = new Set(classesForSubject(subject));
  list.forEach(c => { if (on) cur.add(c); else cur.delete(c); });
  if (cur.size) subjectClasses[subject] = CLASSES.filter(c => cur.has(c));
  else delete subjectClasses[subject];
  recomputeTaught();
  saveSubjectClassesToServer();
}
let subjectClassesSaveTimer = null;
function doSaveSubjectClasses() {
  return api('setsubjectclasses', { matrix: JSON.stringify(subjectClasses) })
    .then(r => { if (r && r.subjectClasses) subjectClasses = sanitizeMatrix(r.subjectClasses); });
}
function saveSubjectClassesToServer() {
  if (!loggedIn) return;
  if (profileOpen) { dirtyMatrix = true; markProfileDirty(); return; }
  clearTimeout(subjectClassesSaveTimer);
  subjectClassesSaveTimer = setTimeout(() => { doSaveSubjectClasses().catch(() => {}); }, 600);
}

// Flush whatever changed in the open profile modal in one go (only the changed
// payloads). Used by the "Lagre" button and as a safety net on modal close.
// Resolves to true when every issued save succeeded.
function flushProfileSaves() {
  clearTimeout(profileSaveTimer); clearTimeout(classesSaveTimer); clearTimeout(subjectClassesSaveTimer);
  const tasks = [];
  if (dirtyPrefs)   tasks.push(['prefs',   doSaveProfile()]);
  if (dirtyClasses) tasks.push(['classes', doSaveClasses()]);
  if (dirtyMatrix)  tasks.push(['matrix',  doSaveSubjectClasses()]);
  return Promise.allSettled(tasks.map(t => t[1])).then(rs => {
    let allOk = true;
    rs.forEach((r, i) => {
      if (r.status === 'fulfilled') {          // clear only what actually saved,
        const key = tasks[i][0];                // so a failed one stays dirty for retry
        if (key === 'prefs') dirtyPrefs = false;
        else if (key === 'classes') dirtyClasses = false;
        else dirtyMatrix = false;
      } else allOk = false;
    });
    return allOk;
  });
}
// Reflect unsaved-changes state on the Lagre button.
function updateProfileSaveBtn(justSaved) {
  const btn = document.getElementById('profileSaveBtn');
  if (!btn) return;
  if (profileDirty && !justSaved) { btn.disabled = false; btn.textContent = 'Lagre'; btn.classList.add('has-changes'); }
  else { btn.disabled = true; btn.textContent = 'Lagret ✓'; btn.classList.remove('has-changes'); }
}
async function saveProfileNow() {
  if (!profileDirty) return;
  const btn = document.getElementById('profileSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Lagrer…'; btn.classList.remove('has-changes'); }
  // Commit the deferred local caches, then push to the server.
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  localStorage.setItem(TNAME_KEY, teacherName);
  const ok = await flushProfileSaves();
  if (ok) {
    profileSnapshot = snapshotProfileState();   // new baseline = the saved state
    profileDirty = false;
    updateProfileSaveBtn(true);
  } else { showToast('Kunne ikke lagre alt – prøv igjen.'); updateProfileSaveBtn(); }   // still dirty → button re-enables
}

function updateAdminButton() {
  const btn = document.getElementById('adminPanelBtn');
  if (btn) btn.hidden = !isAdmin;
}

// ─── Pending-write replay ─────────────────────────────────────
// A write that fails on a lost session is stashed here and replayed right after
// the next successful login (a safety net – rare now that sessions persist).
function stashPendingWrite(action, params) {
  try {
    const arr = JSON.parse(sessionStorage.getItem(PENDING_WRITES_KEY)) || [];
    arr.push({ ts: Date.now(), action, params });
    sessionStorage.setItem(PENDING_WRITES_KEY, JSON.stringify(arr));
  } catch { /* best-effort */ }
}

async function replayPendingWrites() {
  let arr = [];
  try { arr = JSON.parse(sessionStorage.getItem(PENDING_WRITES_KEY)) || []; } catch { arr = []; }
  sessionStorage.removeItem(PENDING_WRITES_KEY);
  if (!arr.length) return;
  // Replay only recent stashes – an hours-old edit could overwrite newer work.
  const fresh = arr.filter(w => Date.now() - w.ts < 60 * 60 * 1000);
  let ok = 0;
  for (const w of fresh) {
    try { await api(w.action, w.params); ok++; } catch { /* counted as lost below */ }
  }
  const lost = arr.length - ok;
  if (ok) {
    showToast('Lagret ' + ok + ' endring(er) som ikke rakk å bli lagret før du ble logget ut.'
      + (lost ? ' ' + lost + ' kunne ikke gjenopprettes.' : ''), { duration: 7000 });
    loadData({ background: true, skipCache: true });
  } else if (lost) {
    showToast(lost + ' ulagret endring(er) kunne ikke gjenopprettes. Sjekk uka du jobbet i.', { duration: 7000 });
  }
}

function showLogin() {
  stopHjemPoll();
  document.getElementById('dashboard').hidden = true;
  document.getElementById('loginScreen').classList.add('active');
  setAuthMode('login');
  const uname = localStorage.getItem(UNAME_KEY) || '';
  document.getElementById('usernameInput').value = uname;
  document.getElementById('passwordInput').value = '';
  hideOverlay();
  setTimeout(() => document.getElementById(uname ? 'passwordInput' : 'usernameInput').focus(), 60);
}

function showDashboard() {
  document.getElementById('loginScreen').classList.remove('active');
  document.getElementById('dashboard').hidden = false;
}

// ─── Authenticated API helper ─────────────────────────────────

async function api(action, params = {}) {
  const res  = await fetch(SCRIPT_URL, { method: 'POST', credentials: 'include',
    body: new URLSearchParams(Object.assign({ action }, params)) });
  const data = await res.json();
  if (data && data.error) {
    if (data.error === 'Unauthorized') {
      // Don't lose the edit that hit the dead session – stash it and replay
      // it after the next login (replayPendingWrites).
      if (['create','update','delete','vurdcreate','vurdupdate','vurddelete','setclasses','setsubjectclasses'].includes(action)) stashPendingWrite(action, params);
      onSessionLost();
    }
    throw new Error(data.error);
  }
  // Any plan-element write makes the dashboard's week snapshot stale (inline
  // board commits don't go through refreshAfterChange).
  if (['create', 'update', 'delete', 'clone'].includes(action)) hjemWeek = null;
  return data;
}

// ─── Assessments (vurderinger) ────────────────────────────────
// Assessments now live in our own backend, under their own actions
// (vurdcreate/vurdupdate/vurddelete) and the SAME teacher token as everything
// else. So writes go through api() and inherit its Unauthorized stash/replay
// handling – no separate login or token.

async function vurdApi(action, params = {}) {
  const data = await api('vurd' + action, params);   // vurdcreate | vurdupdate | vurddelete
  localStorage.removeItem(VURD_TS_KEY);              // own write → next loadAssessments refetches
  return data;
}

// ─── Undo / redo plumbing ─────────────────────────────────────

function updateUndoUI() {
  const u = document.getElementById('undoBtn'), r = document.getElementById('redoBtn');
  if (u) u.disabled = undoStack.length === 0;
  if (r) r.disabled = redoStack.length === 0;
}
function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > 50) undoStack.shift();
  redoStack = [];
  updateUndoUI();
}
async function doUndo() {
  const entry = undoStack.pop();
  if (!entry) return;
  updateUndoUI();
  setSaving();
  try {
    await entry.undo();
    redoStack.push(entry);
    setSaved();
    showToast('Angret: ' + entry.label, { duration: 4000, action: { label: 'Gjør om', onClick: doRedo } });
    refreshAfterChange();
  } catch (err) {
    undoStack.push(entry);   // undo failed – keep it
    setSaveError(err.message);
  }
  updateUndoUI();
}
async function doRedo() {
  const entry = redoStack.pop();
  if (!entry) return;
  updateUndoUI();
  setSaving();
  try {
    await entry.redo();
    undoStack.push(entry);
    setSaved();
    showToast('Gjorde om: ' + entry.label, { duration: 3000 });
    refreshAfterChange();
  } catch (err) {
    redoStack.push(entry);
    setSaveError(err.message);
  }
  updateUndoUI();
}

// Fields needed to re-create / update a plan element.
function elementCreateParams(el) {
  return {
    type: el.type, classes: el.classes, week: el.week, weekTo: el.weekTo || '',
    day: el.day || '', subject: el.subject || '', description: el.description || '',
    teacher: el.teacher || teacherName,
  };
}
function elementUpdateFields(el) {
  return el ? elementCreateParams(el) : null;
}
function findLoadedElement(id) {
  return planData.find(p => p.id === id) || allPlanData.find(p => p.id === id) ||
         oversiktData.find(p => p.id === id) || null;
}

// Record helpers (plan elements via api()).
function recordCreate(params, id, label) {
  const ref = { id };
  pushUndo({
    label: label || 'la til',
    undo: () => api('delete', { id: ref.id }),
    redo: async () => { const r = await api('create', params); ref.id = r && r.id; },
  });
}
function recordCreateMany(creates, label) {
  const refs = creates.map(c => ({ id: c.id, params: c.params }));
  pushUndo({
    label: label || 'la til',
    undo: () => Promise.all(refs.map(r => api('delete', { id: r.id }))),
    redo: () => Promise.all(refs.map(async r => { const x = await api('create', r.params); r.id = x && x.id; })),
  });
}
// One undo entry that reverts both plan-element and vurdering creates together
// (used by the row-copy, which may create both in one action).
function recordMixedCreate({ elems = [], vurds = [] }, label) {
  const e = elems.map(c => ({ id: c.id, params: c.params }));
  const v = vurds.map(c => ({ id: c.id, params: c.params }));
  if (!e.length && !v.length) return;
  pushUndo({
    label: label || 'kopierte',
    undo: () => Promise.all([
      ...e.map(r => api('delete', { id: r.id })),
      ...v.map(r => vurdApi('delete', { id: r.id })),
    ]),
    redo: () => Promise.all([
      ...e.map(async r => { const x = await api('create', r.params); r.id = x && x.id; }),
      ...v.map(async r => { const x = await vurdApi('create', r.params); r.id = x && x.id; }),
    ]),
  });
}
function recordDelete(el, label) {
  const params = elementCreateParams(el);
  const ref = { id: el.id };
  pushUndo({
    label: label || 'slettet',
    undo: async () => { const r = await api('create', params); ref.id = r && r.id; },
    redo: () => api('delete', { id: ref.id }),
  });
}
function recordUpdate(id, before, after, label) {
  if (!before) return;
  pushUndo({
    label: label || 'endret',
    undo: () => api('update', Object.assign({ id }, before)),
    redo: () => api('update', Object.assign({ id }, after)),
  });
}

// Record helpers (assessments via vurdApi()).
function vurdCreateParams(v) {
  return { date: v.date, subject: v.subject || '', classes: v.classes || '',
           description: v.description || v.notes || '', teacher: v.teacher || '' };
}
function recordVurdCreate(params, id, label) {
  const ref = { id };
  pushUndo({
    label: label || 'la til vurdering',
    undo: () => vurdApi('delete', { id: ref.id }),
    redo: async () => { const r = await vurdApi('create', params); ref.id = r && r.id; },
  });
}
function recordVurdDelete(v, label) {
  const params = vurdCreateParams(v);
  const ref = { id: v.id };
  pushUndo({
    label: label || 'slettet vurdering',
    undo: async () => { const r = await vurdApi('create', params); ref.id = r && r.id; },
    redo: () => vurdApi('delete', { id: ref.id }),
  });
}
function recordVurdUpdate(id, before, after, label) {
  pushUndo({
    label: label || 'endret vurdering',
    undo: () => vurdApi('update', Object.assign({ id }, before)),
    redo: () => vurdApi('update', Object.assign({ id }, after)),
  });
}

// ─── Delete confirmation (A1) ─────────────────────────────────
// Shown when a cell that HAD content is emptied. Can be turned off via the
// "ikke spør igjen" checkbox, and back on from the profile modal.
function confirmDeletion(message) {
  if (settings.confirmDelete === false) return Promise.resolve(true);
  return buildUiDialog({
    title: 'Slette innhold?',
    render: ctx => {
      const p = document.createElement('p'); p.className = 'ui-dialog-message'; p.textContent = message; ctx.body.appendChild(p);
      const lab = document.createElement('label'); lab.className = 'ui-dialog-check';
      const cb = document.createElement('input'); cb.type = 'checkbox';
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' Ikke spør om dette igjen'));
      ctx.body.appendChild(lab);
      return { cb };
    },
    buttons: [
      { label: 'Avbryt', className: 'btn-ghost', value: false },
      { label: 'Slett', className: 'btn-danger', primary: true, onClick: (ctx, f) => {
        if (f.cb.checked) { settings.confirmDelete = false; saveSettings(); }
        return true;
      } },
    ],
  }).then(v => v === true);
}
// Put the previous text back into a cleared cell when a deletion is cancelled.
function restoreRichCell(ed, ids) {
  const html = ids.map(id => { const el = findLoadedElement(id); return el && el.description; }).filter(Boolean).join('<br>');
  ed.innerHTML = sanitizeHtml(html);
  ed._original = ed.innerHTML;
}

// ─── Profile / settings modal ─────────────────────────────────
function updateProfileButton() {
  const el = document.getElementById('profileBtnName');
  if (el) el.textContent = teacherName || 'Lærer';
}
// Reflect the current theme preference on the segmented control.
function syncThemeSeg() {
  const pref = window.UPTheme ? UPTheme.get() : 'auto';
  document.querySelectorAll('#themeSeg .theme-seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.themePref === pref);
  });
}

// ─── Admin panel (administrators only) ────────────────────────
let adminTeachers = [];   // last-fetched full teacher list (for client-side search)
function openAdminModal() {
  document.getElementById('adminOverlay').classList.add('open');
  document.getElementById('adminModal').classList.add('open');
  document.body.classList.add('scroll-locked');
  const search = document.getElementById('adminSearch');
  if (search) search.value = '';
  loadAdminTeachers();
}
function closeAdminModal() {
  document.getElementById('adminOverlay').classList.remove('open');
  document.getElementById('adminModal').classList.remove('open');
  document.body.classList.remove('scroll-locked');
}
async function loadAdminTeachers() {
  const list = document.getElementById('adminList');
  list.innerHTML = '<p class="muted">Laster…</p>';
  try {
    const res = await fetch(`${SCRIPT_URL}?action=admin_teachers`, { credentials: 'include' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    adminTeachers = Array.isArray(data) ? data : [];
    renderAdminTeachers();
  } catch (err) {
    adminTeachers = [];
    list.innerHTML = '';
    const p = document.createElement('p'); p.className = 'login-error'; p.textContent = translateError(err.message);
    list.appendChild(p);
  }
}
function renderAdminTeachers() {
  const list = document.getElementById('adminList');
  const countEl = document.getElementById('adminCount');
  const q = (document.getElementById('adminSearch')?.value || '').trim().toLowerCase();
  list.innerHTML = '';
  if (!adminTeachers.length) {
    list.innerHTML = '<p class="muted">Ingen lærere ennå.</p>';
    if (countEl) countEl.textContent = '';
    return;
  }
  const teachers = q
    ? adminTeachers.filter(t => (t.name || '').toLowerCase().includes(q) || (t.username || '').toLowerCase().includes(q))
    : adminTeachers;
  if (countEl) {
    countEl.textContent = q
      ? `${teachers.length} av ${adminTeachers.length}`
      : `${adminTeachers.length} ${adminTeachers.length === 1 ? 'lærer' : 'lærere'}`;
  }
  if (!teachers.length) { list.innerHTML = '<p class="muted">Ingen treff.</p>'; return; }
  teachers.forEach(t => {
    const row = document.createElement('div');
    row.className = 'admin-row' + (t.active ? '' : ' inactive');
    const info = document.createElement('div');
    const nm = document.createElement('div'); nm.className = 'admin-row-name';
    nm.textContent = t.name + (t.isAdmin ? ' · admin' : '');
    const un = document.createElement('div'); un.className = 'admin-row-user';
    un.textContent = '@' + t.username + (t.active ? '' : ' · deaktivert');
    info.appendChild(nm); info.appendChild(un);
    const actions = document.createElement('div'); actions.className = 'admin-row-actions';
    const resetBtn = document.createElement('button'); resetBtn.className = 'btn btn-ghost btn-tiny';
    resetBtn.textContent = 'Nullstill passord';
    resetBtn.addEventListener('click', () => adminResetPassword(t));
    const ownUsername = localStorage.getItem(UNAME_KEY);
    const isSelf = t.username === ownUsername;
    actions.appendChild(resetBtn);
    // No (de)activate on your own row – an admin must not lock themselves out
    // (the server enforces this too).
    if (!isSelf) {
      const toggleBtn = document.createElement('button'); toggleBtn.className = 'btn btn-ghost btn-tiny';
      toggleBtn.textContent = t.active ? 'Deaktiver' : 'Aktiver';
      toggleBtn.addEventListener('click', () => adminToggleActive(t));
      actions.appendChild(toggleBtn);
    }
    // Permanent delete is offered only for an already-deactivated account, and
    // never for your own row (the server enforces both too).
    if (!t.active && !isSelf) {
      const delBtn = document.createElement('button'); delBtn.className = 'btn btn-ghost btn-tiny admin-del-btn';
      delBtn.textContent = 'Slett';
      delBtn.addEventListener('click', () => adminDeleteAccount(t));
      actions.appendChild(delBtn);
    }
    row.appendChild(info); row.appendChild(actions);
    list.appendChild(row);
  });
}
async function adminDeleteAccount(t) {
  const ok = await uiConfirm(
    'Slette kontoen til ' + t.name + ' (@' + t.username + ') permanent? Dette kan ikke angres.\n\n' +
    'Innhold de har lagt inn (ukeplan, vurderinger) blir liggende – det er ikke knyttet til kontoen og kan fortsatt redigeres av andre.',
    { title: 'Slett konto', okText: 'Slett', danger: true });
  if (!ok) return;
  try {
    const r = await api('admin_delete', { id: t.id });
    if (r.error) throw new Error(r.error);
    showToast('Kontoen til ' + t.name + ' ble slettet.');
    loadAdminTeachers();
  } catch (err) { showToast(translateError(err.message)); }
}
async function adminResetPassword(t) {
  const pw = await uiPrompt('Nytt midlertidig passord for ' + t.name + ' (@' + t.username + '). Minst 6 tegn. Gi det til læreren – de kan endre passordet selv senere.',
    { title: 'Nullstill passord', label: 'Nytt passord', password: true, okText: 'Nullstill' });
  if (!pw) return;
  if (pw.length < 6) { showToast('Passordet må ha minst 6 tegn.'); return; }
  try {
    const r = await api('admin_reset', { id: t.id, password: pw });
    if (r.error) throw new Error(r.error);
    showToast('Passordet ble nullstilt for ' + t.name + '.');
  } catch (err) { showToast(translateError(err.message)); }
}
async function adminToggleActive(t) {
  const activate = !t.active;
  if (!activate && !(await uiConfirm('Deaktivere ' + t.name + '? Brukeren blir logget ut og kan ikke logge inn før kontoen aktiveres igjen.'))) return;
  try {
    const r = await api('admin_setactive', { id: t.id, active: activate ? '1' : '0' });
    if (r.error) throw new Error(r.error);
    loadAdminTeachers();
  } catch (err) { showToast(translateError(err.message)); }
}

async function changeOwnPassword() {
  const cur = document.getElementById('pwCurrent');
  const nw  = document.getElementById('pwNew');
  const nw2 = document.getElementById('pwNew2');
  const msg = document.getElementById('pwChangeMsg');
  msg.style.color = ''; msg.textContent = '';
  const currentPassword = cur.value, newPassword = nw.value, confirm = nw2.value;
  if (!currentPassword || !newPassword || !confirm) { msg.textContent = 'Fyll ut alle feltene.'; return; }
  if (newPassword.length < 6) { msg.textContent = 'Nytt passord må ha minst 6 tegn.'; return; }
  if (newPassword !== confirm) { msg.textContent = 'Passordene er ikke like.'; return; }
  try {
    const r = await api('changepw', { currentPassword, newPassword });
    if (r.error) throw new Error(r.error);
    cur.value = ''; nw.value = ''; nw2.value = '';
    msg.style.color = 'var(--success)'; msg.textContent = 'Passordet er endret ✓';
    setTimeout(() => { const d = document.querySelector('.pw-change'); if (d) d.open = false; msg.textContent = ''; }, 2500);
  } catch (err) {
    msg.style.color = 'var(--danger)'; msg.textContent = translateError(err.message);
  }
}

// Standard-lekse-day rows for ONE subject (rendered inside that subject's details
// in «Mine klasser»): one day-row per class the teacher teaches it in – or, for an
// elective (a year-level unit), one row per grade-year. Keyed in
// lekseDays.bySubjectClass[subject][key] (key = class name, or grade label for
// electives). Resolved by lekseDaysFor.
function buildLekseDayRows(container, subject) {
  container.innerHTML = '';
  const ld = settings.lekseDays || (settings.lekseDays = { bySubjectClass: {}, bySubject: {} });
  if (!ld.bySubjectClass) ld.bySubjectClass = {};

  const makeDayRow = (labelText, getDays, setDays) => {
    const wrap = document.createElement('div');
    wrap.className = 'lekseday-row';
    const lbl = document.createElement('span');
    lbl.className = 'lekseday-label';
    lbl.textContent = labelText;
    wrap.appendChild(lbl);
    const btns = document.createElement('div');
    btns.className = 'lekseday-days';
    DAYS.forEach(d => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'day-btn' + (getDays().includes(d) ? ' active' : '');
      b.textContent = DAY_LABEL[d];
      b.addEventListener('click', () => {
        const cur = getDays();
        setDays(cur.includes(d) ? cur.filter(x => x !== d) : cur.concat(d));
        b.classList.toggle('active');
        saveSettings();
      });
      btns.appendChild(b);
    });
    wrap.appendChild(btns);
    return wrap;
  };
  const dayBinding = key => ({
    get: () => (ld.bySubjectClass[subject] && ld.bySubjectClass[subject][key]) || [],
    set: v => {
      if (!ld.bySubjectClass[subject]) ld.bySubjectClass[subject] = {};
      if (v.length) ld.bySubjectClass[subject][key] = v; else delete ld.bySubjectClass[subject][key];
      if (!Object.keys(ld.bySubjectClass[subject]).length) delete ld.bySubjectClass[subject];
    },
  });

  const head = document.createElement('p');
  head.className = 'lekseday-head';
  head.textContent = 'Standard lekse-dager';
  container.appendChild(head);

  const classes = classesForSubject(subject);
  if (!classes.length) {
    const note = document.createElement('p');
    note.className = 'form-hint';
    note.textContent = 'Velg klasser for faget over først.';
    container.appendChild(note);
    return;
  }
  if (isElective(subject)) {   // one row per grade-year the teacher has it in
    CLASS_GRADES.filter(g => g.classes.some(c => classes.includes(c)))
      .forEach(g => { const b = dayBinding(g.label); container.appendChild(makeDayRow(g.label + ' trinn', b.get, b.set)); });
  } else {                     // one row per class
    classes.forEach(cls => { const b = dayBinding(cls); container.appendChild(makeDayRow(cls, b.get, b.set)); });
  }
}

function openProfileModal() {
  document.getElementById('teacherName').value = teacherName;
  document.getElementById('setConfirmDelete').checked = settings.confirmDelete !== false;
  profileOpen = true;   // transactional: nothing is committed until "Lagre"
  profileDirty = false; dirtyPrefs = dirtyClasses = dirtyMatrix = false;
  profileSnapshot = snapshotProfileState();   // to revert on discard
  buildMySubjectChips();
  buildProfileClasses();   // per-subject class pickers + lekse-days live in here now
  syncThemeSeg();
  setProfileTab('fag');   // always open on the first tab
  updateProfileSaveBtn();
  document.getElementById('profileOverlay').classList.add('open');
  document.getElementById('profileModal').classList.add('open');
  document.body.classList.add('scroll-locked');
  // No autofocus: the default tab (Fag & klasser) has no obvious single field,
  // and focusing anything here would pop the mobile keyboard on open.
}
// Switch the profile modal's visible section (tabbed sub-pages). Mirrors
// setTeacherTab: flip .active/aria-selected on the buttons and `hidden` on panes.
function setProfileTab(tab) {
  [['fag', 'ptabFag', 'ppaneFag'], ['innst', 'ptabInnst', 'ppaneInnst'], ['konto', 'ptabKonto', 'ppaneKonto']]
    .forEach(([t, btnId, paneId]) => {
      const btn = document.getElementById(btnId);
      btn.classList.toggle('active', t === tab);
      btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      document.getElementById(paneId).hidden = t !== tab;
    });
}
// A deep copy of everything the profile modal can edit, so a discard restores it.
function snapshotProfileState() {
  return {
    teacherName,
    settings:       JSON.parse(JSON.stringify(settings)),
    subjectClasses: JSON.parse(JSON.stringify(subjectClasses)),
    classesTaught:  classesTaught.slice(),
    kontaktClasses: kontaktClasses.slice(),
    theme:          window.UPTheme ? UPTheme.get() : 'auto',
  };
}
// Discard: restore in-memory state from the snapshot. localStorage was never
// written while the modal was open (transactional), so it already matches the
// snapshot – only the live-applied theme needs re-applying.
function revertProfileState() {
  if (!profileSnapshot) return;
  teacherName    = profileSnapshot.teacherName;
  settings       = JSON.parse(JSON.stringify(profileSnapshot.settings));
  subjectClasses = JSON.parse(JSON.stringify(profileSnapshot.subjectClasses));
  classesTaught  = profileSnapshot.classesTaught.slice();
  kontaktClasses = profileSnapshot.kontaktClasses.slice();
  if (window.UPTheme) UPTheme.set(profileSnapshot.theme);
  updateProfileButton();
  updateKontaktTab();
}
// Attempt to close the modal. With unsaved changes, confirm a discard first;
// `{ force }` skips the guard (used after a successful save). Returns whether the
// modal actually closed, so callers (logout, rerun onboarding) can chain.
async function closeProfileModal(opts = {}) {
  const force = opts === true || opts.force;   // tolerate a stray event arg
  if (!force && profileDirty) {
    const discard = await uiConfirm('Du har ulagrede endringer i profilen. Vil du forkaste dem?',
      { title: 'Ulagrede endringer', okText: 'Forkast', danger: true });
    if (!discard) return false;   // stay open
    revertProfileState();
  }
  profileOpen = false;
  profileDirty = false; dirtyPrefs = dirtyClasses = dirtyMatrix = false;
  document.getElementById('teacherName').value = teacherName;
  document.getElementById('profileOverlay').classList.remove('open');
  document.getElementById('profileModal').classList.remove('open');
  document.body.classList.remove('scroll-locked');
  render();   // Mine fag may have changed (if saved)
  return true;
}

// Reusable grouped subject chip picker: a "Valgt"-summary, a search box, core
// subjects as chips + valgfag behind an expander. getSelected() → string[];
// onToggle(subject) mutates + persists and returns the new selected state
// (may be async, e.g. a deselect confirmation); opts.onChange fires after a change.
// A compact subject picker: the CHOSEN subjects show as removable chips, and a
// "Legg til fag" button reveals the full grouped search picker (progressive
// disclosure) instead of a wall of 22 toggles. Shared by «Mine fag» (profile)
// and the «Valgte fag» modal – signature is unchanged.
function buildSubjectChipPicker(container, getSelected, onToggle, opts = {}) {
  container.innerHTML = '';
  container.classList.add('mysubj-picker');
  const nb = (a, b) => a.localeCompare(b, 'no');

  const chosen = document.createElement('div');
  chosen.className = 'mysubj-chosen';
  container.appendChild(chosen);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'mysubj-add';
  addBtn.textContent = '+ Legg til fag';
  container.appendChild(addBtn);

  // The full grouped picker, hidden until "Legg til fag" is pressed.
  const panel = document.createElement('div');
  panel.className = 'mysubj-addpanel';
  panel.hidden = true;
  container.appendChild(panel);

  const search = document.createElement('input');
  search.type = 'text'; search.className = 'input mysubj-search';
  search.placeholder = 'Søk etter fag…';
  // Dynamically created, so guard it here too (the startup sweep already ran).
  search.setAttribute('name', 'fagsok');
  search.setAttribute('autocapitalize', 'off');
  search.setAttribute('autocorrect', 'off');
  search.setAttribute('spellcheck', 'false');
  guardAutofill(search);
  panel.appendChild(search);

  const makeChip = s => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vf-chip' + (getSelected().includes(s) ? ' active' : '');
    btn.dataset.subject = s;
    btn.textContent = s;
    btn.addEventListener('click', async () => {
      await onToggle(s);
      updateUI();   // re-reads the true selection (an onToggle may veto via uiConfirm)
      if (opts.onChange) opts.onChange();
    });
    return btn;
  };

  const core = document.createElement('div');
  core.className = 'vf-chip-row mysubj-group';
  CORE_SUBJECTS.slice().sort(nb).forEach(s => core.appendChild(makeChip(s)));
  panel.appendChild(core);

  const det = document.createElement('details');
  det.className = 'mysubj-electives';
  const sum = document.createElement('summary');
  sum.textContent = 'Valgfag og tilvalgsfag';
  det.appendChild(sum);
  const elw = document.createElement('div');
  elw.className = 'vf-chip-row mysubj-group';
  ELECTIVE_SUBJECTS.slice().sort(nb).forEach(s => elw.appendChild(makeChip(s)));
  det.appendChild(elw);
  panel.appendChild(det);

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let elecHit = false;
    panel.querySelectorAll('.vf-chip').forEach(ch => {
      const match = !q || ch.dataset.subject.toLowerCase().includes(q);
      ch.style.display = match ? '' : 'none';
      if (match && q && ELECTIVE_SUBJECTS.includes(ch.dataset.subject)) elecHit = true;
    });
    if (elecHit) det.open = true;
  });

  addBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    addBtn.classList.toggle('open', !panel.hidden);
    if (!panel.hidden) {
      if (ELECTIVE_SUBJECTS.some(s => getSelected().includes(s))) det.open = true;
      setTimeout(() => search.focus(), 30);
    }
  });

  // Rebuild the chosen-chips row and re-sync the panel chip states from the
  // current selection (single source of truth = getSelected()).
  function updateUI() {
    const cur = getSelected().slice().sort(nb);
    chosen.innerHTML = '';
    if (!cur.length) {
      const empty = document.createElement('p');
      empty.className = 'mysubj-empty';
      empty.textContent = opts.emptyLabel || 'Ingen valgt.';
      chosen.appendChild(empty);
    } else {
      cur.forEach(s => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'mysubj-chip';
        chip.setAttribute('aria-label', 'Fjern ' + s);
        chip.title = 'Fjern ' + s;
        const lab = document.createElement('span'); lab.className = 'mysubj-chip-label'; lab.textContent = s;
        const x = document.createElement('span'); x.className = 'mysubj-chip-x'; x.setAttribute('aria-hidden', 'true'); x.textContent = '×';
        chip.appendChild(lab); chip.appendChild(x);
        chip.addEventListener('click', async () => {
          await onToggle(s);
          updateUI();
          if (opts.onChange) opts.onChange();
        });
        chosen.appendChild(chip);
      });
    }
    panel.querySelectorAll('.vf-chip').forEach(ch => {
      ch.classList.toggle('active', getSelected().includes(ch.dataset.subject));
    });
  }

  updateUI();
}

// Toggle a Mine-fag subject. Deselecting one that has per-subject settings asks
// for confirmation first (so a stray click can't quietly drop its lekse-days).
async function toggleMySubject(s) {
  const cur = mySubjects();
  if (cur.includes(s)) {
    const ld = settings.lekseDays || {};
    const hasClassDays = ld.bySubjectClass && ld.bySubjectClass[s] && Object.keys(ld.bySubjectClass[s]).length;
    const hasLegacy = ld.bySubject && Array.isArray(ld.bySubject[s]) && ld.bySubject[s].length;
    if ((hasClassDays || hasLegacy) && !(await uiConfirm(s + ' har egne lekse-dager. Vil du fjerne faget og disse innstillingene?'))) {
      return true;   // keep selected
    }
    settings.mySubjects = cur.filter(x => x !== s);
    if (ld.bySubjectClass) delete ld.bySubjectClass[s];
    if (ld.bySubject) delete ld.bySubject[s];
    settings.viewSubjects = viewSubjects().filter(x => x !== s);
    saveSettings();
    return false;
  }
  settings.mySubjects = cur.concat(s);
  saveSettings();
  return true;
}
function toggleViewSubject(s) {
  const cur = viewSubjects();
  settings.viewSubjects = cur.includes(s) ? cur.filter(x => x !== s) : cur.concat(s);
  saveSettings();
  return settings.viewSubjects.includes(s);
}

// «Mine fag» chips in the profile modal. Empty selection = show all subjects.
function buildMySubjectChips() {
  const row = document.getElementById('setMySubjects');
  if (!row) return;
  buildSubjectChipPicker(row, mySubjects, toggleMySubject, {
    summaryLabel: 'Dine fag',
    emptyLabel: 'Ingen fag valgt – da vises alle fag.',
    onChange: () => { buildProfileClasses(); },   // per-subject class + lekse rows depend on Mine fag
  });
}

// ─── Taught classes + Kontaktlærer (shared by onboarding + profile) ──────────
// Toggle whether the teacher teaches a class. Dropping a class also drops it
// from the Kontaktlærer subset (kontakt ⊆ taught).
function toggleTaughtClass(cls) {
  if (classesTaught.includes(cls)) {
    classesTaught = classesTaught.filter(c => c !== cls);
    kontaktClasses = kontaktClasses.filter(c => c !== cls);
  } else {
    classesTaught = classesTaught.concat(cls);
  }
  saveClassesToServer();
}
// Toggle Kontaktlærer for a class – only meaningful for a taught class.
function toggleKontaktClass(cls) {
  if (!classesTaught.includes(cls)) return;
  kontaktClasses = kontaktClasses.includes(cls)
    ? kontaktClasses.filter(c => c !== cls)
    : kontaktClasses.concat(cls);
  saveClassesToServer();
  updateKontaktTab();
}

// Bulk (de)select taught classes (used by the "Velg alle" controls). One save.
function setTaughtClasses(list, on) {
  list.forEach(cls => {
    const has = classesTaught.includes(cls);
    if (on && !has) classesTaught = classesTaught.concat(cls);
    if (!on && has) {
      classesTaught = classesTaught.filter(c => c !== cls);
      kontaktClasses = kontaktClasses.filter(c => c !== cls);   // kontakt ⊆ taught
    }
  });
  saveClassesToServer();
}

// Grade-grouped class picker, bound to a selection via `opts.has(cls)` /
// `opts.toggle(cls)` / `opts.setAll(list,on)` (default = the taught-class union;
// callers pass a per-subject binding for the matrix). `opts.selectAll` adds a
// "Velg alle" per grade + a whole-school control. Rebuilds itself on a bulk op.
function buildClassPicker(container, opts = {}) {
  const has    = opts.has    || (cls => classesTaught.includes(cls));
  const toggle = opts.toggle || toggleTaughtClass;
  const setAll = opts.setAll || setTaughtClasses;
  const selectAll = opts.selectAll !== false;
  container.innerHTML = '';
  container.classList.add('class-picker');

  if (selectAll) {
    const bar = document.createElement('div');
    bar.className = 'class-selectall-bar';
    const allOn = CLASSES.every(has);
    const allBtn = document.createElement('button');
    allBtn.type = 'button'; allBtn.className = 'link-btn';
    allBtn.textContent = allOn ? 'Fjern alle klasser' : 'Velg alle klasser (hele skolen)';
    allBtn.addEventListener('click', () => { setAll(CLASSES, !allOn); buildClassPicker(container, opts); if (opts.onChange) opts.onChange(); });
    bar.appendChild(allBtn);
    container.appendChild(bar);
  }

  CLASS_GRADES.forEach(group => {
    const wrap = document.createElement('div');
    wrap.className = 'class-modal-group';
    const lbl = document.createElement('span');
    lbl.className = 'class-grade-label';
    lbl.textContent = group.label;
    wrap.appendChild(lbl);
    group.classes.forEach(cls => {
      const chip = document.createElement('div');
      chip.className = 'class-pick' + (has(cls) ? ' active' : '');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'class-pick-btn';
      btn.textContent = cls;
      chip.appendChild(btn);
      btn.addEventListener('click', () => { toggle(cls); chip.classList.toggle('active', has(cls)); if (opts.onChange) opts.onChange(); });
      wrap.appendChild(chip);
    });
    if (selectAll) {
      const groupOn = group.classes.every(has);
      const gBtn = document.createElement('button');
      gBtn.type = 'button'; gBtn.className = 'link-btn class-selectall-grade';
      gBtn.textContent = groupOn ? 'Fjern alle' : 'Velg alle';
      gBtn.addEventListener('click', () => { setAll(group.classes, !groupOn); buildClassPicker(container, opts); if (opts.onChange) opts.onChange(); });
      wrap.appendChild(gBtn);
    }
    container.appendChild(wrap);
  });
}
// Binding for a subject's row of the matrix (used by onboarding + profile).
function subjectClassBinding(subject) {
  return {
    has: cls => classesForSubject(subject).includes(cls),
    toggle: cls => toggleSubjectClass(subject, cls),
    setAll: (list, on) => setSubjectClasses(subject, list, on),
  };
}

// Compact year picker for an elective (a year-level unit): one toggle per grade,
// active when the whole grade is selected. Updates in place + fires onChange so
// the subject's lekse-day rows rebuild without collapsing the open <details>.
function buildYearPicker(container, subject, onChange) {
  container.innerHTML = '';
  container.classList.add('profile-year-picker');
  CLASS_GRADES.forEach(g => {
    const isOn = () => g.classes.every(c => classesForSubject(subject).includes(c));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'year-pick' + (isOn() ? ' active' : '');
    btn.textContent = g.label + ' trinn';
    btn.addEventListener('click', () => {
      setSubjectClasses(subject, g.classes, !isOn());
      btn.classList.toggle('active', isOn());
      if (onChange) onChange();
    });
    container.appendChild(btn);
  });
}

// Profile "Mine klasser": the Kontaktlærer picker on top, then a "Klasser per fag"
// collapsible with one collapsed <details> per Mine-fag subject holding its class
// picker (core) / year picker (elective) + that subject's standard lekse-days.
function buildProfileClasses() {
  const box = document.getElementById('profileClasses');
  if (!box) return;
  box.innerHTML = '';

  const kwrap = document.createElement('div');
  kwrap.className = 'profile-subj';
  const kh = document.createElement('div');
  kh.className = 'profile-subj-label';
  kh.textContent = 'Kontaktlærer for';
  kwrap.appendChild(kh);
  const kbox = document.createElement('div');
  kwrap.appendChild(kbox);
  buildKontaktStep(kbox);   // ★ chips over the taught union
  box.appendChild(kwrap);

  const subs = orderedSubjects(mySubjects());
  if (!subs.length) {
    const p = document.createElement('p');
    p.className = 'form-hint';
    p.textContent = 'Velg fagene dine over først, så kan du sette klasser per fag.';
    box.appendChild(p);
    return;
  }
  const outer = document.createElement('details');
  outer.className = 'profile-matrix';
  outer.open = true;
  const osum = document.createElement('summary');
  osum.textContent = 'Klasser per fag';
  outer.appendChild(osum);

  subs.forEach(s => {
    const det = document.createElement('details');
    det.className = 'profile-subj-details';   // starts collapsed
    const sum = document.createElement('summary');
    sum.className = 'profile-subj-summary';
    sum.textContent = s + (isElective(s) ? ' (valgfag)' : '');
    det.appendChild(sum);

    const picker = document.createElement('div');
    det.appendChild(picker);
    const lekseBox = document.createElement('div');
    lekseBox.className = 'profile-lekse';
    const refreshLekse = () => buildLekseDayRows(lekseBox, s);
    if (isElective(s)) buildYearPicker(picker, s, refreshLekse);
    else buildClassPicker(picker, Object.assign({ selectAll: true, onChange: refreshLekse }, subjectClassBinding(s)));
    det.appendChild(lekseBox);
    refreshLekse();
    outer.appendChild(det);
  });
  box.appendChild(outer);
}

// A flat chip row for a subject list – used by the onboarding subject steps
// (core on one step, electives on the next) so each step stays uncluttered.
function buildOnboardSubjectChips(container, subjectList) {
  container.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'vf-chip-row';
  subjectList.slice().sort((a, b) => a.localeCompare(b, 'no')).forEach(s => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vf-chip' + (mySubjects().includes(s) ? ' active' : '');
    btn.textContent = s;
    btn.addEventListener('click', async () => {
      const now = await toggleMySubject(s);
      btn.classList.toggle('active', !!now);
    });
    row.appendChild(btn);
  });
  container.appendChild(row);
}

// The onboarding Kontaktlærer step: the taught classes as ★ toggles.
function buildKontaktStep(container) {
  container.innerHTML = '';
  const taught = CLASSES.filter(c => classesTaught.includes(c));   // grade order
  if (!taught.length) {
    const p = document.createElement('p');
    p.className = 'onboard-empty';
    p.textContent = 'Du har ikke valgt noen klasser ennå. Gå tilbake for å velge klasser, eller hopp over – du kan sette dette senere.';
    container.appendChild(p);
    return;
  }
  const row = document.createElement('div');
  row.className = 'vf-chip-row';
  taught.forEach(cls => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vf-chip kontakt-chip' + (kontaktClasses.includes(cls) ? ' active' : '');
    btn.textContent = '★ ' + cls;
    btn.addEventListener('click', () => {
      toggleKontaktClass(cls);
      btn.classList.toggle('active', kontaktClasses.includes(cls));
    });
    row.appendChild(btn);
  });
  container.appendChild(row);
}

// ─── First-run onboarding (guided wizard) ────────────────────────────────────
// Show once for a genuinely-new account (never onboarded, no subjects, no
// classes); existing teachers are never surprised. Steps: 0 welcome · 1 vanlige
// fag · 2 valgfag · 3 klasser · 4 kontaktlærer · 5 done. Selections persist live
// via their toggles; onboardedAt is stamped only when the user leaves the wizard.
function needsOnboarding() {
  return !settings.onboardedAt && mySubjects().length === 0 && classesTaught.length === 0;
}
let onboardStep = 0;
let onboardSkipped = false;
let onboardDir = 'next';   // slide direction for the body enter animation
let subjClassIdx = 0;      // step 3 sub-index: which subject we're assigning classes for
// The subjects (ordered) whose classes we assign, one screen each, in step 3.
function onboardSubjSeq() { return orderedSubjects(mySubjects()); }

// Journey progress bar: 7 zig-zag nodes (Konto · Fag · Valgfag · Klasser ·
// Kontakt · Oppsummering · Mål) drawn with isometric depth (an offset darker
// underside + a highlight), and a map-pin marker that glides above the current
// node. Konto is pre-done and the pin starts parked at node 2, so the journey
// opens already underway. The last node is a larger flagged destination. Per
// step: [filledNodes, pointerNode] (1-based); the trail colours up to the pin.
const ONBOARD_NODES = [[18, 32], [65, 16], [112, 32], [159, 16], [206, 32], [253, 16], [298, 32]];
const ONBOARD_PROGRESS = { 0: [1, 2], 1: [1, 2], 2: [2, 3], 3: [3, 4], 4: [4, 5], 5: [5, 6], 6: [7, 7] };
function buildOnboardProgress() {
  const el = document.getElementById('onboardProgress');
  el.hidden = false;
  let segs = '', nodes = '';
  for (let j = 0; j < ONBOARD_NODES.length - 1; j++) {
    const [ax, ay] = ONBOARD_NODES[j], [bx, by] = ONBOARD_NODES[j + 1];
    segs += `<g class="oseg" data-j="${j}">`
      + `<line class="oseg-base" x1="${ax}" y1="${ay + 3}" x2="${bx}" y2="${by + 3}"/>`
      + `<line class="oseg-face" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/></g>`;
  }
  ONBOARD_NODES.forEach(([x, y], i) => {
    const goal = i === ONBOARD_NODES.length - 1;
    const rx = goal ? 8.5 : 6, ry = goal ? 7 : 5;
    let g = `<g class="onode${goal ? ' onode-goal' : ''}" data-i="${i}">`
      + `<ellipse class="onode-base" cx="${x}" cy="${y + 3}" rx="${rx}" ry="${ry}"/>`
      + `<ellipse class="onode-face" cx="${x}" cy="${y}" rx="${rx}" ry="${ry}"/>`;
    if (goal) {   // a little flag marks the destination
      g += `<line class="onode-flagpole" x1="${x}" y1="${y - 1}" x2="${x}" y2="${y - 13}"/>`
        + `<path class="onode-flag" d="M ${x} ${y - 13} l 7 2.3 l -7 2.3 z"/>`;
    } else {
      g += `<ellipse class="onode-hi" cx="${x - 1.7}" cy="${y - 1.6}" rx="1.9" ry="1.4"/>`;
    }
    nodes += g + '</g>';
  });
  // Map pin: teardrop head tapering to a point at (0,0), with a hole.
  const pin = '<g class="opointer"><g class="opointer-bob">'
    + '<path class="opointer-body" d="M0 0 C -3 -5 -6 -7.5 -6 -11 A 6 6 0 1 1 6 -11 C 6 -7.5 3 -5 0 0 Z"/>'
    + '<circle class="opointer-hole" cx="0" cy="-11" r="2.4"/></g></g>';
  el.innerHTML = `<svg class="onboard-journey" viewBox="0 -14 320 58" role="img" aria-label="Fremdrift i oppsett">${segs}${nodes}${pin}</svg>`;
}
function updateOnboardProgress(step) {
  const [filled, pointerNode] = ONBOARD_PROGRESS[step] || [1, 2];
  const el = document.getElementById('onboardProgress');
  el.querySelectorAll('.onode').forEach(c => {
    const n = +c.dataset.i + 1;
    c.classList.toggle('done', n <= filled);
    c.classList.toggle('current', n === pointerNode && n > filled);
  });
  // Colour a segment when both ends are done, or when it's the leg into the pin.
  el.querySelectorAll('.oseg').forEach(s => {
    const far = +s.dataset.j + 2;
    s.classList.toggle('done', far <= filled || far === pointerNode);
  });
  const p = el.querySelector('.opointer');
  const [px, py] = ONBOARD_NODES[pointerNode - 1];
  p.style.transform = `translate(${px}px, ${py - 10}px)`;
}
// A small victory hop for the pin when it reaches the destination (Fullfør).
function playPinVictory() {
  const bob = document.querySelector('#onboardProgress .opointer-bob');
  if (!bob) return;
  bob.classList.remove('opointer-victory');
  void bob.offsetWidth;
  bob.classList.add('opointer-victory');
  bob.addEventListener('animationend', () => bob.classList.remove('opointer-victory'), { once: true });
}
function playOnboardEnter() {
  const b = document.getElementById('onboardBody');
  b.style.setProperty('--enter-x', onboardDir === 'back' ? '-22px' : '22px');
  b.classList.remove('onboard-anim');
  void b.offsetWidth;             // reflow so the animation replays each step
  b.classList.add('onboard-anim');
}
function showOnboarding() {
  onboardStep = 0;
  onboardSkipped = false;
  onboardDir = 'next';
  subjClassIdx = 0;
  buildOnboardProgress();
  document.getElementById('onboardOverlay').classList.add('open');
  document.getElementById('onboardModal').classList.add('open');
  document.body.classList.add('scroll-locked');
  renderOnboardStep();
}
function onboardHint(text) {
  const p = document.createElement('p');
  p.className = 'form-hint onboard-hint';
  p.textContent = text;
  return p;
}
function renderOnboardStep() {
  const title = document.getElementById('onboardTitle');
  const body  = document.getElementById('onboardBody');
  const back  = document.getElementById('onboardBack');
  const skip  = document.getElementById('onboardSkip');
  const next  = document.getElementById('onboardNext');
  body.innerHTML = '';
  back.style.display = ''; skip.style.display = ''; next.style.display = '';
  skip.textContent = 'Fyll inn senere';
  updateOnboardProgress(onboardStep);
  const sub = () => { const d = document.createElement('div'); body.appendChild(d); return d; };

  if (onboardStep === 0) {                       // Welcome
    title.textContent = 'Velkommen til Ukeportalen!';
    const p = document.createElement('p');
    p.className = 'onboard-lead';
    p.textContent = 'Vi stiller deg noen raske spørsmål om fagene og klassene dine, '
      + 'slik at vi kan gjøre appen enklere for deg! '
      + 'Du kan endre alt senere i profilen din.';
    body.appendChild(p);
    back.style.display = 'none';
    next.textContent = 'Kom i gang';
  } else if (onboardStep === 1) {                // Regular subjects
    title.textContent = 'Hvilke fag underviser du i?';
    body.appendChild(onboardHint('Velg fagene du underviser i. Valgfag og tilvalgsfag kommer i neste steg.'));
    buildOnboardSubjectChips(sub(), CORE_SUBJECTS);
    next.textContent = 'Neste';
  } else if (onboardStep === 2) {                // Electives
    title.textContent = 'Valgfag og tilvalgsfag';
    body.appendChild(onboardHint('Har du noen av disse? Hopp videre hvis ikke.'));
    buildOnboardSubjectChips(sub(), ELECTIVE_SUBJECTS);
    next.textContent = 'Neste';
  } else if (onboardStep === 3) {                // Classes – one subject per screen
    const seq = onboardSubjSeq();
    if (!seq.length) { onboardStep = 4; renderOnboardStep(); return; }   // defensive
    subjClassIdx = Math.min(subjClassIdx, seq.length - 1);
    const subject = seq[subjClassIdx];
    title.textContent = 'Hvilke klasser har du ' + subject + ' i?';
    body.appendChild(onboardHint('Fag ' + (subjClassIdx + 1) + ' av ' + seq.length + '. Har du faget i alle klasser, bruk «Velg alle».'));
    buildClassPicker(sub(), Object.assign({ selectAll: true }, subjectClassBinding(subject)));
    next.textContent = subjClassIdx < seq.length - 1 ? 'Neste fag' : 'Neste';
  } else if (onboardStep === 4) {                // Kontaktlærer
    title.textContent = 'Er du kontaktlærer?';
    body.appendChild(onboardHint('Marker klassene du er kontaktlærer for. Ikke kontaktlærer? Bare gå videre.'));
    buildKontaktStep(sub());
    next.textContent = 'Neste';
  } else if (onboardStep === 5) {                // Summary
    title.textContent = 'Ser dette riktig ut?';
    body.appendChild(onboardHint('En rask oppsummering. Gå tilbake for å endre, ellers fullfører du.'));
    buildOnboardSummary(sub());
    next.textContent = 'Fullfør';
  } else {                                       // Done (celebratory or skipped)
    back.style.display = 'none';
    const p = document.createElement('p');
    p.className = 'onboard-lead onboard-celebrate';
    if (onboardSkipped) {
      title.textContent = 'Den er grei!';
      p.textContent = 'Du kan fylle inn dette senere i profilen din ved å trykke på navnet ditt øverst til høyre.';
      // Nudge back into setup: resume is the prominent primary, «open» is muted.
      skip.style.display = ''; skip.textContent = 'Åpne Ukeportalen';
      next.textContent = 'Vent, jeg vil gjøre det likevel';
    } else {
      skip.style.display = 'none';
      title.textContent = 'Flott!';
      p.textContent = '🎉 Profilen er fullført!';
      next.textContent = 'Åpne Ukeportalen';
      playPinVictory();                          // the pin plants a flag at the goal
    }
    body.appendChild(p);
  }
  playOnboardEnter();
}
// A read-only recap of what the teacher set, shown on the summary step.
function buildOnboardSummary(container) {
  container.innerHTML = '';
  const row = (label, values, empty) => {
    const d = document.createElement('div'); d.className = 'onboard-sum-row';
    const l = document.createElement('span'); l.className = 'onboard-sum-label'; l.textContent = label;
    const v = document.createElement('span'); v.className = 'onboard-sum-val';
    if (values.length) v.textContent = values.join(', ');
    else { v.textContent = empty; v.classList.add('onboard-sum-empty'); }
    d.appendChild(l); d.appendChild(v);
    return d;
  };
  const subs = orderedSubjects(mySubjects());
  if (!subs.length) {
    container.appendChild(row('Fag', [], 'Ingen valgt'));
  } else {
    subs.forEach(s => container.appendChild(row(s, classesForSubject(s), 'Ingen klasser')));
  }
  container.appendChild(row('Kontaktlærer', CLASSES.filter(c => kontaktClasses.includes(c)), 'Ingen'));
}
function onboardNextClick() {
  if (onboardStep >= 6) { onboardSkipped ? resumeOnboarding() : completeOnboarding(); return; }
  onboardDir = 'next';
  const seq = onboardSubjSeq();
  if (onboardStep === 2) {                          // entering the class phase
    if (seq.length) { onboardStep = 3; subjClassIdx = 0; } else { onboardStep = 4; }  // skip if no subjects
  } else if (onboardStep === 3 && subjClassIdx < seq.length - 1) {
    subjClassIdx += 1;                               // next subject, same phase
  } else {
    onboardStep += 1;                                // step 3(last)→4, or any other step
  }
  renderOnboardStep();
}
function onboardBackClick() {
  if (onboardStep === 0) return;
  onboardDir = 'back';
  const seq = onboardSubjSeq();
  if (onboardStep === 3 && subjClassIdx > 0) {
    subjClassIdx -= 1;                               // previous subject, same phase
  } else if (onboardStep === 4) {                    // back into the class phase (last subject) or skip it
    if (seq.length) { onboardStep = 3; subjClassIdx = Math.max(0, seq.length - 1); } else { onboardStep = 2; }
  } else {
    onboardStep -= 1;
  }
  renderOnboardStep();
}
function onboardSkipClick() {
  if (onboardStep >= 6) { completeOnboarding(); return; }   // «Åpne Ukeportalen» on the skipped-done step
  onboardDir = 'next';
  onboardSkipped = true;
  onboardStep = 6;
  renderOnboardStep();
}
// «Vent, jeg vil gjøre det likevel» – abandon the skip and resume the wizard.
function resumeOnboarding() {
  onboardSkipped = false;
  onboardDir = 'back';
  onboardStep = 1;
  renderOnboardStep();
}
// Leave the wizard for good: stamp onboardedAt and continue into the dashboard.
// Selections were already persisted live via their toggles.
function completeOnboarding() {
  settings.onboardedAt = new Date().toISOString();
  saveSettings();
  document.getElementById('onboardOverlay').classList.remove('open');
  document.getElementById('onboardModal').classList.remove('open');
  document.body.classList.remove('scroll-locked');
  if (!selectedClass && classesTaught.length) {          // smart default class
    selectedClass = classesTaught[0];
    localStorage.setItem(CLASS_KEY, selectedClass);
  }
  updateClassLabel();
  setTeacherTab('hjem');   // finish onto the dashboard
}

// «Velg fag» modal for the board's «Valgte fag» visibility mode.
function openViewSubjectsModal() {
  buildSubjectChipPicker(document.getElementById('viewSubjectsList'), viewSubjects, toggleViewSubject, {
    summaryLabel: 'Valgt', emptyLabel: 'Ingen valgt – bare fag med innhold vises.',
  });
  document.getElementById('viewSubjectsOverlay').classList.add('open');
  document.getElementById('viewSubjectsModal').classList.add('open');
  document.body.classList.add('scroll-locked');
}
function closeViewSubjectsModal() {
  document.getElementById('viewSubjectsOverlay').classList.remove('open');
  document.getElementById('viewSubjectsModal').classList.remove('open');
  document.body.classList.remove('scroll-locked');
  render();   // reflect the new subset on the board
}

// Fill a <select> with subjects grouped «Mine fag» (ordered) then «Andre fag».
function fillSubjectSelect(sel, noneLabel) {
  const val = sel.value;
  sel.innerHTML = '';
  if (noneLabel !== null) {
    const none = document.createElement('option'); none.value = ''; none.textContent = noneLabel; sel.appendChild(none);
  }
  const mine = orderedSubjects(mySubjects());
  const others = SUBJECTS.filter(s => !mine.includes(s)).sort((a, b) => a.localeCompare(b, 'no'));
  const addGroup = (label, list) => {
    if (!list.length) return;
    const g = document.createElement('optgroup'); g.label = label;
    list.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; g.appendChild(o); });
    sel.appendChild(g);
  };
  if (mine.length) { addGroup('Mine fag', mine); addGroup('Andre fag', others); }
  else { others.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); }); }
  sel.value = val;   // preserve the current selection if still present
}

// ─── Vurdering date rules (B2) ────────────────────────────────
// Assessments may be placed on any school day, but NOT on weekends or on
// school-free / planning days from the school calendar.
function getSchoolYearBounds(today) {
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
  const pastJun21 = m > 5 || (m === 5 && d > 21);
  if (pastJun21) return { start: `${y}-08-15`, end: `${y + 1}-06-21` };
  return { start: `${y - 1}-08-15`, end: `${y}-06-21` };
}
function vurdDateProblem(iso) {
  if (!iso) return null;
  const d = isoToDate(iso);
  const dow = d.getDay();                 // 0 = Sun, 6 = Sat
  if (dow === 0 || dow === 6) return 'Datoen er i helgen';
  const sch = schoolDays[iso];
  if (sch && (sch.type === 'off' || sch.type === 'planning')) {
    return 'Skoleruta: ' + (sch.summaries && sch.summaries.length ? sch.summaries.join(', ') : 'fri/planleggingsdag');
  }
  return null;
}
// The contextual default date for a NEW vurdering: today only when it actually
// falls inside the week the modal was opened for (modalWeekFrom) – otherwise the
// Monday of that week, so adding from a board you're viewing never silently
// lands on today in a different week.
function contextualVurdDate() {
  const monday   = modalWeekFrom || weekMonday;
  const startISO = toISODate(monday);
  const endISO   = toISODate(addDays(monday, 6));
  const todayISO = toISODate(new Date());
  return (todayISO >= startISO && todayISO <= endISO) ? todayISO : startISO;
}

// Echo the chosen date in plain language + warn on weekend / school-free days
// and when the date lands in a different week than the one being viewed.
function updateDateInfo() {
  const echo = document.getElementById('dateEcho');
  const warn = document.getElementById('dateWarn');
  if (modalType !== 'vurdering') {
    if (echo) echo.hidden = true;
    if (warn) warn.hidden = true;
    return;
  }
  const iso = document.getElementById('dateInput').value;

  if (echo) {
    if (iso) {
      const d = isoToDate(iso);
      echo.textContent = 'Vurdering legges på: ' +
        capitalizeFirst(d.toLocaleDateString('no', { weekday: 'long', day: 'numeric', month: 'long' })) +
        ' (uke ' + getWeekNumber(d) + ')';
      echo.hidden = false;
    } else echo.hidden = true;
  }

  if (warn) {
    const problem = vurdDateProblem(iso);
    if (problem) {
      warn.textContent = '⚠ ' + problem + '. Velg en vanlig skoledag.';
      warn.hidden = false;
    } else if (iso && modalWeekFrom && dateToWeek(isoToDate(iso)) !== dateToWeek(modalWeekFrom)) {
      warn.textContent = '⚠ Denne havner i uke ' + getWeekNumber(isoToDate(iso)) +
        ' – du ser på uke ' + getWeekNumber(modalWeekFrom) + '.';
      warn.hidden = false;
    } else warn.hidden = true;
  }
}

// ─── Data loading ─────────────────────────────────────────────

// Per-session week cache: planKey|week → data. Weeks already visited render
// instantly from the cache and are silently revalidated in the background, so
// jumping back and forth between weeks never shows the blocking overlay.
// In-memory only – every new session (tab) starts fresh.
const weekCache   = new Map();
const prefetching = new Set();
function weekCacheKey(week) { return planKey() + '|' + week; }
// Re-point the cache at the current planData after a reassignment (deletes
// create a new array; pushes mutate the cached one in place).
function cacheCurrentWeek() { weekCache.set(weekCacheKey(dateToWeek(weekMonday)), planData); }

async function loadData(opts = {}) {
  const { background = false, force = false, skipCache = false } = opts;
  loadAssessments({ force });

  const week = dateToWeek(weekMonday);
  const key  = weekCacheKey(week);
  const cached = (!skipCache && !force) ? weekCache.get(key) : null;
  if (cached) {
    planData = cached;
    render();
    updateStatus();
    hideOverlay();
    fetchWeekData(key, week, { background: true });   // silent revalidation
    return;
  }
  if (background) showBgLoading(); else showOverlay();
  await fetchWeekData(key, week, { background });
}

async function fetchWeekData(key, week, opts = {}) {
  const { background = false } = opts;
  try {
    const url = `${SCRIPT_URL}?action=week&classes=${encodeURIComponent(planKey())}&week=${encodeURIComponent(week)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(data.error || 'Ugyldig svar');
    weekCache.set(key, data);
    // Only adopt if the teacher is still on the same class/variant + week.
    if (selectedClass && key === weekCacheKey(dateToWeek(weekMonday))) {
      planData = data;
      render();
    }
    updateStatus();
    if (background) hideBgLoading(); else hideOverlay();
    prefetchAdjacentWeeks();
  } catch (err) {
    if (background) hideBgLoading();
    else showOverlayError('Kunne ikke laste data. Sjekk tilkoblingen og prøv igjen.');
  }
}

// Warm the cache for the previous/next week so ◀ ▶ navigation is instant on
// the first click too. Cheap: two small week payloads, session-deduplicated.
function prefetchAdjacentWeeks() {
  if (!selectedClass) return;
  [-7, 7].forEach(off => {
    const w   = dateToWeek(addDays(weekMonday, off));
    const key = weekCacheKey(w);
    if (weekCache.has(key) || prefetching.has(key)) return;
    prefetching.add(key);
    fetch(`${SCRIPT_URL}?action=week&classes=${encodeURIComponent(planKey())}&week=${encodeURIComponent(w)}`)
      .then(res => (res.ok ? res.json() : null))
      .then(data => { if (Array.isArray(data)) weekCache.set(key, data); })
      .catch(() => { /* prefetch is best-effort */ })
      .finally(() => prefetching.delete(key));
  });
}

async function loadAssessments(opts = {}) {
  const { force = false } = opts;
  if (!force) {
    const ts = Number(localStorage.getItem(VURD_TS_KEY)) || 0;
    if (Date.now() - ts < VURD_CACHE_TTL) {
      if (!vurdData.length) {
        try { vurdData = JSON.parse(localStorage.getItem(VURD_CACHE_KEY)) || []; } catch { vurdData = []; }
        if (vurdData.length) render();
      }
      return;
    }
  }
  try {
    const res = await fetch(`${SCRIPT_URL}?action=vurderinger`);
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data)) return;
    const changed = JSON.stringify(data) !== JSON.stringify(vurdData);
    vurdData = data;
    try {
      localStorage.setItem(VURD_CACHE_KEY, JSON.stringify(data));
      localStorage.setItem(VURD_TS_KEY, String(Date.now()));
    } catch { /* storage full – the cache is best-effort */ }
    if (changed) render();   // skip the pointless board rebuild when unchanged
  } catch { /* silent */ }
}

// ─── Week navigation ──────────────────────────────────────────

function changeWeek(delta) {
  weekMonday = addDays(weekMonday, delta * 7);
  updateWeekLabel();
  if (teacherTab === 'hjem') { loadHjem(); return; }
  if (teacherTab === 'kontakt') { loadKontakt(); return; }
  if (!selectedClass) return;
  if (teacherTab === 'oversikt') refreshOversikt(); else loadData();
}
function jumpToThisWeek() {
  weekMonday = mondayOf(new Date());
  updateWeekLabel();
  if (teacherTab === 'hjem') { loadHjem(); return; }
  if (teacherTab === 'kontakt') { loadKontakt(); return; }
  if (!selectedClass) return;
  if (teacherTab === 'oversikt') refreshOversikt(); else loadData();
}

// All weeks of the school year containing the viewed week (for the week picker).
function schoolYearWeeks() {
  const b = getSchoolYearBounds(weekMonday);
  const out = [];
  let m = mondayOf(isoToDate(b.start));
  const end = mondayOf(isoToDate(b.end));
  let guard = 0;
  while (m <= end && guard++ < 60) {
    out.push({ value: toISODate(m), weekNo: getWeekNumber(m), label: 'Uke ' + getWeekNumber(m) + ' · ' + formatWeekRange(m, addDays(m, 4)) });
    m = addDays(m, 7);
  }
  return out;
}
async function openWeekPicker() {
  const chosen = await uiWeekPicker({ weeks: schoolYearWeeks(), current: toISODate(weekMonday) });
  if (!chosen) return;
  weekMonday = mondayOf(isoToDate(chosen));
  updateWeekLabel();
  if (teacherTab === 'hjem') { loadHjem(); return; }
  if (teacherTab === 'kontakt') { loadKontakt(); return; }
  if (!selectedClass) return;
  if (teacherTab === 'oversikt') refreshOversikt(); else loadData();
}
function updateWeekLabel() {
  const friday = addDays(weekMonday, 4);
  document.getElementById('weekLabel').textContent = 'Uke ' + getWeekNumber(weekMonday);
  document.getElementById('weekRange').textContent = formatWeekRange(weekMonday, friday);
}

// ─── Dashboard listeners ──────────────────────────────────────

function setupDashboardListeners() {
  // Pause the dashboard poll when the tab is hidden; refresh at once on return.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopHjemPoll(); return; }
    if (loggedIn && teacherTab === 'hjem') { loadHjem({ force: true }); startHjemPoll(); }
  });
  document.getElementById('prevWeekBtn').addEventListener('click', () => changeWeek(-1));
  document.getElementById('nextWeekBtn').addEventListener('click', () => changeWeek(1));
  document.getElementById('jumpTodayBtn').addEventListener('click', jumpToThisWeek);
  document.getElementById('weekJumpBtn').addEventListener('click', openWeekPicker);
  document.getElementById('refreshBtn').addEventListener('click', () => loadData({ background: true, force: true }));
  document.getElementById('classBtn').addEventListener('click', showClassModal);
  document.getElementById('classModalClose').addEventListener('click', closeClassModal);
  document.getElementById('classModalOverlay').addEventListener('click', closeClassModal);
  document.getElementById('addBtn').addEventListener('click', () => openAddModal());
  document.getElementById('cloneBtn').addEventListener('click', cloneFromPreviousWeek);
  document.getElementById('cloneFromClassBtn').addEventListener('click', cloneFromBaseClass);
  document.getElementById('variantNewBtn').addEventListener('click', startNewVariant);
  document.getElementById('variantOpenBtn').addEventListener('click', openVariantFromInput);
  document.getElementById('printBtn').addEventListener('click', () => window.print());

  document.getElementById('tTabHjem').addEventListener('click', () => setTeacherTab('hjem'));
  document.getElementById('tTabUkeplan').addEventListener('click', () => setTeacherTab('ukeplan'));
  document.getElementById('tTabVurd').addEventListener('click', () => setTeacherTab('vurd'));
  document.getElementById('tTabOversikt').addEventListener('click', () => setTeacherTab('oversikt'));
  document.getElementById('tTabKontakt').addEventListener('click', () => setTeacherTab('kontakt'));
  document.getElementById('addVurdBtn').addEventListener('click', () => openAddModal({ type: 'vurdering' }));

  // Vurderinger tab: view toggle + column-header filter modal
  document.getElementById('vurdViewTable').addEventListener('click', () => setVurdView('table'));
  document.getElementById('vurdViewCal').addEventListener('click', () => setVurdView('cal'));
  document.getElementById('vurdFilterBtn').addEventListener('click', () => openVurdFilterModal());
  document.getElementById('vurdFilterClose').addEventListener('click', closeVurdFilterModal);
  document.getElementById('vurdFilterOverlay').addEventListener('click', closeVurdFilterModal);
  document.getElementById('vurdFilterDone').addEventListener('click', closeVurdFilterModal);
  document.getElementById('vurdFilterClear').addEventListener('click', clearVurdFilters);
  document.getElementById('vfStart').addEventListener('change', onVurdDateChange);
  document.getElementById('vfEnd').addEventListener('change', onVurdDateChange);
  document.getElementById('vfDesc').addEventListener('input', e => { vfDesc = e.target.value; renderVurd(); });
  buildVurdClassBtns();

  const subjSel = document.getElementById('oversiktSubject');
  fillSubjectSelect(subjSel, null);   // «Mine fag» grouped first, no «none» option
  subjSel.addEventListener('change', () => { ovFrom = null; ovTo = null; renderOversiktActive(); });
  document.getElementById('oversiktGrade').addEventListener('change', renderOversikt);

  const ovClassSel = document.getElementById('oversiktClass');
  CLASSES.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; ovClassSel.appendChild(o); });
  ovClassSel.addEventListener('change', () => { ovFrom = null; ovTo = null; renderOversiktProg(); });
  document.getElementById('ovFrom').addEventListener('change', e => { ovFrom = e.target.value; renderOversiktProg(); });
  document.getElementById('ovTo').addEventListener('change', e => { ovTo = e.target.value; renderOversiktProg(); });
  document.getElementById('ovTemaBtn').addEventListener('click', addTemaForPeriode);
  document.getElementById('ovModeCompare').addEventListener('click', () => setOversiktMode('compare'));
  document.getElementById('ovModeProg').addEventListener('click', () => setOversiktMode('prog'));
  document.getElementById('ovExportBtn').addEventListener('click', exportFagrapport);

  const nameInput = document.getElementById('teacherName');
  nameInput.addEventListener('input', () => {
    const v = nameInput.value.trim();
    if (v) {
      teacherName = v;
      if (!profileOpen) localStorage.setItem(TNAME_KEY, v);   // transactional: commit on Lagre
      saveProfileToServer();   // defers + marks dirty while the modal is open
    }
    updateProfileButton();
  });

  // Profile / settings modal
  document.getElementById('profileBtn').addEventListener('click', openProfileModal);
  document.getElementById('ptabFag').addEventListener('click', () => setProfileTab('fag'));
  document.getElementById('ptabInnst').addEventListener('click', () => setProfileTab('innst'));
  document.getElementById('ptabKonto').addEventListener('click', () => setProfileTab('konto'));
  document.getElementById('profileClose').addEventListener('click', () => closeProfileModal());
  document.getElementById('profileOverlay').addEventListener('click', () => closeProfileModal());
  document.getElementById('profileDone').addEventListener('click', () => closeProfileModal());
  document.getElementById('profileSaveBtn').addEventListener('click', saveProfileNow);
  document.getElementById('logoutBtn2').addEventListener('click', async () => { if (await closeProfileModal()) handleLogout(); });
  document.getElementById('adminPanelBtn').addEventListener('click', openAdminModal);
  document.getElementById('adminClose').addEventListener('click', closeAdminModal);
  document.getElementById('adminOverlay').addEventListener('click', closeAdminModal);
  document.getElementById('adminSearch').addEventListener('input', renderAdminTeachers);
  document.getElementById('viewSubjectsClose').addEventListener('click', closeViewSubjectsModal);
  document.getElementById('viewSubjectsOverlay').addEventListener('click', closeViewSubjectsModal);
  document.getElementById('viewSubjectsDone').addEventListener('click', closeViewSubjectsModal);
  document.getElementById('onboardNext').addEventListener('click', onboardNextClick);
  document.getElementById('onboardBack').addEventListener('click', onboardBackClick);
  document.getElementById('onboardSkip').addEventListener('click', onboardSkipClick);
  document.getElementById('rerunOnboard').addEventListener('click', async () => { if (await closeProfileModal()) showOnboarding(); });
  document.getElementById('pwChangeBtn').addEventListener('click', changeOwnPassword);
  document.getElementById('setConfirmDelete').addEventListener('change', e => {
    settings.confirmDelete = e.target.checked;
    saveSettings();
  });
  document.getElementById('themeSeg').addEventListener('click', e => {
    const btn = e.target.closest('.theme-seg-btn');
    if (!btn || !window.UPTheme) return;
    UPTheme.set(btn.dataset.themePref);
    syncThemeSeg();
    saveProfileToServer();
  });

  // Undo / redo (buttons + keyboard). Native Ctrl+Z is left to text fields.
  document.getElementById('undoBtn').addEventListener('click', doUndo);
  document.getElementById('redoBtn').addEventListener('click', doRedo);
  document.addEventListener('keydown', e => {
    if (!loggedIn) return;
    const t = e.target;
    if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey)      { e.preventDefault(); doUndo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); }
  });
  updateUndoUI();
}

// ─── Class selection ──────────────────────────────────────────

function updateClassLabel() {
  document.getElementById('classBtnLabel').textContent = variantCode || selectedClass || 'Velg klasse';
  const b = document.getElementById('cloneFromClassBtn');
  if (b) b.hidden = !variantCode;
  // Persistent banner while a variant is active – the pill text alone is easy
  // to miss, and the variant survives browser restarts via localStorage.
  const banner = document.getElementById('variantBanner');
  if (banner) {
    banner.hidden = !variantCode;
    if (variantCode) {
      banner.textContent = '✎ Du redigerer en tilpasset plan (kode ' + variantSuffix(variantCode) +
        ', basert på ' + (parseVariantClass(variantCode) || selectedClass) +
        '). Planinnhold her vises bare for eleven med koden.';
    }
  }
}

// Activate an adapted-plan code for editing (base class derived from the code).
function applyVariant(code, base) {
  variantCode   = code;
  selectedClass = base;
  localStorage.setItem(VARIANT_KEY, code);
  localStorage.setItem(CLASS_KEY, base);
  planData = [];
  updateClassLabel();
  closeClassModal();
  loadData();
}

async function startNewVariant() {
  const base = variantCode ? parseVariantClass(variantCode) : selectedClass;
  if (!base || !CLASSES.includes(base)) { await uiAlert('Velg først en vanlig klasse å lage en tilpasset plan for.'); return; }
  const suffix = genSuffix();
  applyVariant(base + '-' + suffix, base);
  await uiAlert(
    'Tilpasset plan opprettet for ' + base + '.\n\n' +
    'Kode til eleven: ' + suffix + '\n\n' +
    'Eleven velger klasse ' + base + ' og skriver inn denne koden – koden virker bare med riktig klasse. ' +
    'Appen lagrer ikke hvem koden tilhører; noter koblingen trygt utenfor appen, og skriv aldri elevnavn i appen. ' +
    'Bruk «Hent fra klassen» hvis du vil starte fra klassens plan.',
    { title: 'Ny tilpasset plan' }
  );
}

function openVariantFromInput() {
  const base = variantCode ? parseVariantClass(variantCode) : selectedClass;
  const err  = document.getElementById('variantTError');
  if (!base || !CLASSES.includes(base)) { err.textContent = 'Velg først en vanlig klasse.'; err.hidden = false; return; }
  const suffix = document.getElementById('variantCodeInput').value.trim();
  if (!/^[A-Za-z0-9]{3,}$/.test(suffix)) { err.textContent = 'Ugyldig kode (f.eks. K7X9M).'; err.hidden = false; return; }
  const code = (base + '-' + suffix).toUpperCase();
  applyVariant(code, base);
  warnIfVariantEmpty(code);
}

// A mistyped code "works" but opens an EMPTY plan – content written there is
// a silent fork the pupil never sees. So when an existing code is opened by
// hand, check whether it has any content at all and warn loudly if not.
async function warnIfVariantEmpty(code) {
  try {
    const res = await fetch(`${SCRIPT_URL}?action=all`, { credentials: 'include' });
    const data = await res.json();
    if (!Array.isArray(data)) return;
    if (variantCode !== code) return;              // switched away meanwhile
    if (data.some(p => classMatches(p.classes, code))) return;
    uiAlert(
      'Koden ' + variantSuffix(code) + ' har ikke noe innhold fra før (ingen uker).\n\n' +
      'Sjekk at koden er skrevet riktig før du legger inn noe – en feilskrevet kode lager en ny, tom plan som eleven ikke ser. ' +
      'Skal du lage en helt ny plan, bruk «Lag ny tilpasset plan».',
      { title: 'Tom tilpasset plan' }
    );
  } catch { /* offline etc. – the empty board itself is the fallback hint */ }
}

function showClassModal() {
  const grid = document.getElementById('classModalGrid');
  grid.innerHTML = '';
  // A "Dine klasser" shortcut row on top for one-tap switching to a taught class.
  const mine = classesTaught.filter(c => CLASSES.includes(c));
  if (mine.length) {
    const wrap = document.createElement('div');
    wrap.className = 'class-modal-group class-modal-mine';
    const lbl = document.createElement('span');
    lbl.className = 'class-grade-label';
    lbl.textContent = 'Dine klasser';
    wrap.appendChild(lbl);
    mine.forEach(cls => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'class-modal-btn';
      btn.textContent = cls;
      if (cls === selectedClass) btn.classList.add('active');
      btn.addEventListener('click', () => pickClass(cls));
      wrap.appendChild(btn);
    });
    grid.appendChild(wrap);
  }
  CLASS_GRADES.forEach(group => {
    const wrap = document.createElement('div');
    wrap.className = 'class-modal-group';
    const lbl = document.createElement('span');
    lbl.className = 'class-grade-label';
    lbl.textContent = group.label;
    wrap.appendChild(lbl);
    group.classes.forEach(cls => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'class-modal-btn';
      btn.textContent = cls;
      if (cls === selectedClass) btn.classList.add('active');
      btn.addEventListener('click', () => pickClass(cls));
      wrap.appendChild(btn);
    });
    grid.appendChild(wrap);
  });
  const vIn = document.getElementById('variantCodeInput');
  if (vIn) vIn.value = '';
  const vErr = document.getElementById('variantTError');
  if (vErr) vErr.hidden = true;
  const vBox = document.getElementById('teacherVariantBox');
  if (vBox) vBox.open = !!variantCode;
  document.getElementById('classModalOverlay').classList.add('open');
  document.getElementById('classModal').classList.add('open');
  document.body.classList.add('scroll-locked');
}

function pickClass(cls) {
  selectedClass = cls;
  variantCode = null;                 // a normal class exits any adapted-plan editing
  localStorage.setItem(CLASS_KEY, cls);
  localStorage.removeItem(VARIANT_KEY);
  saveProfileToServer();              // remember the class across devices (preferences.lastClass)
  planData = [];
  updateClassLabel();
  closeClassModal();
  loadData();
}

function closeClassModal() {
  document.getElementById('classModalOverlay').classList.remove('open');
  document.getElementById('classModal').classList.remove('open');
  document.body.classList.remove('scroll-locked');
}

// ─── Rendering ────────────────────────────────────────────────

// Background data can arrive while the teacher is typing in a cell; rebuilding
// the board then would destroy the focused field and silently lose the text.
// deferIfEditing() postpones such renders until the edit – and its in-flight
// save – is done, then renders the fresh data.
function editingInProgress() {
  const a = document.activeElement;
  if (a && (a.isContentEditable || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') &&
      a.closest('#board, #generalSection, #oversiktBoard')) return true;
  return [...document.querySelectorAll('#board .rich-field, #oversiktBoard .rich-field')].some(f => f._busy);
}
function deferIfEditing() {
  if (!editingInProgress()) return false;
  renderDeferred = true;
  if (!renderDeferTimer) {
    renderDeferTimer = setTimeout(() => {
      renderDeferTimer = null;
      if (!renderDeferred) return;
      if (editingInProgress()) { deferIfEditing(); return; }   // still busy – keep waiting
      renderDeferred = false;
      render();
    }, 500);
  }
  return true;
}

function render() {
  if (teacherTab === 'hjem') { renderHjem(); return; }   // keys off classesTaught, not selectedClass
  if (teacherTab === 'kontakt') { renderKontakt(); return; }   // keys off kontaktClasses
  if (!selectedClass) return;
  if (deferIfEditing()) return;
  renderDeferred = false;
  if (teacherTab === 'ukeplan') { renderGeneral(); renderBoard(); }
  else if (teacherTab === 'vurd') renderVurd();
  else if (teacherTab === 'oversikt') renderOversiktActive();
}

function renderOversiktActive() {
  if (oversiktMode === 'prog') renderOversiktProg();
  else renderOversikt();
}

// Class-wide elements (beskjeder etc.) as editable cards.
function renderGeneral() {
  const section = document.getElementById('generalSection');
  section.innerHTML = '';

  const general = planData.filter(p => GENERAL_TYPES.includes(p.type) && p.description);

  const head = document.createElement('div');
  head.className = 'general-head';
  head.textContent = 'Beskjeder og praktisk info';
  section.appendChild(head);

  if (general.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'general-empty';
    empty.textContent = 'Ingen beskjeder denne uka. Bruk «+ Legg til».';
    section.appendChild(empty);
    return;
  }

  // One box per type; each item a clickable line (edit via modal).
  GENERAL_TYPES.forEach(type => {
    const items = general.filter(p => p.type === type);
    if (!items.length) return;
    const box = document.createElement('div');
    box.className = 'general-card banner-' + type;
    const meta = document.createElement('div');
    meta.className = 'general-meta';
    const icon = document.createElement('span'); icon.textContent = GENERAL_ICON[type] || '📌'; meta.appendChild(icon);
    const badge = document.createElement('span'); badge.className = 'general-badge'; badge.textContent = TYPE_LABEL[type]; meta.appendChild(badge);
    box.appendChild(meta);
    const list = document.createElement('div'); list.className = 'general-list';
    items.forEach(el => list.appendChild(buildGeneralLine(el)));
    box.appendChild(list);
    section.appendChild(box);
  });
}

function buildGeneralLine(el, opts = {}) {
  const line = document.createElement('div');
  line.className = 'general-line';
  // Day is bold; day + fag combine into one label when both are set.
  const dl = daysLabel(el.day);
  let prefix = '';
  if (dl && el.subject) prefix += '<strong>' + escapeHtml(dl) + ' · ' + escapeHtml(el.subject) + ':</strong> ';
  else if (el.subject)  prefix += '<strong>' + escapeHtml(el.subject) + ':</strong> ';
  else if (dl)          prefix += '<strong>' + escapeHtml(dl) + ':</strong> ';
  if (isMultiWeek(el)) prefix += '<span class="el-chip-tag">' + weekRangeShort(el) + '</span> ';
  const txt = document.createElement('span');
  txt.className = 'rich-content';
  txt.innerHTML = prefix + sanitizeHtml(el.description);
  line.appendChild(txt);
  if (opts.teacher && el.teacher) {
    const who = document.createElement('span');
    who.className = 'general-line-teacher';
    who.textContent = ' – ' + el.teacher;
    line.appendChild(who);
  }
  if (!opts.readonly) {
    line.title = 'Klikk for å redigere';
    line.addEventListener('click', () => openElementEdit(el));
  }
  return line;
}

// Subject board: all subjects as rows; Læringsmål + Lekser editable.
// ─── Board: drag-to-reorder subject rows ──────────────────────
let dragSubject = null;
let boardVisibleRows = [];
function attachRowDrag(handle, subject) {
  handle.addEventListener('dragstart', e => {
    dragSubject = subject;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', subject); } catch { /* some browsers require a payload */ }
    const tr = handle.closest('tr'); if (tr) tr.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => {
    dragSubject = null;
    document.querySelectorAll('#board tr.dragging, #board tr.drop-target').forEach(r => r.classList.remove('dragging', 'drop-target'));
  });
  handle.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp')        { e.preventDefault(); moveSubject(subject, -1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSubject(subject, +1); }
  });
}
function persistSubjectOrder(order) { settings.subjectOrder = order; saveSettings(); renderBoard(); }
function reorderSubject(moved, target) {
  const order = orderedSubjects(SUBJECTS.slice());     // full canonical order of all subjects
  order.splice(order.indexOf(moved), 1);
  order.splice(order.indexOf(target), 0, moved);       // drop just before the target row
  persistSubjectOrder(order);
}
function moveSubject(subject, delta) {                 // keyboard reorder within visible rows
  const vi = boardVisibleRows.indexOf(subject);
  const ni = vi + delta;
  if (vi < 0 || ni < 0 || ni >= boardVisibleRows.length) return;
  const target = boardVisibleRows[ni];
  const order = orderedSubjects(SUBJECTS.slice());
  order.splice(order.indexOf(subject), 1);
  let ti = order.indexOf(target);
  if (delta > 0) ti += 1;                              // moving down: land after the target
  order.splice(ti, 0, subject);
  persistSubjectOrder(order);
  setTimeout(() => {
    document.querySelectorAll('#board tbody tr').forEach(r => {
      if (r.dataset.subject === subject) { const h = r.querySelector('.drag-handle'); if (h) h.focus(); }
    });
  }, 0);
}

function renderBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';

  const week = dateToWeek(weekMonday);
  const weekVurd = vurdData
    .filter(v => v.date && dateToWeek(new Date(v.date)) === week && classMatches(v.classes, selectedClass))
    .map(v => ({ ...v, day: dayOf(new Date(v.date)) }));

  // Map (subject||type) → elements
  const map = {};
  planData.forEach(p => {
    if (SUBJECT_TYPES.includes(p.type) && p.subject) {
      const k = p.subject + '||' + p.type;
      (map[k] = map[k] || []).push(p);
    }
  });
  const vurdBySubject = {};
  weekVurd.forEach(v => { (vurdBySubject[v.subject || 'Annet'] = vurdBySubject[v.subject || 'Annet'] || []).push(v); });

  // Board visibility – three modes. «Mine fag» / «Valgte fag» show exactly the
  // curated set (a subject you didn't select – even one a colleague has filled
  // for this class – only appears under «Alle fag»). Empty Mine fag → show all.
  const my = mySubjects();
  const chosen = viewSubjects();
  const mode = settings.viewMode || 'mine';
  let base;
  if (mode === 'alle')         base = SUBJECTS.slice();
  else if (mode === 'valgte')  base = SUBJECTS.filter(s => chosen.includes(s));
  else                         base = my.length ? SUBJECTS.filter(s => my.includes(s)) : SUBJECTS.slice();
  const rows = orderedSubjects(base);
  boardVisibleRows = rows;

  if (my.length || chosen.length || mode !== 'mine') {
    const note = document.createElement('div');
    note.className = 'board-filter-note';
    const seg = document.createElement('div');
    seg.className = 'view-seg';
    [['mine', 'Mine fag'], ['valgte', 'Valgte fag'], ['alle', 'Alle fag']].forEach(([m, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'view-seg-btn' + (mode === m ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => { settings.viewMode = m; saveSettings(); renderBoard(); });
      seg.appendChild(b);
    });
    note.appendChild(seg);
    if (mode === 'valgte') {
      const pick = document.createElement('button');
      pick.type = 'button'; pick.className = 'link-btn';
      pick.textContent = chosen.length ? 'Velg fag (' + chosen.length + ')' : 'Velg fag';
      pick.addEventListener('click', openViewSubjectsModal);
      note.appendChild(pick);
    } else {
      const count = document.createElement('span');
      count.className = 'board-filter-count';
      count.textContent = 'Viser ' + rows.length + ' av ' + SUBJECTS.length + ' fag';
      note.appendChild(count);
    }
    board.appendChild(note);
  }

  const wrap = document.createElement('div');
  wrap.className = 'board-wrap';
  const table = document.createElement('table');
  table.className = 'plan-table editable';
  const thead = table.createTHead();
  const hr = thead.insertRow();
  ['Fag', 'Tema og læringsmål', 'Ressurser', 'Lekser', 'Vurdering'].forEach(h => {
    const th = document.createElement('th'); th.textContent = h; hr.appendChild(th);
  });

  const tbody = table.createTBody();
  // Drag-to-reorder: delegate dragover/drop to the body (rows carry data-subject).
  const reorderable = !variantCode;
  if (reorderable) {
    tbody.addEventListener('dragover', e => {
      if (!dragSubject) return;
      e.preventDefault();
      const tr = e.target.closest('tr');
      tbody.querySelectorAll('tr.drop-target').forEach(r => r.classList.remove('drop-target'));
      if (tr && tr.dataset.subject && tr.dataset.subject !== dragSubject) tr.classList.add('drop-target');
    });
    tbody.addEventListener('drop', e => {
      if (!dragSubject) return;
      e.preventDefault();
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.subject && tr.dataset.subject !== dragSubject) reorderSubject(dragSubject, tr.dataset.subject);
    });
  }
  rows.forEach(subject => {
    const tr = tbody.insertRow();
    tr.dataset.subject = subject;
    const tdSubject = tr.insertCell();
    tdSubject.className = 'cell-subject';
    if (reorderable) {
      const grip = document.createElement('span');
      grip.className = 'drag-handle';
      grip.textContent = '⠿';
      grip.setAttribute('draggable', 'true');
      grip.setAttribute('role', 'button');
      grip.setAttribute('tabindex', '0');
      grip.setAttribute('aria-label', 'Endre rekkefølge på ' + subject);
      grip.title = 'Dra for å endre rekkefølge (eller bruk piltastene)';
      attachRowDrag(grip, subject);
      tdSubject.appendChild(grip);
    }
    const nameSpan = document.createElement('span');
    nameSpan.className = 'cell-subject-name';
    nameSpan.textContent = subject;
    tdSubject.appendChild(nameSpan);
    // Copy the row to parallel classes (not in adapted plans – codes are personal).
    if (!variantCode && SUBJECT_TYPES.some(t => (map[subject + '||' + t] || []).length)) {
      const cp = document.createElement('button');
      cp.type = 'button';
      cp.className = 'row-copy-btn';
      cp.title = 'Kopier radens innhold til andre klasser';
      cp.textContent = '⧉';
      cp.addEventListener('click', () => copyRowToClasses(subject));
      tdSubject.appendChild(cp);
    }

    tr.appendChild(buildEditCell(subject, 'læringsmål', map[subject + '||læringsmål'] || []));
    tr.appendChild(buildEditCell(subject, 'ressurs', map[subject + '||ressurs'] || []));
    tr.appendChild(buildHomeworkEditCell(subject, (map[subject + '||lekse'] || []).slice().sort(byDay)));
    tr.appendChild(buildVurdCell(subject, vurdBySubject[subject] || []));
  });

  wrap.appendChild(table);
  board.appendChild(wrap);
}

function buildEditCell(subject, type, elements) {
  const td = document.createElement('td');
  td.className = 'cell-edit';
  // Inline-edit single-week elements; multi-week ones become clickable chips.
  const single = elements.filter(e => !isMultiWeek(e));
  const multi  = elements.filter(isMultiWeek);
  const ed = createRichField({
    value: single.map(e => e.description).filter(Boolean).join('<br>'),
    placeholder: '–',
    className: 'edit-rich',
    onCommit: html => commitRichCell(ed, html),
  });
  ed.dataset.subject = subject;
  ed.dataset.type    = type;
  ed.dataset.ids     = JSON.stringify(single.map(e => e.id).filter(Boolean));
  td.appendChild(ed);
  addCellActions(td, ed, subject, type);   // delete + copy while editing
  multi.forEach(el => td.appendChild(buildElementChip(el)));
  return td;
}

// A small "delete + copy" action bar shown at the top-right of an inline rich cell
// while it's focused and has content – so a filled cell can be deleted/copied
// without emptying it and clicking away. `mousedown` preventDefault keeps the
// field focused (so clicking a button doesn't blur-commit first).
function addCellActions(td, ed, subject, type) {
  const bar = document.createElement('div');
  bar.className = 'cell-actions no-print';
  const mk = (cls, label, txt, onClick) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cell-action ' + cls;
    b.title = label; b.setAttribute('aria-label', label); b.textContent = txt;
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', onClick);
    return b;
  };
  if (!isElective(subject)) {   // electives are year-wide – no per-class copy
    bar.appendChild(mk('cell-action-copy', 'Kopier til dine andre klasser', '⧉',
      () => { ed.blur(); copyRowToClasses(subject, { types: [type] }); }));   // commit first, then copy
  }
  bar.appendChild(mk('cell-action-del', 'Slett innholdet', '🗑', () => {
    // Reuse the exact manual deletion flow: empty the field, then blur so the
    // commit-on-blur runs (confirm dialog + restore-on-cancel), with no mid-flow
    // re-blur race (the field is already blurred before the dialog opens).
    ed.innerHTML = ''; ed.blur();
  }));
  td.appendChild(bar);
  const sync = () => td.classList.toggle('has-content', !!(ed.textContent || '').trim());
  ed.addEventListener('input', sync);
  ed.addEventListener('focus', sync);
  sync();
}

// Clickable chip for an element that spans weeks and/or several days
// (edited via the modal, not inline). Shows a range/day tag + its text.
function buildElementChip(el) {
  const chip = document.createElement('div');
  chip.className = 'el-chip';
  const tags = [];
  if (isMultiWeek(el)) tags.push(weekRangeShort(el));
  if (parseDays(el.day).length > 1) tags.push(daysLabel(el.day));
  if (tags.length) {
    const tag = document.createElement('span');
    tag.className = 'el-chip-tag';
    tag.textContent = tags.join(' · ');
    chip.appendChild(tag);
  }
  const txt = document.createElement('span');
  txt.className = 'rich-content';
  txt.innerHTML = sanitizeHtml(el.description || '');
  chip.appendChild(txt);
  chip.title = 'Klikk for å redigere';
  chip.addEventListener('click', () => openElementEdit(el));
  return chip;
}

// Lekser cell: a list of per-item rows, each with its own day. Because the
// board edits one class at a time, this also gives a per-class day for shared
// homework. Each row maps to one element.
const DAY_OPTIONS = [['', '–'], ['man', 'Man'], ['tir', 'Tir'], ['ons', 'Ons'], ['tor', 'Tor'], ['fre', 'Fre']];

// opts.cls / opts.week bind the cell to a specific class + ISO week (used by the
// Progresjon view, where each row is one week); the board passes neither and
// falls back to the current class (planKey) and viewed week.
function buildHomeworkEditCell(subject, elements, opts = {}) {
  const td = document.createElement('td');
  td.className = 'cell-edit cell-homework-edit';
  // Simple lekser (single week, ≤1 day) edit inline; multi-week/multi-day → chips.
  const simple  = elements.filter(e => !isMultiWeek(e) && parseDays(e.day).length <= 1);
  const complex = elements.filter(e => isMultiWeek(e) || parseDays(e.day).length > 1);
  const list = document.createElement('div');
  list.className = 'hw-edit-list';
  td.appendChild(list);
  simple.forEach(el => list.appendChild(buildHomeworkRow(subject, el, opts)));

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'hw-edit-add';
  add.textContent = '+ lekse';
  add.addEventListener('click', () => {
    // Add one blank lekse row per configured standard day for this subject+class
    // (or a single dayless row). opts.cls = Progresjon's row class; else the board's.
    const days = lekseDaysFor(subject, opts.cls || selectedClass);
    const list2 = days.length ? days : [''];
    let first = null;
    list2.forEach(d => {
      const row = buildHomeworkRow(subject, null, Object.assign({}, opts, { day: d }));
      list.appendChild(row);
      if (!first) first = row;
    });
    const f = first && first.querySelector('.rich-field'); if (f) f.focus();
  });
  td.appendChild(add);
  complex.forEach(el => td.appendChild(buildElementChip(el)));
  return td;
}

function buildHomeworkRow(subject, el, opts = {}) {
  const row = document.createElement('div');
  row.className = 'hw-edit-row';

  const daySel = document.createElement('select');
  daySel.className = 'hw-day';
  DAY_OPTIONS.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; daySel.appendChild(o); });
  // Existing lekse keeps its day; a NEW row uses the day passed in by "+ lekse".
  daySel.value = el ? (parseDays(el.day)[0] || '') : (opts.day || '');

  const ed = createRichField({
    value: (el && el.description) || '',
    placeholder: 'Ny lekse…',
    className: 'edit-rich hw-edit-text',
    onCommit: () => commitHomeworkRow(row),
  });
  ed.dataset.id      = (el && el.id) || '';
  ed.dataset.subject = subject;
  if (opts.cls)  ed.dataset.cls  = opts.cls;
  if (opts.week) ed.dataset.week = opts.week;

  daySel.addEventListener('change', () => commitHomeworkRow(row));

  row.appendChild(daySel);
  row.appendChild(ed);
  // Copy this subject's lekser to the teacher's other classes (core only; electives
  // are year-wide). Kept off the modal-edited (variant) board.
  if (!isElective(subject) && !opts.cls) {
    const cp = document.createElement('button');
    cp.type = 'button';
    cp.className = 'hw-edit-copy';
    cp.textContent = '⧉';
    cp.title = 'Kopier til dine andre klasser';
    cp.addEventListener('mousedown', e => e.preventDefault());
    cp.addEventListener('click', () => copyRowToClasses(subject, { types: ['lekse'] }));
    row.appendChild(cp);
  }
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'hw-edit-del';
  del.textContent = '×';
  del.title = 'Slett lekse';
  del.addEventListener('click', () => deleteHomeworkRow(row));
  row.appendChild(del);
  return row;
}

// Called on field blur (text change) or day-select change. A per-field _busy
// flag serializes saves on the same row. If a second commit arrives mid-save
// (e.g. you type, then immediately pick a day), it's marked _pending and
// re-run once the in-flight save finishes – by then the row has an id, so the
// day is persisted via update instead of being dropped.
async function commitHomeworkRow(row) {
  const ed     = row.querySelector('.rich-field');
  const daySel = row.querySelector('select');
  if (!ed) return;
  if (ed._busy) { ed._pending = true; return; }
  const val     = sanitizeHtml(ed.innerHTML).trim();
  const id      = ed.dataset.id;
  const day     = daySel.value;
  const subject = ed.dataset.subject;
  // Progresjon rows bind class + week; the board falls back to current context.
  const week    = ed.dataset.week || dateToWeek(weekMonday);
  const classes = writeClassesFor(subject, ed.dataset.cls || planKey());   // whole year for electives

  const rerunIfPending = () => {
    ed._busy = false;
    if (ed._pending) { ed._pending = false; commitHomeworkRow(row); }
  };

  if (!val) {
    if (id) {
      if (!await confirmDeletion('Du er i ferd med å slette denne leksa.')) {
        const el = findLoadedElement(id);
        ed.innerHTML = sanitizeHtml((el && el.description) || '');
        ed._original = ed.innerHTML;
        return;
      }
      ed._busy = true; setSaving();
      try {
        const el = findLoadedElement(id);
        await api('delete', { id });
        if (el) recordDelete(el, 'lekse');
        planData = planData.filter(p => p.id !== id);
        allPlanData = allPlanData.filter(p => p.id !== id);
        cacheCurrentWeek();
        ed.dataset.id = ''; ed._original = ''; ed.classList.remove('unsaved'); setSaved();
      }
      catch (err) { ed.classList.add('unsaved'); setSaveError(err.message); }
      finally { rerunIfPending(); }
    }
    return;
  }

  ed._busy = true; setSaving();
  try {
    if (id) {
      const el = findLoadedElement(id);
      const before = elementUpdateFields(el);
      await api('update', { id, type: 'lekse', classes, week, day, subject, description: val, teacher: teacherName });
      recordUpdate(id, before, { type: 'lekse', classes, week, weekTo: '', day, subject, description: val, teacher: teacherName }, 'lekse');
      if (el) { el.description = val; el.day = day; }
    } else {
      const params = { type: 'lekse', classes, week, day, subject, description: val, teacher: teacherName };
      const created = await api('create', params);
      ed.dataset.id = created && created.id ? created.id : '';
      if (created && created.id) {
        recordCreate(params, created.id, 'lekse');
        // Progresjon rows draw from allPlanData; the board from planData
        // (only while the commit's week is still the one on screen).
        if (ed.dataset.cls) allPlanData.push(created);
        else if (week === dateToWeek(weekMonday)) { planData.push(created); offerRowCopy(subject, 'lekse'); }
      }
    }
    ed._original = sanitizeHtml(ed.innerHTML);
    allPlanTs = 0;
    ed.classList.remove('unsaved');
    setSaved();
    flashSaved(ed);
  } catch (err) {
    ed.classList.add('unsaved');
    setSaveError(err.message);
  } finally {
    rerunIfPending();
  }
}

async function deleteHomeworkRow(row) {
  const ed = row.querySelector('.rich-field');
  const id = ed && ed.dataset.id;
  if (id) {
    if (!await confirmDeletion('Slette denne leksa?')) return;
    setSaving();
    try {
      const el = findLoadedElement(id);
      await api('delete', { id });
      if (el) recordDelete(el, 'lekse');
      planData = planData.filter(p => p.id !== id);
      allPlanData = allPlanData.filter(p => p.id !== id);
      cacheCurrentWeek();
      setSaved();
    }
    catch (err) { setSaveError(err.message); return; }
  }
  row.remove();
}

// opts.cls / opts.weekFrom target a specific class + week when adding (used by
// Progresjon); the board passes neither and adds for the viewed class+week.
function buildVurdCell(subject, vurd, opts = {}) {
  const td = document.createElement('td');
  td.className = 'cell-vurd';
  vurd.forEach(v => {
    const tag = document.createElement('span');
    tag.className = 'vurd-tag' + (v.id ? ' editable' : ' legacy');
    const dot = document.createElement('span'); dot.className = 'vurd-dot'; tag.appendChild(dot);
    const label = v.day && DAY_LABEL[v.day] ? DAY_LABEL[v.day] + ': ' : '';
    tag.appendChild(document.createTextNode(label + (v.description || v.notes || 'Vurdering')));
    if (v.id) {
      tag.title = 'Klikk for å redigere';
      tag.addEventListener('click', () => openVurdEdit(v));
    } else {
      tag.title = 'Fra det gamle systemet – kan ikke redigeres her';
    }
    td.appendChild(tag);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'vurd-add';
  add.textContent = vurd.length ? '+ vurdering' : '+ legg til';
  add.addEventListener('click', () => {
    if (opts.cls || opts.weekFrom) {
      openAddModal({ type: 'vurdering', subject, classes: opts.cls ? [opts.cls] : undefined, weekFrom: opts.weekFrom });
    } else {
      openVurdAdd(subject);
    }
  });
  td.appendChild(add);
  return td;
}

// Per-field _busy serializes saves so a fast blur→re-edit→blur can't reach the
// create branch twice before the first create has set the id (→ duplicates).
// A commit arriving mid-save is remembered and re-run once the first finishes.
async function commitRichCell(ed, html) {
  if (ed._busy) { ed._pendingHtml = html; return; }
  const ids     = JSON.parse(ed.dataset.ids || '[]');
  const subject = ed.dataset.subject;
  const type    = ed.dataset.type;
  const week    = dateToWeek(weekMonday);
  const val     = html.trim();
  const wcls    = writeClassesFor(subject, planKey());   // whole year for electives

  // Emptying a cell that had content = deletion. Confirm, and put the text back
  // if the teacher backs out.
  if (!val && ids.length) {
    if (!await confirmDeletion('Du er i ferd med å slette alt innholdet i denne cellen.')) {
      restoreRichCell(ed, ids);
      return;
    }
  }

  ed._busy = true;
  setSaving();
  try {
    if (!val) {
      for (const id of ids) { const el = findLoadedElement(id); await api('delete', { id }); if (el) recordDelete(el, 'sletting'); }
      planData = planData.filter(p => !ids.includes(p.id));
      cacheCurrentWeek();
      ed.dataset.ids = '[]';
    } else if (ids.length) {
      const el = findLoadedElement(ids[0]);
      const before = elementUpdateFields(el);
      await api('update', {
        id: ids[0], type, classes: wcls, week,
        day: '', subject, description: val, teacher: teacherName,
      });
      recordUpdate(ids[0], before, { type, classes: wcls, week, weekTo: '', day: '', subject, description: val, teacher: teacherName }, 'endring');
      if (el) el.description = val;
      for (const extra of ids.slice(1)) await api('delete', { id: extra });
      planData = planData.filter(p => !ids.slice(1).includes(p.id));
      cacheCurrentWeek();
      ed.dataset.ids = JSON.stringify([ids[0]]);
    } else {
      const params = { type, classes: wcls, week, day: '', subject, description: val, teacher: teacherName };
      const created = await api('create', params);
      ed.dataset.ids = JSON.stringify(created && created.id ? [created.id] : []);
      // Keep planData in step so a deferred re-render shows the new content
      // (only while the commit's week is still the one on screen).
      if (created && created.id) {
        recordCreate(params, created.id, 'tekst');
        if (week === dateToWeek(weekMonday)) planData.push(created);
        offerRowCopy(subject, type);
      }
    }
    allPlanTs = 0;
    ed.classList.remove('unsaved');
    setSaved();
    flashSaved(ed);
  } catch (err) {
    ed.classList.add('unsaved');
    setSaveError(err.message);
  } finally {
    ed._busy = false;
    if (ed._pendingHtml !== undefined) {
      const next = ed._pendingHtml; ed._pendingHtml = undefined;
      commitRichCell(ed, next);
    }
  }
}


// ─── Add modal ────────────────────────────────────────────────

function setupModalListeners() {
  document.getElementById('addModalClose').addEventListener('click', () => closeAddModal());
  document.getElementById('addCancel').addEventListener('click', () => closeAddModal());
  document.getElementById('modalOverlay').addEventListener('click', () => closeAddModal());
  document.getElementById('addSave').addEventListener('click', saveFromModal);
  document.getElementById('addDelete').addEventListener('click', deleteFromModal);
  // Switching Fag to/from an elective flips the class picker between per-class and
  // per-year (electives are a year unit).
  document.getElementById('subjectSelect').addEventListener('change', () => { buildModalClassBtns(); refreshConflicts(); });
  document.getElementById('weekFrom').addEventListener('change', e => {
    modalWeekFrom = isoToDate(e.target.value);
    if (modalWeekTo < modalWeekFrom) { modalWeekTo = modalWeekFrom; buildModalWeekOptions(); }
    setDateInputBounds();
    refreshConflicts();
  });
  document.getElementById('weekTo').addEventListener('change', e => {
    modalWeekTo = isoToDate(e.target.value);
    if (modalWeekTo < modalWeekFrom) { modalWeekFrom = modalWeekTo; buildModalWeekOptions(); }
    refreshConflicts();
  });
  document.getElementById('dateInput').addEventListener('change', () => { updateDateInfo(); refreshConflicts(); });

  // Subject select – grouped «Mine fag» / «Andre fag» (rebuilt on open too).
  fillSubjectSelect(document.getElementById('subjectSelect'), '(uten fag)');

  // Type buttons
  const typeWrap = document.getElementById('typeBtns');
  MODAL_TYPES.forEach(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'type-btn';
    btn.textContent = TYPE_LABEL[t];
    btn.dataset.type = t;
    btn.addEventListener('click', () => selectModalType(t));
    typeWrap.appendChild(btn);
  });

  // Day buttons (multi-select)
  const dayWrap = document.getElementById('dayBtns');
  DAYS.forEach(d => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-btn';
    btn.textContent = DAY_LABEL[d];
    btn.dataset.day = d;
    btn.addEventListener('click', () => {
      if (modalDays.includes(d)) modalDays = modalDays.filter(x => x !== d);
      else modalDays.push(d);
      syncDayBtns();
    });
    dayWrap.appendChild(btn);
  });

  // Esc closes whichever modal is open; the add modal goes through the same
  // discard guard as the other close paths. In-app dialogs (.ui-dialog)
  // handle their own Esc, so stay out of the way while one is open.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.ui-dialog')) return;
    const open = id => document.getElementById(id).classList.contains('open');
    if (open('onboardModal')) completeOnboarding();   // Esc leaves the wizard
    else if (open('addModal')) closeAddModal();
    else if (open('vurdFilterModal')) closeVurdFilterModal();
    else if (open('viewSubjectsModal')) closeViewSubjectsModal();
    else if (open('adminModal')) closeAdminModal();
    else if (open('profileModal')) closeProfileModal();
    else if (open('classModal')) closeClassModal();
  });
}

// The Lærer field defaults to the dashboard name but can be overridden per entry.
function modalTeacherValue() {
  return document.getElementById('vurdTeacherInput').value.trim() || teacherName;
}

function openAddModal(preset = {}) {
  if (!selectedClass) { showClassModal(); return; }
  editingVurd    = null;
  editingElement = null;
  modalType      = preset.type || 'lekse';
  // In an adapted plan, plan elements are saved under the code; assessments
  // (vurdering) stay on the base class so they're shared with the whole class.
  modalClasses   = preset.classes ? preset.classes.slice()
                 : (variantCode && modalType !== 'vurdering' ? [variantCode] : [selectedClass]);
  modalDays      = preset.days ? preset.days.slice() : [];
  modalWeekFrom  = preset.weekFrom || weekMonday;
  modalWeekTo    = preset.weekTo || modalWeekFrom;
  modalPendingDesc = '';
  modalInitialDesc = '';
  document.getElementById('vurdTeacherInput').value = preset.teacher || teacherName;
  fillSubjectSelect(document.getElementById('subjectSelect'), '(uten fag)');   // reflect current Mine fag
  document.getElementById('subjectSelect').value = preset.subject || '';
  buildModalWeekOptions();
  setDateInputBounds(preset.date);
  document.getElementById('addModalTitle').textContent = 'Legg til element';
  document.getElementById('addDelete').hidden = true;
  document.getElementById('addSave').textContent = 'Lagre';

  selectModalType(modalType);
  buildModalClassBtns();
  syncDayBtns();
  showModal();
}

// Edit an existing plan element (clicked from a board cell / general section).
function openElementEdit(el) {
  if (!el.id) { showToast('Dette elementet kan ikke redigeres her.'); return; }
  editingVurd    = null;
  editingElement = el;
  modalType      = el.type;
  modalClasses   = String(el.classes || '').toUpperCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (!modalClasses.length) modalClasses = [selectedClass];
  modalDays      = parseDays(el.day);
  modalWeekFrom  = weekStringToMonday(el.week);
  modalWeekTo    = weekStringToMonday(el.weekTo || el.week);
  modalPendingDesc = el.description || '';
  modalInitialDesc = el.description || '';
  document.getElementById('vurdTeacherInput').value = el.teacher || teacherName;
  document.getElementById('subjectSelect').value = SUBJECTS.includes(el.subject) ? el.subject : '';
  buildModalWeekOptions();
  document.getElementById('addModalTitle').textContent = 'Rediger element';
  document.getElementById('addDelete').hidden = false;
  document.getElementById('addSave').textContent = 'Lagre';

  selectModalType(el.type);
  buildModalClassBtns();
  syncDayBtns();
  showModal();
}

// Add a vurdering for a specific subject (from the board's "+ vurdering").
function openVurdAdd(subject) {
  openAddModal({ type: 'vurdering', subject });
}

// Edit an existing vurdering (clicked tag). Legacy entries have no id.
function openVurdEdit(v) {
  if (!v.id) { showToast('Denne vurderingen er fra det gamle systemet og kan ikke redigeres her.'); return; }
  editingVurd    = v;
  editingElement = null;
  modalType    = 'vurdering';
  modalClasses = String(v.classes || '').toUpperCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (modalClasses.length === 0) modalClasses = [selectedClass];
  modalDays = [];
  modalWeekFrom = v.date ? mondayOf(isoToDate(v.date)) : weekMonday;
  modalWeekTo   = modalWeekFrom;
  modalPendingDesc = v.description || v.notes || '';
  modalInitialDesc = v.description || v.notes || '';
  document.getElementById('vurdTeacherInput').value = v.teacher || teacherName;
  document.getElementById('subjectSelect').value = SUBJECTS.includes(v.subject) ? v.subject : '';
  buildModalWeekOptions();
  setDateInputBounds(v.date);
  document.getElementById('dateInput').value = v.date || '';
  document.getElementById('addModalTitle').textContent = 'Rediger vurdering';
  document.getElementById('addDelete').hidden = false;
  document.getElementById('addSave').textContent = 'Lagre';

  selectModalType('vurdering');
  buildModalClassBtns();
  showModal();
}

function showModal() {
  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('addModal').classList.add('open');
  document.body.classList.add('scroll-locked');
  setTimeout(() => (modalDescEd || document.getElementById('descInput')).focus(), 60);
}

// Date picker (vurdering): free choice within the school year. Weekends and
// school-free / planning days are blocked at validation time (vurdDateProblem),
// since <input type=date> can't disable individual dates.
function setDateInputBounds(preferred) {
  const input = document.getElementById('dateInput');
  const b = getSchoolYearBounds(new Date());
  input.min = b.start;
  input.max = b.end;
  if (preferred) { input.value = preferred; updateDateInfo(); return; }
  // New vurdering: default to the viewed week's context, clamped to the year.
  let v = contextualVurdDate();
  if (v < b.start) v = b.start;
  if (v > b.end)   v = b.end;
  input.value = v;
  updateDateInfo();
}

// Populate the from/til week dropdowns centred on the modal's start week. The
// forward range reaches the END of the school year containing the centre week,
// so a teacher planning on the August planning days (uke 32/33) can set lekser
// all the way to June of the coming school year – with a sensible minimum.
function buildModalWeekOptions() {
  const fromSel = document.getElementById('weekFrom');
  const toSel   = document.getElementById('weekTo');
  const center  = modalWeekFrom || weekMonday;
  const fromISO = toISODate(modalWeekFrom || center);
  const toISO   = toISODate(modalWeekTo || center);
  fromSel.innerHTML = '';
  toSel.innerHTML = '';
  const endMonday  = mondayOf(isoToDate(getSchoolYearBounds(center).end));
  const weeksToEnd = Math.round((endMonday - mondayOf(center)) / (7 * 86400000));
  const maxOff     = Math.max(44, weeksToEnd + 1);
  for (let off = -4; off <= maxOff; off++) {
    const m = addDays(center, off * 7);
    const label = 'Uke ' + getWeekNumber(m) + ' · ' + formatWeekRange(m, addDays(m, 4));
    const o1 = document.createElement('option'); o1.value = toISODate(m); o1.textContent = label; if (o1.value === fromISO) o1.selected = true; fromSel.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = toISODate(m); o2.textContent = label; if (o2.value === toISO) o2.selected = true; toSel.appendChild(o2);
  }
}

// Every close path (×, Avbryt, backdrop, Esc) asks before discarding unsaved
// text; programmatic closes after a successful save pass { force: true }.
function closeAddModal(opts = {}) {
  if (!opts.force) {
    const cur = modalDescGet().text;
    if (cur && cur !== modalHtmlToText(modalInitialDesc).trim()) {
      uiConfirm('Du har ikke lagret. Lukke og forkaste det du har skrevet?', {
        title: 'Forkaste endringer?', okText: 'Forkast', danger: true,
      }).then(ok => { if (ok) reallyCloseAddModal(); });
      return;
    }
  }
  reallyCloseAddModal();
}
function reallyCloseAddModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.getElementById('addModal').classList.remove('open');
  document.body.classList.remove('scroll-locked');
}

// Plan elements support rich text (like the board); vurderinger stay plain.
function modalHtmlToText(html) {
  const d = document.createElement('div');
  d.innerHTML = sanitizeHtml(html || '');
  return d.textContent || '';
}
// Build the modal's description editor for the current type, seeded with `seed`.
function buildModalDescEditor(seed) {
  const ta = document.getElementById('descInput');
  const box = document.getElementById('descRich');
  if (modalType !== 'vurdering') {          // rich
    box.innerHTML = '';
    modalDescEd = createRichField({
      value: seed || '',
      placeholder: 'Skriv innhold… (merk tekst for fet / understrek / lenke)',
      className: 'modal-rich',
      onCommit: () => {},                    // read on Save, not on blur
    });
    box.appendChild(modalDescEd);
    box.hidden = false; ta.hidden = true;
  } else {                                   // plain (assessments stay plain text)
    ta.value = modalHtmlToText(seed);
    ta.hidden = false; box.hidden = true; box.innerHTML = '';
    modalDescEd = null;
  }
}
// { value: what to save, text: plain text for empty/dirty checks }.
function modalDescGet() {
  if (modalDescEd) {
    return { value: sanitizeHtml(modalDescEd.innerHTML).trim(), text: (modalDescEd.textContent || '').trim() };
  }
  const v = document.getElementById('descInput').value.trim();
  return { value: v, text: v };
}

function selectModalType(t) {
  // Preserve what's typed across a type switch; on open, seed from modalPendingDesc.
  const seed = (modalPendingDesc !== null) ? modalPendingDesc : modalDescGet().value;
  modalPendingDesc = null;
  modalType = t;
  buildModalDescEditor(seed);
  document.querySelectorAll('#typeBtns .type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === t));
  const isVurd = t === 'vurdering';
  const hasDay = t === 'lekse' || GENERAL_TYPES.includes(t); // lekse + general types
  document.getElementById('subjectRow').style.display    = '';            // all types can carry a subject
  document.getElementById('weekRangeRow').style.display  = isVurd ? 'none' : '';
  document.getElementById('dateRow').style.display       = isVurd ? '' : 'none';
  document.getElementById('dayRow').style.display        = hasDay ? '' : 'none';
  if (!hasDay) { modalDays = []; syncDayBtns(); }

  // Adapted plan: plan elements target the code (hide the class picker, show a
  // note); vurdering keeps the normal class picker (assessments are class-wide).
  const variantPlan = !!variantCode && !isVurd;
  const classRow = document.getElementById('classRow');
  const note     = document.getElementById('variantClassNote');
  if (classRow) classRow.style.display = variantPlan ? 'none' : '';
  if (note) {
    note.hidden = !variantPlan;
    if (variantPlan) note.querySelector('strong').textContent = variantCode;
  }
  if (variantCode && !editingElement && !editingVurd) {
    modalClasses = variantPlan ? [variantCode] : [selectedClass];
    buildModalClassBtns();
  }
  // Editing an existing plan element: lock the class so a stray click can't put
  // two classes on one row (the other classes have their own separate rows) (B5).
  const editNote = document.getElementById('editClassNote');
  if (editNote) editNote.hidden = !(editingElement && !variantPlan);
  refreshConflicts();
  updateDateInfo();
}

function buildModalClassBtns() {
  const grid = document.getElementById('classBtns');
  grid.innerHTML = '';
  // Electives are a year-level unit → pick by grade-year, not per class (plan
  // types only; vurderinger stay class-wide). Selecting a year toggles the whole
  // grade in modalClasses; the write path collapses it to one element per year.
  const subject  = document.getElementById('subjectSelect').value;
  const byYear   = isElective(subject) && modalType !== 'vurdering';
  CLASS_GRADES.forEach(group => {
    const wrap = document.createElement('div');
    wrap.className = 'class-modal-group';
    const lbl = document.createElement('span');
    lbl.className = 'class-grade-label';
    lbl.textContent = group.label;
    wrap.appendChild(lbl);

    if (byYear) {
      // Any class of the year selected = the year is "on" (the write covers the
      // whole year via electiveWriteGroups regardless).
      const on = group.classes.some(c => modalClasses.includes(c));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'class-modal-btn' + (on ? ' active' : '');
      btn.textContent = group.label + ' trinn';
      if (editingElement) { btn.disabled = true; btn.classList.add('locked'); }
      else btn.addEventListener('click', () => {
        const turnOn = !group.classes.some(c => modalClasses.includes(c));
        group.classes.forEach(c => {
          const has = modalClasses.includes(c);
          if (turnOn && !has) modalClasses.push(c);
          if (!turnOn && has) modalClasses = modalClasses.filter(x => x !== c);
        });
        buildModalClassBtns();
        refreshConflicts();
      });
      wrap.appendChild(btn);
      grid.appendChild(wrap);
      return;
    }

    group.classes.forEach(cls => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'class-modal-btn';
      btn.textContent = cls;
      if (modalClasses.includes(cls)) btn.classList.add('active');
      // Lock class selection when editing an existing plan element (B5).
      if (editingElement) {
        btn.disabled = true;
        btn.classList.add('locked');
      } else {
        btn.addEventListener('click', () => {
          if (modalClasses.includes(cls)) modalClasses = modalClasses.filter(c => c !== cls);
          else modalClasses.push(cls);
          btn.classList.toggle('active');
          refreshConflicts();
        });
      }
      wrap.appendChild(btn);
    });
    if (!editingElement) {   // per-grade «Velg alle» (class selection is locked when editing)
      const allOn = group.classes.every(c => modalClasses.includes(c));
      const gBtn = document.createElement('button');
      gBtn.type = 'button';
      gBtn.className = 'link-btn class-selectall-grade';
      gBtn.textContent = allOn ? 'Fjern alle' : 'Velg alle';
      gBtn.addEventListener('click', () => {
        const on = !allOn;
        group.classes.forEach(c => {
          const has = modalClasses.includes(c);
          if (on && !has) modalClasses.push(c);
          if (!on && has) modalClasses = modalClasses.filter(x => x !== c);
        });
        buildModalClassBtns();
        refreshConflicts();
      });
      wrap.appendChild(gBtn);
    }
    grid.appendChild(wrap);
  });
}

function syncDayBtns() {
  document.querySelectorAll('#dayBtns .day-btn').forEach(b => b.classList.toggle('active', modalDays.includes(b.dataset.day)));
}

async function saveFromModal() {
  if (modalSaving) return;   // a save is already running – ignore extra clicks
  const d = modalDescGet();
  const desc = d.value;      // rich HTML for plan elements, plain text for vurdering
  if (!d.text) { showToast('Skriv inn innhold først.'); return; }
  if (modalClasses.length === 0) { showToast('Velg minst én klasse.'); return; }

  const subject = document.getElementById('subjectSelect').value;
  if (modalType !== 'vurdering' && SUBJECT_TYPES.includes(modalType) && !subject) {
    showToast('Velg fag.'); return;
  }

  beginModalSaving();
  try {
    if (modalType === 'vurdering') { await saveVurderingFromModal(desc); return; }

    let weekFrom = dateToWeek(modalWeekFrom);
    let weekTo   = dateToWeek(modalWeekTo);
    if (weekFrom > weekTo) { const t = weekFrom; weekFrom = weekTo; weekTo = t; }
    // Læringsmål/ressurs are week-level (no day); lekser and general types may carry day(s).
    const day = (modalType === 'lekse' || GENERAL_TYPES.includes(modalType)) ? modalDays.join(',') : '';
    const teacher = modalTeacherValue();

    setSaving();
    try {
      if (editingElement) {
        const before = elementUpdateFields(editingElement);
        const after  = { type: modalType, classes: modalClasses.join(' '), week: weekFrom, weekTo, day, subject, description: desc, teacher };
        await api('update', Object.assign({ id: editingElement.id }, after));
        recordUpdate(editingElement.id, before, after, 'endring');
      } else {
        const creates = [];
        // Electives are a year unit → one element per grade-year (classes = the
        // whole year); other subjects → one element per selected class.
        for (const classes of electiveWriteGroups(subject, modalClasses)) {
          const params = { type: modalType, classes, week: weekFrom, weekTo, day, subject, description: desc, teacher };
          const r = await api('create', params);
          creates.push({ params, id: r && r.id });
        }
        recordCreateMany(creates, 'la til ' + (TYPE_LABEL[modalType] || 'element'));
      }
      setSaved();
      closeAddModal({ force: true });
      if (weekFrom !== dateToWeek(weekMonday) || weekTo !== weekFrom) {
        showToast('Lagret for uke ' + getWeekNumber(modalWeekFrom) + (weekTo !== weekFrom ? '–' + getWeekNumber(modalWeekTo) : '') + '.');
      }
      refreshAfterChange();
    } catch (err) {
      setSaveError(err.message);
    }
  } finally {
    endModalSaving();
  }
}

// Lock the modal's Save button while a request is in flight so a slow network
// can't let a second click create a duplicate entry.
function beginModalSaving() {
  modalSaving = true;
  const btn = document.getElementById('addSave');
  btn.disabled = true;
  btn.dataset.label = btn.textContent;
  btn.textContent = 'Lagrer…';
}
function endModalSaving() {
  modalSaving = false;
  const btn = document.getElementById('addSave');
  btn.disabled = false;
  if (btn.dataset.label) btn.textContent = btn.dataset.label;
}

// Assessments live in the vurderingskalender backend. A single entry can carry
// several classes (space-separated), matching that system's convention.
async function saveVurderingFromModal(desc) {
  const date = document.getElementById('dateInput').value;
  if (!date) { showToast('Velg en dato for vurderingen.'); return; }
  // B2: no assessments on weekends or school-free / planning days.
  const problem = vurdDateProblem(date);
  if (problem) { showToast(problem + '. Velg en vanlig skoledag.'); return; }
  const subject = document.getElementById('subjectSelect').value;
  const classes = modalClasses.join(' ');
  const teacher = modalTeacherValue();

  setSaving();
  try {
    if (editingVurd && editingVurd.id) {
      const before = { date: editingVurd.date, subject: editingVurd.subject || '', classes: editingVurd.classes || '', description: editingVurd.description || editingVurd.notes || '', teacher: editingVurd.teacher || '' };
      const after  = { date, subject, classes, description: desc, teacher };
      await vurdApi('update', Object.assign({ id: editingVurd.id }, after));
      recordVurdUpdate(editingVurd.id, before, after, 'endret vurdering');
    } else {
      const params = { date, subject, classes, description: desc, teacher };
      const r = await vurdApi('create', params);
      if (r && r.id) recordVurdCreate(params, r.id, 'la til vurdering');
    }
    setSaved();
    closeAddModal({ force: true });
    loadAssessments();
  } catch (err) {
    setSaveError(err.message);
  }
}

async function deleteFromModal() {
  if (editingVurd && editingVurd.id) {
    if (!await uiConfirm('Slette denne vurderingen?', { title: 'Slette vurdering', okText: 'Slett', danger: true })) return;
    setSaving();
    try { const v = editingVurd; await vurdApi('delete', { id: v.id }); recordVurdDelete(v, 'slettet vurdering'); setSaved(); closeAddModal({ force: true }); loadAssessments(); }
    catch (err) { setSaveError(err.message); }
    return;
  }
  if (editingElement && editingElement.id) {
    if (!await uiConfirm('Slette dette elementet' + (isMultiWeek(editingElement) ? ' (gjelder ' + weekRangeShort(editingElement) + ')' : '') + '?', { title: 'Slette element', okText: 'Slett', danger: true })) return;
    setSaving();
    try { const el = editingElement; await api('delete', { id: el.id }); recordDelete(el, 'slettet element'); setSaved(); closeAddModal({ force: true }); refreshAfterChange(); }
    catch (err) { setSaveError(err.message); }
  }
}

// ─── Clone previous week ──────────────────────────────────────

// Disable both clone buttons while a clone is running so a slow network can't
// let a second click create duplicate entries.
function setCloneButtonsDisabled(disabled) {
  ['cloneBtn', 'cloneFromClassBtn'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = disabled;
  });
}

// Checkbox dialog for «Kopier forrige uke»: pick which subjects come along
// (pre-checked from Mine fag, so one teacher's clone doesn't duplicate the
// colleagues' fresh entries) and whether beskjeder/praktisk info follow.
function cloneChoiceDialog({ weekNo, where, subjects, hasGeneral, warnExisting }) {
  const my = mySubjects();
  return buildUiDialog({
    title: 'Kopier forrige uke',
    render: ctx => {
      const p = document.createElement('p');
      p.className = 'ui-dialog-message';
      p.textContent = 'Velg hva som kopieres til uke ' + weekNo + ' for ' + where + ':';
      ctx.body.appendChild(p);
      const mkCheck = (labelText, checked) => {
        const lab = document.createElement('label');
        lab.className = 'ui-dialog-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(' ' + labelText));
        ctx.body.appendChild(lab);
        return cb;
      };
      const boxes = subjects.map(s => ({ subject: s, cb: mkCheck(s, !my.length || my.includes(s)) }));
      const generalCb = hasGeneral ? mkCheck('Beskjeder og praktisk info', !my.length) : null;
      if (warnExisting) {
        const w = document.createElement('p');
        w.className = 'ui-dialog-message ui-dialog-warn';
        w.textContent = '⚠ Denne uka har allerede innhold – kopiering kan gi dobbeltoppføringer.';
        ctx.body.appendChild(w);
      }
      return { boxes, generalCb };
    },
    buttons: [
      { label: 'Avbryt', className: 'btn-ghost', value: null },
      { label: 'Kopier', className: 'btn-primary', primary: true, onClick: (ctx, f) => {
        const chosen = f.boxes.filter(b => b.cb.checked).map(b => b.subject);
        const general = !!(f.generalCb && f.generalCb.checked);
        if (!chosen.length && !general) { ctx.setError('Velg minst ett fag (eller beskjeder).'); return undefined; }
        return { subjects: chosen, general };
      } },
    ],
  });
}

async function cloneFromPreviousWeek() {
  if (cloning) return;
  cloning = true;
  setCloneButtonsDisabled(true);
  try {
    const toWeek   = dateToWeek(weekMonday);
    const fromWeek = dateToWeek(addDays(weekMonday, -7));

    // Fetch last week's content so the dialog can list what's copyable.
    showBgLoading();
    let prev = [];
    try {
      const res = await fetch(`${SCRIPT_URL}?action=week&classes=${encodeURIComponent(planKey())}&week=${encodeURIComponent(fromWeek)}`);
      const data = await res.json();
      if (Array.isArray(data)) prev = data;
    } catch {
      showToast('Kunne ikke hente forrige uke. Sjekk tilkoblingen og prøv igjen.');
      return;
    } finally { hideBgLoading(); }
    // Multi-week elements that already cover this week aren't cloned (the
    // backend skips them – they'd show twice), so don't list them either.
    prev = prev.filter(p => !(p.week <= toWeek && (p.weekTo || p.week) >= toWeek));

    const subjects = [...new Set(prev.filter(p => SUBJECT_TYPES.includes(p.type) && p.subject).map(p => p.subject))]
      .sort((a, b) => SUBJECTS.indexOf(a) - SUBJECTS.indexOf(b));
    const hasGeneral = prev.some(p => GENERAL_TYPES.includes(p.type));
    if (!subjects.length && !hasGeneral) { showToast('Fant ikke noe innhold i forrige uke å kopiere.'); return; }

    const hasContent = planData.some(p => SUBJECT_TYPES.includes(p.type) || GENERAL_TYPES.includes(p.type));
    const choice = await cloneChoiceDialog({
      weekNo: getWeekNumber(weekMonday),
      where: variantCode ? 'den tilpassede planen' : selectedClass,
      subjects, hasGeneral, warnExisting: hasContent,
    });
    if (!choice) return;

    setSaving();
    const result = await api('clone', {
      fromWeek, toWeek, classes: planKey(),
      subjects: choice.subjects.join(','), general: choice.general ? '1' : '0',
    });
    setSaved();
    if (result.entries && result.entries.length) {
      recordCreateMany(result.entries.map(en => ({ id: en.id, params: elementCreateParams(en) })), 'kopierte forrige uke');
    }
    showToast(`Kopierte ${result.count || 0} element(er) fra forrige uke.`);
    loadData({ background: true, skipCache: true });
  } catch (err) {
    setSaveError(err.message);
  } finally {
    cloning = false;
    setCloneButtonsDisabled(false);
  }
}

// Copy a subject row to other classes – pick which cell types (and optionally
// vurderinger) to copy; targets pre-select the teacher's other classes for the
// subject (the matrix). Idempotent: a target that already has the content is
// skipped (one all-classes week fetch); single undo. `opts.types` presets which
// kinds start checked (the post-edit affordance passes just the edited type).
const COPY_KINDS = [
  { key: 'læringsmål', label: 'Tema' },
  { key: 'ressurs',    label: 'Ressurser' },
  { key: 'lekse',      label: 'Lekser' },
  { key: 'vurdering',  label: 'Vurdering' },
];
// After a NEW cell is saved, offer to copy it to the teacher's other classes for
// the subject (matrix) – a quick, dismissable nudge, only when relevant.
const COPY_TYPE_SHORT = { 'læringsmål': 'tema', 'ressurs': 'ressurser', 'lekse': 'lekser' };
function offerRowCopy(subject, type) {
  if (variantCode) return;
  if (isElective(subject)) return;   // electives are already a year-wide unit – nothing to copy
  const others = classesForSubject(subject).filter(c => c !== selectedClass);
  if (!others.length) return;
  showToast('Lagret. Kopiere ' + (COPY_TYPE_SHORT[type] || 'innholdet') + ' til dine andre ' + others.length + ' ' + subject + '-klasser?',
    { duration: 6000, action: { label: 'Kopier', onClick: () => copyRowToClasses(subject, { types: [type] }) } });
}
async function copyRowToClasses(subject, opts = {}) {
  if (copyingRow) return;
  const week = dateToWeek(weekMonday);
  const rowEls  = planData.filter(p => SUBJECT_TYPES.includes(p.type) && p.subject === subject);
  const rowVurd = vurdData.filter(v => v.date && dateToWeek(new Date(v.date)) === week
    && v.subject === subject && classMatches(v.classes, selectedClass));
  if (!rowEls.length && !rowVurd.length) { showToast('Ingenting å kopiere i ' + subject + ' denne uka.'); return; }

  const present = k => k === 'vurdering' ? rowVurd.length > 0 : rowEls.some(e => e.type === k);
  const checked = new Set(opts.types
    ? opts.types.filter(present)
    : COPY_KINDS.filter(k => k.key !== 'vurdering' && present(k.key)).map(k => k.key));   // vurdering opt-in

  const mineClasses = classesForSubject(subject).filter(c => c !== selectedClass);        // matrix pre-select
  let chosen = mineClasses.slice();

  const targets = await buildUiDialog({
    title: 'Kopier ' + subject,
    render: ctx => {
      const p = document.createElement('p');
      p.className = 'ui-dialog-message';
      p.textContent = 'Kopierer fra ' + selectedClass + ' for uke ' + getWeekNumber(weekMonday) +
        '. Klasser som allerede har innholdet, hoppes over.';
      ctx.body.appendChild(p);

      const kh = document.createElement('div'); kh.className = 'copy-section-label'; kh.textContent = 'Hva skal kopieres?';
      ctx.body.appendChild(kh);
      const krow = document.createElement('div'); krow.className = 'copy-kinds';
      COPY_KINDS.filter(k => present(k.key)).forEach(k => {
        const b = document.createElement('button'); b.type = 'button';
        b.className = 'class-modal-btn' + (checked.has(k.key) ? ' active' : '');
        b.textContent = k.label;
        b.addEventListener('click', () => {
          if (checked.has(k.key)) checked.delete(k.key); else checked.add(k.key);
          b.classList.toggle('active');
          ctx.setError('');
        });
        krow.appendChild(b);
      });
      ctx.body.appendChild(krow);

      const ch = document.createElement('div'); ch.className = 'copy-section-label'; ch.textContent = 'Til hvilke klasser?';
      ctx.body.appendChild(ch);
      const btnByClass = {};
      if (mineClasses.length) {
        const q = document.createElement('button'); q.type = 'button'; q.className = 'link-btn copy-quick';
        const allMineOn = () => mineClasses.every(c => chosen.includes(c));
        const relabel = () => { q.textContent = allMineOn() ? 'Fjern dine ' + subject + '-klasser' : 'Velg dine ' + subject + '-klasser'; };
        q.addEventListener('click', () => {
          const on = !allMineOn();
          mineClasses.forEach(c => {
            const has = chosen.includes(c);
            if (on && !has) chosen.push(c);
            if (!on && has) chosen = chosen.filter(x => x !== c);
            if (btnByClass[c]) btnByClass[c].classList.toggle('active', chosen.includes(c));
          });
          relabel(); ctx.setError('');
        });
        relabel();
        ctx.body.appendChild(q);
      }
      const grid = document.createElement('div'); grid.className = 'class-modal-grid';
      CLASS_GRADES.forEach(group => {
        const wrap = document.createElement('div'); wrap.className = 'class-modal-group';
        const lbl = document.createElement('span'); lbl.className = 'class-grade-label'; lbl.textContent = group.label;
        wrap.appendChild(lbl);
        group.classes.forEach(cls => {
          const btn = document.createElement('button'); btn.type = 'button';
          btn.className = 'class-modal-btn' + (chosen.includes(cls) ? ' active' : '');
          btn.textContent = cls;
          btnByClass[cls] = btn;
          if (cls === selectedClass) { btn.disabled = true; btn.classList.add('locked'); }
          else btn.addEventListener('click', () => {
            chosen = chosen.includes(cls) ? chosen.filter(c => c !== cls) : chosen.concat(cls);
            btn.classList.toggle('active');
            ctx.setError('');
          });
          wrap.appendChild(btn);
        });
        grid.appendChild(wrap);
      });
      ctx.body.appendChild(grid);
    },
    buttons: [
      { label: 'Avbryt', className: 'btn-ghost', value: null },
      { label: 'Kopier', className: 'btn-primary', primary: true, onClick: ctx => {
        if (!checked.size) { ctx.setError('Velg hva som skal kopieres.'); return undefined; }
        if (!chosen.length) { ctx.setError('Velg minst én klasse.'); return undefined; }
        return chosen.slice();
      } },
    ],
  });
  if (!targets || !targets.length) return;

  const planTypes = [...checked].filter(k => k !== 'vurdering');
  const elsToCopy = rowEls.filter(e => planTypes.includes(e.type));
  const copyVurd = checked.has('vurdering');

  copyingRow = true;
  setSaving();
  try {
    // Fetch the week's content across all classes so we can skip a target that
    // already has the content (keeps the copy idempotent). Best-effort: on a
    // failed fetch we fall back to additive, as before.
    let weekAll = null;
    try {
      const res = await fetch(`${SCRIPT_URL}?action=week&week=${encodeURIComponent(week)}`);
      const d = await res.json();
      if (Array.isArray(d)) weekAll = d;
    } catch { /* additive fallback */ }
    const norm = s => (s || '').trim();
    const targetHasEl = (cls, el) => {
      if (!weekAll) return false;
      if (el.type === 'lekse')   // list item: only an identical one counts as a dup
        return weekAll.some(p => p.type === 'lekse' && p.subject === subject && classMatches(p.classes, cls) && norm(p.description) === norm(el.description));
      return weekAll.some(p => p.type === el.type && p.subject === subject && p.description && classMatches(p.classes, cls));  // week-level cell already filled
    };
    const targetHasVurd = (cls, v) => vurdData.some(x => x.subject === subject && x.date === v.date
      && norm(x.description || x.notes) === norm(v.description || v.notes) && classMatches(x.classes, cls));

    const elems = [], vurds = [];
    let skipped = 0;
    for (const cls of targets) {
      for (const el of elsToCopy) {
        if (targetHasEl(cls, el)) { skipped++; continue; }
        const params = Object.assign(elementCreateParams(el), { classes: cls });
        const r = await api('create', params);
        elems.push({ params, id: r && r.id });
      }
      if (copyVurd) {
        for (const v of rowVurd) {
          if (targetHasVurd(cls, v)) { skipped++; continue; }
          const params = { date: v.date, subject, classes: cls, description: v.description || v.notes || '', teacher: v.teacher || teacherName };
          const r = await vurdApi('create', params);
          vurds.push({ params, id: r && r.id });
        }
      }
    }
    if (!elems.length && !vurds.length) { setSaved(); showToast('Alt fantes fra før – ingenting å kopiere.'); return; }
    recordMixedCreate({ elems, vurds }, 'kopierte ' + subject + ' til ' + targets.join(', '));
    setSaved();
    showToast('Kopierte til ' + targets.join(', ') + '.' + (skipped ? ' (' + skipped + ' fantes fra før)' : ''));
  } catch (err) {
    setSaveError(err.message);
  } finally {
    copyingRow = false;
  }
}

// Seed the adapted plan's current week from its base class (one clone call,
// class → code). Only meaningful while editing a variant.
async function cloneFromBaseClass() {
  if (!variantCode || cloning) return;
  cloning = true;
  setCloneButtonsDisabled(true);
  try {
    const week = dateToWeek(weekMonday);
    const hasContent = planData.some(p => SUBJECT_TYPES.includes(p.type) || GENERAL_TYPES.includes(p.type));
    const msg = hasContent
      ? `Den tilpassede planen har allerede innhold denne uka. Hente fra ${selectedClass} likevel? (Kan gi dobbeltoppføringer.)`
      : `Hente innholdet fra ${selectedClass} (uke ${getWeekNumber(weekMonday)}) inn i den tilpassede planen, som utgangspunkt?`;
    if (!await uiConfirm(msg, { title: 'Hent fra klassen', okText: 'Hent' })) return;

    setSaving();
    const result = await api('clone', { fromWeek: week, toWeek: week, classes: selectedClass, toClasses: variantCode });
    setSaved();
    if (result.entries && result.entries.length) {
      recordCreateMany(result.entries.map(en => ({ id: en.id, params: elementCreateParams(en) })), 'hentet fra klassen');
    }
    showToast(`Hentet ${result.count || 0} element(er) fra ${selectedClass}.`);
    loadData({ background: true, skipCache: true });
  } catch (err) {
    setSaveError(err.message);
  } finally {
    cloning = false;
    setCloneButtonsDisabled(false);
  }
}

// ─── Tabs ─────────────────────────────────────────────────────

function setTeacherTab(tab) {
  teacherTab = tab;
  [['hjem', 'tTabHjem', 'paneHjem'], ['ukeplan', 'tTabUkeplan', 'paneUkeplan'], ['vurd', 'tTabVurd', 'paneVurd'], ['oversikt', 'tTabOversikt', 'paneOversikt'], ['kontakt', 'tTabKontakt', 'paneKontakt']]
    .forEach(([t, btnId, paneId]) => {
      const btn = document.getElementById(btnId);
      btn.classList.toggle('active', t === tab);
      btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      document.getElementById(paneId).hidden = t !== tab;
    });
  document.getElementById('toolbar').style.display = tab === 'ukeplan' ? '' : 'none';
  // visibility (not display) so the controls-row keeps a constant size across tabs
  document.querySelector('.week-nav').style.visibility = tab === 'vurd' ? 'hidden' : 'visible';
  if (tab === 'hjem') { loadHjem(); startHjemPoll(); return; }   // keys off classesTaught, not selectedClass
  stopHjemPoll();
  if (tab === 'kontakt') { loadKontakt(); return; }   // keys off kontaktClasses
  if (!selectedClass) return;
  if (tab === 'vurd') renderVurd();
  else if (tab === 'oversikt') {
    // Progresjon (now the default) shows one class – default it to the open class.
    if (oversiktMode === 'prog' && CLASSES.includes(selectedClass)) document.getElementById('oversiktClass').value = selectedClass;
    refreshOversikt();
  }
  else render();
}

function setOversiktMode(mode) {
  oversiktMode = mode;
  document.getElementById('ovModeCompare').classList.toggle('active', mode === 'compare');
  document.getElementById('ovModeProg').classList.toggle('active', mode === 'prog');
  document.getElementById('ovGradeField').hidden = mode !== 'compare';
  document.getElementById('ovClassField').hidden = mode !== 'prog';
  document.getElementById('ovRangeFromField').hidden = mode !== 'prog';
  document.getElementById('ovRangeToField').hidden   = mode !== 'prog';
  document.getElementById('ovExportBtn').hidden  = mode !== 'prog';
  document.getElementById('ovTemaBtn').hidden    = mode !== 'prog';
  if (mode === 'prog' && selectedClass && CLASSES.includes(selectedClass)) {
    document.getElementById('oversiktClass').value = selectedClass;
  }
  refreshOversikt();
}

function refreshOversikt() {
  if (oversiktMode === 'prog') loadAllPlan();
  else loadOversikt();
}

// Reload the right surface after a create/update/delete from the modal.
function refreshAfterChange() {
  allPlanTs = 0; // invalidate progresjon cache
  hjemWeek = null; kontaktWeek = null;   // invalidate the dashboard/kontakt snapshots
  if (teacherTab === 'oversikt') refreshOversikt();
  else if (teacherTab === 'hjem') loadHjem({ force: true });
  else if (teacherTab === 'kontakt') loadKontakt({ force: true });
  else loadData({ background: true, skipCache: true });
}

// ─── Vurderinger tab (filterable table + calendar) ────────────

function setVurdView(view) {
  vurdView = view;
  document.getElementById('vurdViewTable').classList.toggle('active', view === 'table');
  document.getElementById('vurdViewCal').classList.toggle('active', view === 'cal');
  renderVurd();
}

function onVurdDateChange() {
  const startEl = document.getElementById('vfStart');
  const endEl   = document.getElementById('vfEnd');
  let start = startEl.value, end = endEl.value;
  if (start && end && start > end) {           // swap if reversed
    [startEl.value, endEl.value] = [end, start];
    [start, end] = [end, start];
    showToast('Datointervallet ble byttet om.');
  }
  vfStart = start;
  vfEnd   = end;
  renderVurd();
}

// ── Filter modal (opened from the clickable table column headers) ──

function openVurdFilterModal(section) {
  renderVurd();   // make sure the modal's controls reflect the current state
  document.getElementById('vurdFilterOverlay').classList.add('open');
  document.getElementById('vurdFilterModal').classList.add('open');
  document.body.classList.add('scroll-locked');
  if (section) {
    const el = document.querySelector('#vurdFilterModal [data-section="' + section + '"]');
    if (el) {
      el.classList.add('section-flash');
      setTimeout(() => el.classList.remove('section-flash'), 1100);
      el.scrollIntoView({ block: 'nearest' });
    }
  }
}

function closeVurdFilterModal() {
  document.getElementById('vurdFilterOverlay').classList.remove('open');
  document.getElementById('vurdFilterModal').classList.remove('open');
  document.body.classList.remove('scroll-locked');
}

function clearVurdFilters() {
  vfClasses = []; vfSubjects = []; vfTeachers = []; vfDesc = ''; vfStart = ''; vfEnd = '';
  renderVurd();
}

// Class filter buttons (multi-select; empty = all). Built once after login.
function buildVurdClassBtns() {
  const grid = document.getElementById('vfClassBtns');
  if (!grid) return;
  grid.innerHTML = '';
  CLASS_GRADES.forEach(group => {
    const wrap = document.createElement('div');
    wrap.className = 'class-modal-group';
    const lbl = document.createElement('span');
    lbl.className = 'class-grade-label';
    lbl.textContent = group.label;
    wrap.appendChild(lbl);
    group.classes.forEach(cls => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'class-modal-btn';
      btn.textContent = cls;
      btn.dataset.cls = cls;
      btn.addEventListener('click', () => {
        if (vfClasses.includes(cls)) vfClasses = vfClasses.filter(c => c !== cls);
        else vfClasses.push(cls);
        renderVurd();
      });
      wrap.appendChild(btn);
    });
    grid.appendChild(wrap);
  });
}

// Subject / teacher filter chips (multi-select; empty = all). Rebuilt from the
// values actually present in the loaded assessments so the lists stay short.
function buildVurdChips(rowId, getValue, selected, setSelected, emptyText) {
  const row = document.getElementById(rowId);
  if (!row) return;
  row.innerHTML = '';
  const present = [...new Set(vurdData.map(v => (getValue(v) || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'no'));
  // Drop any selected values that no longer exist in the data.
  setSelected(selected().filter(s => present.includes(s)));
  if (!present.length) {
    const note = document.createElement('span');
    note.className = 'vf-empty';
    note.textContent = emptyText;
    row.appendChild(note);
    return;
  }
  present.forEach(val => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vf-chip' + (selected().includes(val) ? ' active' : '');
    btn.textContent = val;
    btn.addEventListener('click', () => {
      const cur = selected();
      setSelected(cur.includes(val) ? cur.filter(s => s !== val) : cur.concat(val));
      renderVurd();
    });
    row.appendChild(btn);
  });
}

// Which filter categories are active (used for header markers + summary).
function vurdActiveFilters() {
  return {
    dato:        !!(vfStart || vfEnd),
    klasse:      vfClasses.length  > 0,
    fag:         vfSubjects.length > 0,
    beskrivelse: !!vfDesc.trim(),
    laerer:      vfTeachers.length > 0,
  };
}

// Apply the active class / subject / teacher / description / date filters.
function getVurdFiltered() {
  const needle = vfDesc.trim().toLowerCase();
  return vurdData.filter(v => {
    if (!v.date) return false;
    if (vfClasses.length  && !vfClasses.some(c => classMatches(v.classes, c)))    return false;
    if (vfSubjects.length && !vfSubjects.includes((v.subject || '').trim()))       return false;
    if (vfTeachers.length && !vfTeachers.includes((v.teacher || '').trim()))       return false;
    if (needle && !(v.description || v.notes || '').toLowerCase().includes(needle)) return false;
    if (vfStart && v.date < vfStart) return false;
    if (vfEnd   && v.date > vfEnd)   return false;
    return true;
  });
}

// Sync the filter controls + indicators, then render the active view.
function renderVurd() {
  buildVurdChips('vfSubjectBtns', v => v.subject, () => vfSubjects, s => { vfSubjects = s; }, 'Ingen fag ennå');
  buildVurdChips('vfTeacherBtns', v => v.teacher, () => vfTeachers, s => { vfTeachers = s; }, 'Ingen lærernavn ennå');
  document.querySelectorAll('#vfClassBtns .class-modal-btn')
    .forEach(b => b.classList.toggle('active', vfClasses.includes(b.dataset.cls)));
  document.getElementById('vfStart').value = vfStart;
  document.getElementById('vfEnd').value   = vfEnd;
  document.getElementById('vfDesc').value  = vfDesc;
  updateVurdFilterIndicators();

  const tableWrap = document.getElementById('vurdTableWrap');
  const calWrap   = document.getElementById('vurdCalWrap');
  tableWrap.hidden = vurdView !== 'table';
  calWrap.hidden   = vurdView !== 'cal';
  if (vurdView === 'table') renderVurdTable();
  else                      renderVurdCalendar();
}

// Filter button badge + summary line (header markers are set in renderVurdTable).
function updateVurdFilterIndicators() {
  const active = vurdActiveFilters();
  const count  = Object.values(active).filter(Boolean).length;
  const badge  = document.getElementById('vurdFilterCount');
  badge.hidden = count === 0;
  badge.textContent = count;
  document.getElementById('vurdFilterBtn').classList.toggle('has-filters', count > 0);

  const parts = [];
  if (active.dato)        parts.push('Dato: ' + (vfStart ? formatShortDate(vfStart) : '…') + '–' + (vfEnd ? formatShortDate(vfEnd) : '…'));
  if (active.klasse)      parts.push('Klasse: ' + vfClasses.join(', '));
  if (active.fag)         parts.push('Fag: ' + vfSubjects.join(', '));
  if (active.beskrivelse) parts.push('Beskrivelse: «' + vfDesc.trim() + '»');
  if (active.laerer)      parts.push('Lærer: ' + vfTeachers.join(', '));
  const summary = document.getElementById('vurdFilterSummary');
  summary.textContent = parts.length ? 'Filtre · ' + parts.join('   ·   ') : '';
  summary.hidden = parts.length === 0;
}

const VURD_COLS = [
  { label: 'Dato',        section: 'dato' },
  { label: 'Uke',         section: 'dato' },
  { label: 'Klasse(r)',   section: 'klasse' },
  { label: 'Fag',         section: 'fag' },
  { label: 'Beskrivelse', section: 'beskrivelse' },
  { label: 'Lærer',       section: 'laerer' },
  { label: '',            section: null },
];

function renderVurdTable() {
  const wrap = document.getElementById('vurdTableWrap');
  wrap.innerHTML = '';
  const items  = getVurdFiltered().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const active = vurdActiveFilters();

  const div = document.createElement('div');
  div.className = 'board-wrap';
  const table = document.createElement('table');
  table.className = 'vurd-table';
  const thead = table.createTHead();
  const hr = thead.insertRow();
  VURD_COLS.forEach(col => {
    const th = document.createElement('th');
    if (col.section) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'th-filter-btn';
      btn.title = 'Filtrer på ' + col.label;
      btn.textContent = col.label;
      const caret = document.createElement('span');
      caret.className = 'th-caret';
      caret.setAttribute('aria-hidden', 'true');
      caret.textContent = active[col.section] ? ' ●' : ' ▾';
      btn.appendChild(caret);
      btn.addEventListener('click', () => openVurdFilterModal(col.section));
      th.appendChild(btn);
      if (active[col.section]) th.classList.add('th-filtered');
    } else {
      th.textContent = col.label;
    }
    hr.appendChild(th);
  });

  const tbody = table.createTBody();
  if (!items.length) {
    const tr = tbody.insertRow();
    const td = tr.insertCell();
    td.colSpan = VURD_COLS.length;
    td.className = 'empty-cell';
    td.textContent = active && Object.values(active).some(Boolean)
      ? 'Ingen vurderinger som passer filteret.'
      : 'Ingen vurderinger ennå.';
  } else {
    items.forEach(v => {
      const tr = tbody.insertRow();
      tr.insertCell().textContent = formatShortDate(v.date);
      tr.insertCell().textContent = v.date ? getWeekNumber(isoToDate(v.date)) : '';
      tr.insertCell().textContent = v.classes;
      tr.insertCell().textContent = v.subject || '';
      tr.insertCell().textContent = v.description || v.notes || '';
      tr.insertCell().textContent = v.teacher || '';
      const actions = tr.insertCell();
      if (v.id) {
        const edit = document.createElement('button');
        edit.className = 'link-btn'; edit.type = 'button'; edit.textContent = 'Rediger';
        edit.addEventListener('click', () => openVurdEdit(v));
        actions.appendChild(edit);
      } else {
        actions.textContent = 'Gammelt system';
        actions.className = 'muted';
      }
    });
  }
  div.appendChild(table);
  wrap.appendChild(div);
}

// Calendar view – month cards with a dot per assessment; clicking a day shows
// that day's assessments (editable) in a detail box at the top.
function renderVurdCalendar() {
  const root = document.getElementById('vurdCalWrap');
  root.innerHTML = '';

  const detail = document.createElement('div');
  detail.id = 'vurdDayDetail';
  detail.className = 'vurd-detail';
  root.appendChild(detail);

  const today = new Date();
  const start = vfStart ? isoToDate(vfStart) : today;
  const end   = vfEnd   ? isoToDate(vfEnd)
                        : new Date(today.getFullYear(), today.getMonth() + 2, today.getDate());

  const byDate = {};
  getVurdFiltered().forEach(v => { (byDate[v.date] = byDate[v.date] || []).push(v); });

  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);
  if (cursor > endMonth) { // reversed/empty range guard
    root.appendChild(buildVurdMonthCard(new Date(today.getFullYear(), today.getMonth(), 1), byDate));
    return;
  }
  while (cursor <= endMonth) {
    root.appendChild(buildVurdMonthCard(cursor, byDate));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
}

function buildVurdMonthCard(monthDate, byDate, opts = {}) {
  const scopeSel = opts.scope || '#vurdCalWrap';           // where to clear the selected cell
  const onDay = opts.onDay || showVurdDayDetail;           // day-click handler (target detail box)
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const card = document.createElement('section');
  card.className = 'month-card';

  const title = document.createElement('h2');
  title.className = 'month-title';
  title.textContent = capitalizeFirst(monthDate.toLocaleString('no', { month: 'long', year: 'numeric' }));
  card.appendChild(title);

  const table = document.createElement('table');
  table.className = 'cal-table';
  const thead = table.createTHead();
  const hr = thead.insertRow();
  ['Uke', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'].forEach(l => {
    const th = document.createElement('th'); th.textContent = l; hr.appendChild(th);
  });
  const tbody = table.createTBody();
  const todayISO = toISODate(new Date());

  let cursor = new Date(year, month, 1);
  const startDow = cursor.getDay() || 7;
  cursor.setDate(cursor.getDate() - startDow + 1);
  const lastDay = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((lastDay + startDow - 1) / 7);

  for (let w = 0; w < weeks; w++) {
    const tr = tbody.insertRow();
    const wk = document.createElement('td');
    wk.className = 'week-num';
    wk.textContent = getWeekNumber(cursor);
    tr.appendChild(wk);

    for (let d = 0; d < 7; d++) {
      const td = document.createElement('td');
      const iso = toISODate(cursor);
      if (cursor.getMonth() === month) {
        td.className = 'day';
        if (d >= 5) td.classList.add('weekend');
        if (iso === todayISO) td.classList.add('today');
        const sch = schoolDays[iso];
        if (sch) {
          td.classList.add('school-' + sch.type);
          td.title = sch.summaries.join(', ');
          if (sch.type === 'planning') {
            const badge = document.createElement('span');
            badge.className = 'cal-badge';
            badge.textContent = 'P';
            td.appendChild(badge);
          }
        }

        const num = document.createElement('span');
        num.className = 'day-num';
        num.textContent = cursor.getDate();
        td.appendChild(num);

        const items = byDate[iso] || [];
        if (items.length) {
          td.classList.add('has-assessments');
          const dots = document.createElement('span');
          dots.className = 'dots';
          for (let i = 0; i < Math.min(items.length, 4); i++) {
            const dot = document.createElement('span'); dot.className = 'dot'; dots.appendChild(dot);
          }
          td.appendChild(dots);
        }

        // Every in-month day is clickable so teachers can add for empty days too.
        const snap = new Date(cursor);
        const snapItems = items.slice();
        const cell = td;
        td.tabIndex = 0;
        td.setAttribute('role', 'button');
        const openDay = () => {
          document.querySelectorAll(scopeSel + ' .cal-table td.selected').forEach(c => c.classList.remove('selected'));
          cell.classList.add('selected');
          onDay(snap, snapItems);
        };
        td.addEventListener('click', openDay);
        td.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDay(); } });
      } else {
        td.className = 'day other-month';
        td.textContent = cursor.getDate();
      }
      tr.appendChild(td);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  card.appendChild(table);
  return card;
}

function showVurdDayDetail(date, items) {
  const box = document.getElementById('vurdDayDetail');
  if (!box) return;
  box.innerHTML = '';
  const iso = toISODate(date);

  const h = document.createElement('h3');
  h.className = 'vurd-detail-title';
  h.textContent = formatDateLong(date);
  box.appendChild(h);

  const sch = schoolDays[iso];
  if (sch) {
    const note = document.createElement('p');
    note.className = 'school-day-summary';
    note.textContent = sch.summaries.join(', ');
    box.appendChild(note);
  }

  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'panel-empty';
    p.textContent = 'Ingen vurderinger denne dagen.';
    box.appendChild(p);
  }

  items.sort((a, b) => (a.subject || '').localeCompare(b.subject || '', 'no')).forEach(v => {
    const card = document.createElement('div');
    card.className = 'assessment-card vurd-detail-card';
    const head = document.createElement('div');
    head.className = 'vurd-detail-card-head';
    const meta = document.createElement('span');
    meta.className = 'vurd-detail-meta';
    meta.textContent = (v.classes || '') + (v.subject ? ' · ' + v.subject : '');
    head.appendChild(meta);
    if (v.id) {
      const edit = document.createElement('button');
      edit.className = 'link-btn'; edit.type = 'button'; edit.textContent = 'Rediger';
      edit.addEventListener('click', () => openVurdEdit(v));
      head.appendChild(edit);
    } else {
      const badge = document.createElement('span');
      badge.className = 'muted'; badge.textContent = 'Gammelt system';
      head.appendChild(badge);
    }
    card.appendChild(head);
    const desc = document.createElement('p');
    desc.className = 'vurd-detail-desc';
    desc.textContent = v.description || v.notes || '';
    card.appendChild(desc);
    if (v.teacher) {
      const who = document.createElement('p');
      who.className = 'vurd-detail-teacher';
      who.textContent = 'Lagt inn av ' + v.teacher;
      card.appendChild(who);
    }
    box.appendChild(card);
  });

  const add = document.createElement('button');
  add.className = 'btn btn-primary btn-tiny vurd-detail-add';
  add.type = 'button';
  add.textContent = '+ Legg til for denne datoen';
  add.addEventListener('click', () => openAddModal({ type: 'vurdering', date: iso, weekFrom: mondayOf(date) }));
  box.appendChild(add);

  box.classList.add('active');
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function capitalizeFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function formatDateLong(date) {
  return capitalizeFirst(date.toLocaleDateString('no', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
}

// Conflict panel inside the add/edit modal (only for vurderinger).
function refreshConflicts() {
  const panel = document.getElementById('conflictPanel');
  if (!panel) return;
  if (modalType !== 'vurdering') { panel.hidden = true; panel.innerHTML = ''; return; }
  const date = document.getElementById('dateInput').value;
  if (!date || !modalClasses.length) { panel.hidden = true; panel.innerHTML = ''; return; }

  const center = isoToDate(date);
  const from = addDays(center, -7), to = addDays(center, 7);
  const hits = vurdData.filter(v => {
    if (!v.date) return false;
    if (editingVurd && v.id && v.id === editingVurd.id) return false;
    const d = isoToDate(v.date);
    if (d < from || d > to) return false;
    return modalClasses.some(c => classMatches(v.classes, c));
  }).sort((a, b) => (a.date < b.date ? -1 : 1));

  panel.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'conflict-title';
  h.textContent = hits.length ? ('⚠ ' + hits.length + ' vurdering' + (hits.length > 1 ? 'er' : '') + ' ±7 dager') : 'Ingen vurderinger i nærheten ✓';
  panel.appendChild(h);
  hits.forEach(v => {
    const row = document.createElement('div');
    row.className = 'conflict-row';
    row.textContent = formatShortDate(v.date) + ' · ' + v.classes + ' · ' + (v.subject || '') + (v.description ? ' – ' + richToText(v.description) : '');
    panel.appendChild(row);
  });
  panel.classList.toggle('has-hits', hits.length > 0);
  panel.hidden = false;
}

// ─── Hjem (dashboard) tab ─────────────────────────────────────
// A profile-driven landing: per-class cards with a per-subject checklist for the
// week — each subject taught in that class shows its status: a prominent "Fyll
// inn tema" button, a "✓ tema" tag, and a secondary "+ lekser" button. Subjects
// are those taught IN the class (the matrix); accounts predating the matrix fall
// back to all Mine-fag.

async function loadHjem(opts = {}) {
  const week = dateToWeek(weekMonday);
  loadAssessments(opts.force ? { force: true } : {});   // TTL-cheap; forced on explicit refreshes
  if (!opts.force && hjemWeek === week) { renderHjem(); return; }
  showBgLoading();
  try {
    const res = await fetch(`${SCRIPT_URL}?action=week&week=${encodeURIComponent(week)}`);
    const data = await res.json();
    hjemData = Array.isArray(data) ? data : [];
    hjemWeek = week;
  } catch (err) { /* keep any stale data; still render below */ }
  hideBgLoading();
  if (teacherTab === 'hjem') renderHjem();
}

// ── Live-ish refresh while sitting on the dashboard ───────────
// Poll every 30s, but ONLY while the Hjem tab is open AND the browser tab is
// visible (never polls a backgrounded tab); silent (no spinner) and re-renders
// only when the data actually changed. Returning to the tab refreshes at once.
let hjemPollTimer = null;
const HJEM_POLL_MS = 30000;
async function pollHjem() {
  if (teacherTab !== 'hjem' || document.hidden || !loggedIn) return;
  const week = dateToWeek(weekMonday);
  try {
    const res = await fetch(`${SCRIPT_URL}?action=week&week=${encodeURIComponent(week)}`);
    const data = await res.json();
    if (Array.isArray(data)) {
      const changed = JSON.stringify(data) !== JSON.stringify(hjemData);
      hjemData = data; hjemWeek = week;
      if (changed && teacherTab === 'hjem') renderHjem();
    }
  } catch { /* transient – try again next tick */ }
  // vurderinger aren't polled (change rarely); they refresh on their TTL, on tab
  // entry, and on the visibility-regain force below.
}
function startHjemPoll() { stopHjemPoll(); hjemPollTimer = setInterval(pollHjem, HJEM_POLL_MS); }
function stopHjemPoll() { if (hjemPollTimer) { clearInterval(hjemPollTimer); hjemPollTimer = null; } }

// Classes the teacher teaches; pinned first, grade order within each group.
function hjemClasses() { return orderedClasses(CLASSES.filter(c => classesTaught.includes(c))); }

// CORE subjects to check for a class: those taught IN it (matrix). Electives are
// pulled out into their own per-year card. Legacy accounts (no matrix) fall back
// to all Mine-fag core subjects.
function hjemSubjectsFor(cls) {
  const ordered = orderedSubjects(mySubjects()).filter(s => CORE_SUBJECTS.includes(s));
  if (!Object.keys(subjectClasses).length) return ordered;              // legacy fallback
  return ordered.filter(s => classesForSubject(s).includes(cls));
}

// Build a status object from a subject list + a has(subject,type) predicate:
// pinned subjects first, then most-incomplete first (needs tema → lekser → done).
function hjemStatusFrom(subs, has) {
  const rows = subs.map(s => ({ subject: s, tema: has(s, 'læringsmål'), lekse: has(s, 'lekse') }));
  const pins = pinnedSubjects();
  const score = r => (r.tema ? (r.lekse ? 0 : 1) : 2);
  rows.sort((a, b) => {
    const pa = pins.includes(a.subject), pb = pins.includes(b.subject);
    if (pa !== pb) return pa ? -1 : 1;       // pinned subjects float to the top
    return score(b) - score(a);
  });
  return {
    rows,
    total: subs.length,
    temaDone: rows.filter(r => r.tema).length,
    allDone: subs.length > 0 && rows.every(r => r.tema && r.lekse),
  };
}
function hjemClassStatus(cls) {
  return hjemStatusFrom(hjemSubjectsFor(cls),
    (s, t) => hjemData.some(p => p.type === t && p.subject === s && p.description && classMatches(p.classes, cls)));
}

// Electives are a year-level unit → grouped once per grade-year, not per class.
function hjemElectiveSubjects() {
  return orderedSubjects(mySubjects()).filter(s => isElective(s) && classesForSubject(s).length);
}
function hjemElectiveYears() {
  const els = hjemElectiveSubjects();
  return CLASS_GRADES.filter(g => els.some(s => g.classes.some(c => classesForSubject(s).includes(c))));
}
function hjemElectiveStatus(group) {
  const subs = hjemElectiveSubjects().filter(s => group.classes.some(c => classesForSubject(s).includes(c)));
  return hjemStatusFrom(subs,
    (s, t) => hjemData.some(p => p.type === t && p.subject === s && p.description && group.classes.some(c => classMatches(p.classes, c))));
}

function hjemClassVurd(cls, week) {
  return vurdData.filter(v => v.date && dateToWeek(new Date(v.date)) === week && classMatches(v.classes, cls));
}

function renderHjem() {
  const pane = document.getElementById('paneHjem');
  if (!pane) return;
  pane.innerHTML = '';
  const week = dateToWeek(weekMonday);
  const thisWeek = week === dateToWeek(mondayOf(new Date()));

  const header = document.createElement('div');
  header.className = 'hjem-header';
  const h = document.createElement('h2');
  h.className = 'hjem-greeting';
  h.textContent = 'Hei' + (teacherName ? ', ' + teacherName : '') + '!';
  const wk = document.createElement('p');
  wk.className = 'hjem-week';
  wk.textContent = 'Uke ' + getWeekNumber(weekMonday) + (thisWeek ? ' – denne uka' : '');
  header.appendChild(h); header.appendChild(wk);
  pane.appendChild(header);

  const my = mySubjects();
  const classes = hjemClasses();
  if (!my.length || !classes.length) {
    const card = document.createElement('div');
    card.className = 'hjem-card hjem-setup';
    const p = document.createElement('p');
    p.className = 'hjem-setup-text';
    p.textContent = (!my.length && !classes.length)
      ? 'Sett opp fagene og klassene dine, så viser vi deg hva som gjenstår hver uke.'
      : (!my.length ? 'Legg til fagene dine, så viser vi deg hva som gjenstår.'
                    : 'Legg til klassene dine, så viser vi deg hva som gjenstår.');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn btn-primary';
    btn.textContent = 'Sett opp profilen';
    btn.addEventListener('click', () => showOnboarding());
    card.appendChild(p); card.appendChild(btn);
    pane.appendChild(card);
    return;
  }

  // Legacy nudge: has classes but no per-subject matrix → tallies over-report.
  if (!Object.keys(subjectClasses).length) {
    const nudge = document.createElement('button');
    nudge.type = 'button'; nudge.className = 'hjem-nudge';
    nudge.textContent = 'Forbedre: sett hvilke fag du har i hver klasse →';
    nudge.addEventListener('click', () => openProfileModal());
    pane.appendChild(nudge);
  }

  const grid = document.createElement('div');
  grid.className = 'hjem-grid';
  classes.forEach(cls => grid.appendChild(buildHjemCard(cls, week)));
  hjemElectiveYears().forEach(g => grid.appendChild(buildValgfagCard(g, week)));   // electives once per year
  pane.appendChild(grid);
}

// Progress bar ("X av Y fag har tema").
function buildHjemProgress(temaDone, total) {
  const prog = document.createElement('div');
  prog.className = 'hjem-progress';
  const label = document.createElement('span');
  label.className = 'hjem-progress-label';
  label.textContent = temaDone + ' av ' + total + ' fag har tema';
  const bar = document.createElement('div');
  bar.className = 'hjem-bar';
  const fill = document.createElement('div');
  fill.className = 'hjem-bar-fill';
  fill.style.width = (total ? Math.round(temaDone / total * 100) : 0) + '%';
  bar.appendChild(fill);
  prog.appendChild(label); prog.appendChild(bar);
  return prog;
}
function hjemAllClear() {
  const done = document.createElement('p');
  done.className = 'hjem-allclear';
  done.textContent = '✓ Alt klart denne uka';
  return done;
}
// The per-subject checklist (class cards + the valgfag card). `gotoClass` is the
// class the fill-buttons deep-link to (a representative year class for valgfag,
// where the write is year-scoped). Each row carries a subject-pin toggle.
function buildHjemChecklist(rows, gotoClass) {
  const list = document.createElement('div');
  list.className = 'hjem-checklist';
  rows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'hjem-subj';
    const sPinned = pinnedSubjects().includes(r.subject);
    const spin = document.createElement('button');
    spin.type = 'button';
    spin.className = 'hjem-pin hjem-pin-sm' + (sPinned ? ' pinned' : '');
    spin.textContent = '📌';
    spin.title = sPinned ? 'Festet øverst i kortet – klikk for å løsne' : 'Fest faget øverst i kortet';
    spin.setAttribute('aria-label', spin.title);
    spin.addEventListener('click', () => toggleSubjectPin(r.subject));
    const nm = document.createElement('span');
    nm.className = 'hjem-subj-name' + (r.tema ? ' is-done' : '');
    nm.textContent = r.subject;
    const status = document.createElement('div');
    status.className = 'hjem-subj-status';
    if (!r.tema) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'hjem-task hjem-task-tema';
      b.textContent = 'Fyll inn tema';
      b.addEventListener('click', () => hjemGoto(gotoClass, r.subject, 'læringsmål'));
      status.appendChild(b);
    } else {
      const tag = document.createElement('span');
      tag.className = 'hjem-done-tag';
      tag.textContent = '✓ tema';
      status.appendChild(tag);
      if (!r.lekse) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'hjem-task hjem-task-lekse';
        b.textContent = '+ lekser';
        b.addEventListener('click', () => hjemGoto(gotoClass, r.subject, 'lekse'));
        status.appendChild(b);
      }
    }
    row.appendChild(spin); row.appendChild(nm); row.appendChild(status);
    list.appendChild(row);
  });
  return list;
}

function buildHjemCard(cls, week) {
  const card = document.createElement('div');
  card.className = 'hjem-card';

  const head = document.createElement('div');
  head.className = 'hjem-card-head';
  const name = document.createElement('span');
  name.className = 'hjem-card-class';
  name.textContent = cls;
  head.appendChild(name);
  if (kontaktClasses.includes(cls)) {
    const star = document.createElement('span');
    star.className = 'hjem-kontakt';
    star.textContent = '★ kontaktlærer';
    head.appendChild(star);
  }
  const cPinned = pinnedClasses().includes(cls);
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'hjem-pin' + (cPinned ? ' pinned' : '');
  pin.textContent = '📌';
  pin.title = cPinned ? 'Festet øverst – klikk for å løsne' : 'Fest klassen øverst';
  pin.setAttribute('aria-label', pin.title);
  pin.addEventListener('click', () => toggleClassPin(cls));
  head.appendChild(pin);
  card.appendChild(head);

  const st = hjemClassStatus(cls);
  card.appendChild(buildHjemProgress(st.temaDone, st.total));
  card.appendChild(st.allDone ? hjemAllClear() : buildHjemChecklist(st.rows, cls));

  const vs = hjemClassVurd(cls, week);
  if (vs.length) {
    const vwrap = document.createElement('div');
    vwrap.className = 'hjem-vurd';
    vs.slice(0, 3).forEach(v => {
      const line = document.createElement('div');
      line.className = 'hjem-vurd-line';
      const when = capitalizeFirst(new Date(v.date).toLocaleDateString('no', { weekday: 'short', day: 'numeric', month: 'short' }));
      line.textContent = '📋 ' + (v.subject ? v.subject + ': ' : '') + (v.description || 'Vurdering') + ' – ' + when;
      vwrap.appendChild(line);
    });
    card.appendChild(vwrap);
  }

  return card;
}

// Electives shown once per grade-year (a year-level unit). Fill-buttons deep-link
// to the year's first class board, where the write is year-scoped (classes=year).
function buildValgfagCard(group, week) {
  const card = document.createElement('div');
  card.className = 'hjem-card hjem-valgfag';
  const head = document.createElement('div');
  head.className = 'hjem-card-head';
  const name = document.createElement('span');
  name.className = 'hjem-card-class';
  name.textContent = 'Valgfag · ' + group.label + ' trinn';
  head.appendChild(name);
  card.appendChild(head);

  const st = hjemElectiveStatus(group);
  card.appendChild(buildHjemProgress(st.temaDone, st.total));
  card.appendChild(st.allDone ? hjemAllClear() : buildHjemChecklist(st.rows, group.classes[0]));
  return card;
}

// Deep-link from a dashboard action to that class's board cell (best effort).
function hjemGoto(cls, subject, type) {
  if (cls !== selectedClass || variantCode) {
    selectedClass = cls;
    variantCode = null;
    localStorage.setItem(CLASS_KEY, cls);
    localStorage.removeItem(VARIANT_KEY);
    saveProfileToServer();
    planData = [];
    updateClassLabel();
  }
  setTeacherTab('ukeplan');
  loadData();
  setTimeout(() => {
    let row = null;
    document.querySelectorAll('#board tr[data-subject]').forEach(r => { if (r.dataset.subject === subject) row = r; });
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    let field = null;
    row.querySelectorAll('.rich-field').forEach(f => { if (f.dataset.type === type) field = f; });
    (field || row.querySelector('.rich-field'))?.focus();
  }, 350);
}

// ─── Kontaktlærer tab (class-workload overview for the team) ──
// Shown only if the teacher is kontaktlærer for ≥1 class. Per selected class:
// the team + fag→lærer staffing (class_team), the class's assessment load/
// calendar (all subjects), and this week's tema/lekse coverage attributed to each
// teacher. Roster/coverage are only as complete as staff have registered.
const KONTAKT_LOAD_FLAG = 3;   // ≥ this many vurderinger in a week = flagged

async function loadKontakt(opts = {}) {
  const mine = CLASSES.filter(c => kontaktClasses.includes(c));
  if (!mine.length) { renderKontakt(); return; }
  if (!kontaktViewClass || !mine.includes(kontaktViewClass)) kontaktViewClass = mine[0];
  const cls = kontaktViewClass;
  const week = dateToWeek(weekMonday);
  loadAssessments(opts.force ? { force: true } : {});
  showBgLoading();
  try {
    const reqs = [fetch(`${SCRIPT_URL}?action=class_team&class=${encodeURIComponent(cls)}`, { credentials: 'include' })];
    const needWeek = opts.force || kontaktWeek !== week;
    if (needWeek) reqs.push(fetch(`${SCRIPT_URL}?action=week&week=${encodeURIComponent(week)}`));
    const res = await Promise.all(reqs);
    const team = await res[0].json();
    kontaktTeam = (team && !team.error) ? team : { class: cls, kontakt: [], subjects: {} };
    if (needWeek) { const wd = await res[1].json(); kontaktWeekData = Array.isArray(wd) ? wd : []; kontaktWeek = week; }
  } catch { kontaktTeam = kontaktTeam || { class: cls, kontakt: [], subjects: {} }; }
  hideBgLoading();
  if (teacherTab === 'kontakt') renderKontakt();
}

function renderKontakt() {
  const pane = document.getElementById('paneKontakt');
  if (!pane) return;
  pane.innerHTML = '';
  const mine = CLASSES.filter(c => kontaktClasses.includes(c));
  if (!mine.length) { return; }   // tab shouldn't be visible, but guard anyway
  const cls = kontaktViewClass && mine.includes(kontaktViewClass) ? kontaktViewClass : mine[0];
  const team = (kontaktTeam && kontaktTeam.class === cls) ? kontaktTeam : { kontakt: [], subjects: {} };

  // Header + class switcher
  const head = document.createElement('div');
  head.className = 'kontakt-head';
  const h = document.createElement('h2');
  h.className = 'kontakt-title';
  h.textContent = 'Kontaktlærer – ' + cls;
  head.appendChild(h);
  if (mine.length > 1) {
    const sw = document.createElement('div');
    sw.className = 'kontakt-switch';
    mine.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kontakt-switch-btn' + (c === cls ? ' active' : '');
      b.textContent = c;
      b.addEventListener('click', () => { kontaktViewClass = c; loadKontakt(); });
      sw.appendChild(b);
    });
    head.appendChild(sw);
  }
  pane.appendChild(head);

  const note = document.createElement('p');
  note.className = 'kontakt-note';
  note.textContent = 'Oversikten er basert på det lærerne har registrert (fag, klasser og innhold).';
  pane.appendChild(note);

  // A · Klasseteam
  const secA = kontaktSection('Klasseteam');
  const kont = document.createElement('p');
  kont.className = 'kontakt-line';
  kont.innerHTML = '';
  kont.append('Kontaktlærere: ');
  const kk = (team.kontakt || []).map(t => t.name);
  const strong = document.createElement('strong');
  strong.textContent = kk.length ? kk.join(', ') : 'ingen registrert';
  kont.appendChild(strong);
  secA.appendChild(kont);
  const subjKeys = Object.keys(team.subjects || {}).sort((a, b) => a.localeCompare(b, 'no'));
  if (subjKeys.length) {
    const list = document.createElement('div');
    list.className = 'kontakt-staff';
    subjKeys.forEach(s => {
      const row = document.createElement('div');
      row.className = 'kontakt-staff-row';
      const sn = document.createElement('span'); sn.className = 'kontakt-staff-subj'; sn.textContent = s;
      const tn = document.createElement('span'); tn.className = 'kontakt-staff-teacher'; tn.textContent = team.subjects[s].join(', ');
      row.appendChild(sn); row.appendChild(tn);
      list.appendChild(row);
    });
    secA.appendChild(list);
  } else {
    const p = document.createElement('p'); p.className = 'kontakt-empty';
    p.textContent = 'Ingen lærere har registrert fag i denne klassen ennå.';
    secA.appendChild(p);
  }
  pane.appendChild(secA);

  // B · Vurderingsbelastning
  const secB = kontaktSection('Vurderingsbelastning');
  const classVurd = vurdData.filter(v => v.date && classMatches(v.classes, cls));
  // Flagged weeks (from today forward) with too many assessments.
  const byWeek = {};
  const todayW = dateToWeek(mondayOf(new Date()));
  classVurd.forEach(v => { const w = dateToWeek(isoToDate(v.date)); if (w >= todayW) byWeek[w] = (byWeek[w] || 0) + 1; });
  const flagged = Object.keys(byWeek).filter(w => byWeek[w] >= KONTAKT_LOAD_FLAG).sort();
  if (flagged.length) {
    const warn = document.createElement('div');
    warn.className = 'kontakt-flags';
    flagged.forEach(w => {
      const line = document.createElement('p');
      line.className = 'kontakt-flag';
      line.textContent = '⚠ Uke ' + w.slice(6) + ': ' + byWeek[w] + ' vurderinger – vurder å spre dem.';
      warn.appendChild(line);
    });
    secB.appendChild(warn);
  } else {
    const ok = document.createElement('p'); ok.className = 'kontakt-empty';
    ok.textContent = classVurd.length ? 'Ingen uker med uvanlig mange vurderinger framover.' : 'Ingen vurderinger registrert for klassen.';
    secB.appendChild(ok);
  }
  // Calendar (reuse the vurd month card, class-filtered, read-only day detail).
  const calWrap = document.createElement('div');
  calWrap.id = 'kontaktCalWrap';
  calWrap.className = 'kontakt-cal';
  const detail = document.createElement('div');
  detail.id = 'kontaktDayDetail';
  detail.className = 'vurd-detail';
  calWrap.appendChild(detail);
  const byDate = {};
  classVurd.forEach(v => { (byDate[v.date] = byDate[v.date] || []).push(v); });
  const today = new Date();
  let cursor = new Date(today.getFullYear(), today.getMonth(), 1);
  const endMonth = new Date(today.getFullYear(), today.getMonth() + 2, 1);
  const calOpts = { scope: '#kontaktCalWrap', onDay: showKontaktDayDetail };
  while (cursor <= endMonth) {
    calWrap.appendChild(buildVurdMonthCard(cursor, byDate, calOpts));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  secB.appendChild(calWrap);
  pane.appendChild(secB);

  // C · Dekning denne uka
  const secC = kontaktSection('Dekning denne uka (uke ' + getWeekNumber(weekMonday) + ')');
  const week = dateToWeek(weekMonday);
  const has = (subject, type) => kontaktWeekData.some(p => p.type === type && p.subject === subject && p.description && classMatches(p.classes, cls));
  const teacherFor = subject => (team.subjects && team.subjects[subject]) ? team.subjects[subject].join(', ') : '';
  // Subjects: registered in the class, plus any that actually have content this week.
  const withContent = [...new Set(kontaktWeekData.filter(p => p.subject && classMatches(p.classes, cls)).map(p => p.subject))];
  const subjects = [...new Set([...subjKeys, ...withContent])].sort((a, b) => a.localeCompare(b, 'no'));
  if (!subjects.length) {
    const p = document.createElement('p'); p.className = 'kontakt-empty';
    p.textContent = 'Ingen fag registrert eller planlagt for klassen denne uka.';
    secC.appendChild(p);
  } else {
    const list = document.createElement('div');
    list.className = 'kontakt-coverage';
    subjects.forEach(s => {
      const row = document.createElement('div');
      row.className = 'kontakt-cov-row';
      const left = document.createElement('span');
      left.className = 'kontakt-cov-subj';
      const who = teacherFor(s);
      left.textContent = s + (who ? ' (' + who + ')' : ' (ukjent lærer)');
      const right = document.createElement('span');
      right.className = 'kontakt-cov-status';
      const tema = has(s, 'læringsmål');
      const lekse = has(s, 'lekse');
      if (tema) {
        const t = document.createElement('span'); t.className = 'kontakt-cov-ok'; t.textContent = '✓ tema';
        right.appendChild(t);
        if (!lekse) { const l = document.createElement('span'); l.className = 'kontakt-cov-warn'; l.textContent = 'mangler lekser'; right.appendChild(l); }
      } else {
        const m = document.createElement('span'); m.className = 'kontakt-cov-miss'; m.textContent = 'mangler tema';
        right.appendChild(m);
      }
      row.appendChild(left); row.appendChild(right);
      list.appendChild(row);
    });
    secC.appendChild(list);
  }
  pane.appendChild(secC);

  // D · Beskjeder og praktisk info (this week, read-only, attributed)
  const secD = kontaktSection('Beskjeder og praktisk info (uke ' + getWeekNumber(weekMonday) + ')');
  const general = kontaktWeekData.filter(p => GENERAL_TYPES.includes(p.type) && p.description && classMatches(p.classes, cls));
  if (!general.length) {
    const p = document.createElement('p'); p.className = 'kontakt-empty';
    p.textContent = 'Ingen beskjeder for klassen denne uka.';
    secD.appendChild(p);
  } else {
    GENERAL_TYPES.forEach(type => {
      const items = general.filter(p => p.type === type);
      if (!items.length) return;
      const box = document.createElement('div');
      box.className = 'general-card banner-' + type;
      const meta = document.createElement('div');
      meta.className = 'general-meta';
      const icon = document.createElement('span'); icon.textContent = GENERAL_ICON[type] || '📌'; meta.appendChild(icon);
      const badge = document.createElement('span'); badge.className = 'general-badge'; badge.textContent = TYPE_LABEL[type]; meta.appendChild(badge);
      box.appendChild(meta);
      const list = document.createElement('div'); list.className = 'general-list';
      items.forEach(el => list.appendChild(buildGeneralLine(el, { readonly: true, teacher: true })));
      box.appendChild(list);
      secD.appendChild(box);
    });
  }
  pane.appendChild(secD);
}

function kontaktSection(titleText) {
  const sec = document.createElement('section');
  sec.className = 'kontakt-section';
  const h = document.createElement('h3');
  h.className = 'kontakt-section-title';
  h.textContent = titleText;
  sec.appendChild(h);
  return sec;
}

// Read-only day detail for the kontaktlærer calendar (no edit/add).
function showKontaktDayDetail(date, items) {
  const box = document.getElementById('kontaktDayDetail');
  if (!box) return;
  box.innerHTML = '';
  const iso = toISODate(date);
  const h = document.createElement('h3');
  h.className = 'vurd-detail-title';
  h.textContent = formatDateLong(date);
  box.appendChild(h);
  const sch = schoolDays[iso];
  if (sch) {
    const p = document.createElement('p'); p.className = 'school-day-summary'; p.textContent = sch.summaries.join(', ');
    box.appendChild(p);
  }
  if (!items.length) {
    const p = document.createElement('p'); p.className = 'panel-empty'; p.textContent = 'Ingen vurderinger denne dagen.';
    box.appendChild(p);
  }
  items.slice().sort((a, b) => (a.subject || '').localeCompare(b.subject || '', 'no')).forEach(v => {
    const card = document.createElement('div');
    card.className = 'assessment-card vurd-detail-card';
    const meta = document.createElement('span'); meta.className = 'vurd-detail-meta';
    meta.textContent = (v.classes || '') + (v.subject ? ' · ' + v.subject : '');
    card.appendChild(meta);
    const desc = document.createElement('p'); desc.className = 'vurd-detail-desc'; desc.textContent = v.description || v.notes || '';
    card.appendChild(desc);
    if (v.teacher) { const who = document.createElement('p'); who.className = 'vurd-detail-teacher'; who.textContent = 'Lagt inn av ' + v.teacher; card.appendChild(who); }
    box.appendChild(card);
  });
  box.classList.add('active');
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── Oversikt tab (compare classes for a subject, this week) ──

async function loadOversikt() {
  const week = dateToWeek(weekMonday);
  document.getElementById('oversiktWeek').textContent = 'Uke ' + getWeekNumber(weekMonday) + ' (denne uka)';
  loadAssessments();
  showBgLoading();
  try {
    const res = await fetch(`${SCRIPT_URL}?action=week&week=${encodeURIComponent(week)}`);
    const data = await res.json();
    oversiktData = Array.isArray(data) ? data : [];
    oversiktWeek = week;
    hideBgLoading();
    renderOversikt();
  } catch (err) {
    hideBgLoading();
  }
}

function renderOversikt() {
  if (deferIfEditing()) return;
  const board = document.getElementById('oversiktBoard');
  if (!board) return;
  board.innerHTML = '';
  const subject  = document.getElementById('oversiktSubject').value;
  const gradeSel = document.getElementById('oversiktGrade').value;
  const week     = oversiktWeek || dateToWeek(weekMonday);

  let classes = CLASSES;
  if (gradeSel) { const g = CLASS_GRADES.find(x => x.label === gradeSel + '.'); classes = g ? g.classes : CLASSES; }

  const div = document.createElement('div');
  div.className = 'board-wrap';
  const table = document.createElement('table');
  table.className = 'plan-table';
  const thead = table.createTHead();
  const hr = thead.insertRow();
  ['Klasse', 'Tema og læringsmål', 'Ressurser', 'Lekser', 'Vurdering'].forEach(h => { const th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
  const tbody = table.createTBody();

  classes.forEach(cls => {
    const els     = oversiktData.filter(p => p.subject === subject && classMatches(p.classes, cls));
    const goalEls = els.filter(p => p.type === 'læringsmål' && p.description);
    const resEls  = els.filter(p => p.type === 'ressurs' && p.description);
    const hwEls   = els.filter(p => p.type === 'lekse' && p.description).slice().sort(byDay);
    const vurd    = vurdData.filter(v => v.date && dateToWeek(isoToDate(v.date)) === week && v.subject === subject && classMatches(v.classes, cls));

    const tr = tbody.insertRow();
    const c = tr.insertCell(); c.className = 'cell-subject'; c.textContent = cls;

    // Every item is click-to-edit (opens the right modal); no dead-ends.
    tr.appendChild(buildCompareCell(goalEls, false));
    tr.appendChild(buildCompareCell(resEls, false));
    tr.appendChild(buildCompareCell(hwEls, true));
    tr.appendChild(buildCompareVurdCell(vurd));
  });

  div.appendChild(table);
  board.appendChild(div);
}

// A read-but-editable cell for the compare view: each element opens the edit
// modal on click. showDay prefixes the weekday for lekser.
function buildCompareCell(elements, showDay) {
  const td = document.createElement('td');
  if (!elements.length) { td.className = 'cell-empty'; td.textContent = '–'; return td; }
  elements.forEach(el => {
    const d = document.createElement('div');
    d.className = 'rich-content ov-editable';
    const dp = showDay && daysLabel(el.day) ? '<strong>' + escapeHtml(daysLabel(el.day)) + ':</strong> ' : '';
    d.innerHTML = dp + sanitizeHtml(el.description || '');
    d.title = 'Klikk for å redigere';
    d.addEventListener('click', () => openElementEdit(el));
    td.appendChild(d);
  });
  return td;
}
function buildCompareVurdCell(vurd) {
  const td = document.createElement('td');
  td.className = 'cell-vurd';
  if (!vurd.length) { td.classList.add('cell-empty'); td.textContent = '–'; return td; }
  vurd.forEach(v => {
    const vd = dayOf(isoToDate(v.date));
    const s = document.createElement('div');
    s.className = 'ov-editable' + (v.id ? '' : ' legacy');
    s.textContent = (vd && DAY_LABEL[vd] ? DAY_LABEL[vd] + ': ' : '') + (v.description || v.notes || 'Vurdering');
    if (v.id) { s.title = 'Klikk for å redigere'; s.addEventListener('click', () => openVurdEdit(v)); }
    else { s.title = 'Fra det gamle systemet – kan ikke redigeres her'; }
    td.appendChild(s);
  });
  return td;
}

// Progresjon: one class + one subject, week by week.
async function loadAllPlan() {
  if (allPlanData.length && Date.now() - allPlanTs < 60 * 60 * 1000) { renderOversiktProg(); return; }
  loadAssessments();
  showBgLoading();
  try {
    const res = await fetch(`${SCRIPT_URL}?action=public`);
    const data = await res.json();
    if (Array.isArray(data)) { allPlanData = data; allPlanTs = Date.now(); }
  } catch { /* keep whatever we have */ }
  hideBgLoading();
  renderOversiktProg();
}

function inWeek(el, w) { return el.week <= w && (el.weekTo || el.week) >= w; }

// Editable tema/ressurs cell in the progression view, bound to a specific week.
function buildProgEditCell(cls, subject, type, wk, elements) {
  const td = document.createElement('td');
  td.className = 'cell-edit';
  const single = elements.filter(e => !isMultiWeek(e));
  const multi  = elements.filter(isMultiWeek);
  const ed = createRichField({
    value: single.map(e => e.description).filter(Boolean).join('<br>'),
    placeholder: '–',
    className: 'edit-rich',
    onCommit: html => commitProgCell(ed, html),
  });
  ed.dataset.cls = cls; ed.dataset.subject = subject; ed.dataset.type = type; ed.dataset.week = wk;
  ed.dataset.ids = JSON.stringify(single.map(e => e.id).filter(Boolean));
  td.appendChild(ed);
  multi.forEach(el => td.appendChild(buildElementChip(el)));
  return td;
}

async function commitProgCell(ed, html) {
  if (ed._busy) { ed._pendingHtml = html; return; }   // serialize – see commitRichCell
  const ids = JSON.parse(ed.dataset.ids || '[]');
  const cls = ed.dataset.cls, subject = ed.dataset.subject, type = ed.dataset.type, week = ed.dataset.week;
  const wcls = writeClassesFor(subject, cls);   // whole year for electives
  const val = html.trim();

  if (!val && ids.length) {
    if (!await confirmDeletion('Du er i ferd med å slette alt innholdet i denne cellen.')) {
      restoreRichCell(ed, ids);
      return;
    }
  }

  ed._busy = true;
  setSaving();
  try {
    if (!val) {
      for (const id of ids) { const el = findLoadedElement(id); await api('delete', { id }); if (el) recordDelete(el, 'sletting'); }
      allPlanData = allPlanData.filter(p => !ids.includes(p.id));
      ed.dataset.ids = '[]';
    } else if (ids.length) {
      const el = findLoadedElement(ids[0]);
      const before = elementUpdateFields(el);
      await api('update', { id: ids[0], type, classes: wcls, week, day: '', subject, description: val, teacher: teacherName });
      recordUpdate(ids[0], before, { type, classes: wcls, week, weekTo: '', day: '', subject, description: val, teacher: teacherName }, 'endring');
      if (el) el.description = val;
      for (const extra of ids.slice(1)) await api('delete', { id: extra });
      allPlanData = allPlanData.filter(p => !ids.slice(1).includes(p.id));
      ed.dataset.ids = JSON.stringify([ids[0]]);
    } else {
      const params = { type, classes: wcls, week, day: '', subject, description: val, teacher: teacherName };
      const c = await api('create', params);
      ed.dataset.ids = JSON.stringify(c && c.id ? [c.id] : []);
      if (c && c.id) { recordCreate(params, c.id, 'tekst'); allPlanData.push(c); }
    }
    allPlanTs = 0; // invalidate so a later reload picks up the change
    ed.classList.remove('unsaved');
    setSaved();
    flashSaved(ed);
  } catch (err) {
    ed.classList.add('unsaved');
    setSaveError(err.message);
  } finally {
    ed._busy = false;
    if (ed._pendingHtml !== undefined) {
      const next = ed._pendingHtml; ed._pendingHtml = undefined;
      commitProgCell(ed, next);
    }
  }
}

function renderOversiktProg() {
  if (deferIfEditing()) return;
  const board = document.getElementById('oversiktBoard');
  if (!board) return;
  board.innerHTML = '';
  document.getElementById('oversiktWeek').textContent = '';
  fillSubjectSelect(document.getElementById('oversiktSubject'), null);   // keep «Mine fag» grouping current
  const subject = document.getElementById('oversiktSubject').value;
  const cls = document.getElementById('oversiktClass').value || selectedClass;

  const plan = allPlanData.filter(p => p.subject === subject && classMatches(p.classes, cls));
  const vurd = vurdData.filter(v => v.date && v.subject === subject && classMatches(v.classes, cls));

  const weeks = new Set();
  plan.forEach(p => { if (p.week) weeksBetween(p.week, p.weekTo || p.week).forEach(w => weeks.add(w)); });
  vurd.forEach(v => weeks.add(dateToWeek(isoToDate(v.date))));
  const sorted = [...weeks].sort();

  if (!sorted.length) {
    fillWeekSelect('ovFrom', [], null);
    fillWeekSelect('ovTo', [], null);
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Ingen plan registrert i ' + subject + ' for ' + cls + ' ennå.';
    board.appendChild(p);
    return;
  }

  if (!ovFrom || sorted.indexOf(ovFrom) === -1) ovFrom = sorted[0];
  if (!ovTo   || sorted.indexOf(ovTo)   === -1) ovTo   = sorted[sorted.length - 1];
  if (ovFrom > ovTo) { const t = ovFrom; ovFrom = ovTo; ovTo = t; }
  fillWeekSelect('ovFrom', sorted, ovFrom);
  fillWeekSelect('ovTo', sorted, ovTo);
  const visible = sorted.filter(w => w >= ovFrom && w <= ovTo);

  const wrap = document.createElement('div');
  wrap.className = 'board-wrap';
  const table = document.createElement('table');
  table.className = 'plan-table';
  const thead = table.createTHead();
  const hr = thead.insertRow();
  ['Uke', 'Tema og læringsmål', 'Ressurser', 'Lekser', 'Vurdering'].forEach(h => { const th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
  const tbody = table.createTBody();
  const nowWeek = dateToWeek(weekMonday);

  table.classList.add('editable');
  visible.forEach(wk => {
    const monday  = weekStringToMonday(wk);
    const temaEls = plan.filter(p => p.type === 'læringsmål' && inWeek(p, wk));
    const resEls  = plan.filter(p => p.type === 'ressurs' && inWeek(p, wk));
    const hw      = plan.filter(p => p.type === 'lekse' && p.description && inWeek(p, wk)).slice().sort(byDay);
    const wv      = vurd.filter(v => dateToWeek(isoToDate(v.date)) === wk);

    const tr = tbody.insertRow();
    const wc = tr.insertCell();
    wc.className = 'prog-week' + (wk === nowWeek ? ' is-now' : '');
    wc.innerHTML = 'Uke ' + getWeekNumber(monday) + '<span class="prog-week-range">' + formatWeekRange(monday, addDays(monday, 4)) + '</span>';

    // All four content columns are editable, bound to this row's class + week.
    tr.appendChild(buildProgEditCell(cls, subject, 'læringsmål', wk, temaEls));
    tr.appendChild(buildProgEditCell(cls, subject, 'ressurs', wk, resEls));
    tr.appendChild(buildHomeworkEditCell(subject, hw, { cls, week: wk }));
    tr.appendChild(buildVurdCell(subject, wv, { cls, weekFrom: monday }));
  });

  wrap.appendChild(table);
  board.appendChild(wrap);
}

// Open the modal to set a tema (læringsmål) across the current from–til range.
function addTemaForPeriode() {
  const subject = document.getElementById('oversiktSubject').value;
  const cls = document.getElementById('oversiktClass').value || selectedClass;
  openAddModal({
    type: 'læringsmål',
    subject,
    classes: [cls],
    weekFrom: ovFrom ? weekStringToMonday(ovFrom) : weekMonday,
    weekTo:   ovTo ? weekStringToMonday(ovTo) : weekMonday,
  });
}

// Export the selected class+subject progression as a .docx fagrapport.
function exportFagrapport() {
  const subject = document.getElementById('oversiktSubject').value;
  const cls = document.getElementById('oversiktClass').value || selectedClass;

  const plan = allPlanData.filter(p => p.subject === subject && classMatches(p.classes, cls));
  const vurd = vurdData.filter(v => v.date && v.subject === subject && classMatches(v.classes, cls));
  const weeksSet = new Set();
  plan.forEach(p => { if (p.week) weeksBetween(p.week, p.weekTo || p.week).forEach(w => weeksSet.add(w)); });
  vurd.forEach(v => weeksSet.add(dateToWeek(isoToDate(v.date))));
  const sorted = [...weeksSet].sort();
  const visible = sorted.filter(w => (!ovFrom || w >= ovFrom) && (!ovTo || w <= ovTo));

  if (!visible.length) { showToast('Ingenting å eksportere for ' + subject + ' i ' + cls + '.'); return; }

  const weeks = visible.map(wk => {
    const monday = weekStringToMonday(wk);
    const goals = plan.filter(p => p.type === 'læringsmål' && inWeek(p, wk)).map(p => htmlToPlain(p.description)).filter(Boolean).join('\n');
    const resources = plan.filter(p => p.type === 'ressurs' && inWeek(p, wk)).map(p => htmlToPlain(p.description)).filter(Boolean).join('\n');
    const hw = plan.filter(p => p.type === 'lekse' && p.description && inWeek(p, wk)).slice().sort(byDay)
      .map(h => (daysLabel(h.day) ? daysLabel(h.day) + ': ' : '') + htmlToPlain(h.description)).filter(Boolean).join('\n');
    const wv = vurd.filter(v => dateToWeek(isoToDate(v.date)) === wk)
      .map(v => { const d = dayOf(isoToDate(v.date)); return (d && DAY_LABEL[d] ? DAY_LABEL[d] + ': ' : '') + (v.description || v.notes || 'Vurdering'); }).join('\n');
    return {
      heading: 'Uke ' + getWeekNumber(monday) + ' · ' + formatWeekRange(monday, addDays(monday, 4)),
      fields: [
        { label: 'Tema og læringsmål', text: goals },
        { label: 'Ressurser', text: resources },
        { label: 'Lekser', text: hw },
        { label: 'Vurdering', text: wv },
      ],
    };
  });

  const blob = buildDocx('Fagrapport – ' + subject, 'Klasse ' + cls + ' · Runni ungdomsskole', weeks);
  saveBlob(blob, 'Fagrapport_' + subject.replace(/\s+/g, '_') + '_' + cls + '.docx');
}

function fillWeekSelect(id, weeks, selected) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.innerHTML = '';
  weeks.forEach(wk => {
    const o = document.createElement('option');
    o.value = wk;
    o.textContent = 'Uke ' + getWeekNumber(weekStringToMonday(wk));
    if (wk === selected) o.selected = true;
    sel.appendChild(o);
  });
}

// All ISO week strings from a to b inclusive (capped for safety).
function weeksBetween(a, b) {
  const out = [];
  let m = weekStringToMonday(a);
  const end = weekStringToMonday(b || a);
  let guard = 0;
  while (m <= end && guard++ < 80) { out.push(dateToWeek(m)); m = addDays(m, 7); }
  return out.length ? out : [a];
}

function weekStringToMonday(wk) {
  const [y, w] = wk.split('-W').map(Number);
  const jan4 = new Date(y, 0, 4);
  const jan4Day = jan4.getDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setDate(jan4.getDate() - jan4Day + 1);
  const monday = new Date(week1Monday);
  monday.setDate(week1Monday.getDate() + (w - 1) * 7);
  return monday;
}

function formatShortDate(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; }

// ─── Save status / overlay / toast ────────────────────────────

let saveTimer = null;
function setSaving()  { const el = document.getElementById('saveStatus'); el.textContent = 'Lagrer…'; el.className = 'save-status saving'; }
function setSaved()   {
  const el = document.getElementById('saveStatus');
  el.textContent = 'Lagret ✓'; el.className = 'save-status saved';
  clearTimeout(saveTimer); saveTimer = setTimeout(() => { el.textContent = ''; }, 2500);
}
// A brief green ring on the cell that just saved – local confirmation right
// where the eye is (mirrors the red .unsaved outline for failures).
function flashSaved(el) {
  if (!el) return;
  el.classList.remove('just-saved');
  void el.offsetWidth;   // restart the animation if it fires again quickly
  el.classList.add('just-saved');
  el.addEventListener('animationend', () => el.classList.remove('just-saved'), { once: true });
}
// Turn technical / English backend or network errors into friendly Norwegian.
// The backend already returns Norwegian for most cases, so those pass through.
function translateError(msg) {
  const m = String(msg || '').trim();
  const map = {
    'Unauthorized': 'Du er logget ut. Logg inn på nytt.',
    'Unknown action': 'Noe gikk galt i kontakten med serveren.',
    'Failed to fetch': 'Ingen nettforbindelse. Sjekk at du er på nett.',
    'NetworkError when attempting to fetch resource.': 'Ingen nettforbindelse. Sjekk at du er på nett.',
    'Load failed': 'Ingen nettforbindelse. Sjekk at du er på nett.',
  };
  if (map[m]) return map[m];
  if (!m || /^(HTTP \d|Unexpected token|JSON|TypeError|undefined|null)/i.test(m)) return 'Noe gikk galt. Prøv igjen.';
  return m;
}

function setSaveError(msg) {
  const el = document.getElementById('saveStatus');
  el.textContent = '⚠ Ikke lagret!'; el.className = 'save-status error';
  clearTimeout(saveTimer); saveTimer = setTimeout(() => { el.textContent = ''; }, 8000);
  showToast('Kunne ikke lagre: ' + translateError(msg) + ' Endringen er IKKE lagret.', { duration: 6000 });
}

function showOverlay() {
  const o = document.getElementById('overlay');
  o.querySelector('.overlay-text').textContent = 'Laster...';
  o.querySelector('.spinner').style.display = '';
  o.querySelector('.overlay-retry')?.remove();
  o.classList.add('active');
}
function hideOverlay() { document.getElementById('overlay').classList.remove('active'); }
function showOverlayError(msg) {
  const o = document.getElementById('overlay');
  o.querySelector('.spinner').style.display = 'none';
  o.querySelector('.overlay-text').textContent = msg;
  if (!o.querySelector('.overlay-retry')) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary overlay-retry';
    btn.textContent = 'Prøv igjen';
    btn.addEventListener('click', () => loadData());
    o.querySelector('.overlay-inner').appendChild(btn);
  }
  o.classList.add('active');
}
// The background-fetch spinner was removed – backend calls are fast and it only
// caused layout twitch. Kept as no-ops so the call sites need no changes.
function showBgLoading() {}
function hideBgLoading() {}

function updateStatus() {
  document.getElementById('lastUpdated').textContent = 'Sist oppdatert: ' + new Date().toLocaleString('no');
}

function hideToast() {
  const toast = document.getElementById('toast');
  toast.classList.remove('show');
  setTimeout(() => { toast.hidden = true; }, 250);
}
function showToast(message, opts = {}) {
  const toast = document.getElementById('toast');
  toast.querySelector('.toast-msg').textContent = message;
  const actionBtn = toast.querySelector('.toast-action');
  if (actionBtn) {
    if (opts.action) {
      actionBtn.textContent = opts.action.label;
      actionBtn.hidden = false;
      actionBtn.onclick = () => { hideToast(); opts.action.onClick(); };
    } else {
      actionBtn.hidden = true;
      actionBtn.onclick = null;
    }
  }
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(toast._timer);
  toast._timer = setTimeout(hideToast, opts.duration ?? 3000);
}

// ─── Utilities ────────────────────────────────────────────────

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.max(ta.scrollHeight, 24) + 'px';
}

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = d.getDay() || 7;
  d.setDate(d.getDate() - dow + 1);
  return d;
}
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isoToDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function dayOf(date) { return ['', 'man', 'tir', 'ons', 'tor', 'fre', ''][date.getDay()] || ''; }
function parseDays(s) {
  return String(s || '').toLowerCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean)
    .filter(d => DAYS.includes(d)).sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
}
function daysLabel(s) { return parseDays(s).map(d => DAY_LABEL[d]).join(', '); }
function isMultiWeek(el) { return el.weekTo && el.weekTo > el.week; }
function byDay(a, b) {
  const fa = parseDays(a.day), fb = parseDays(b.day);
  return (fa.length ? DAYS.indexOf(fa[0]) + 1 : 9) - (fb.length ? DAYS.indexOf(fb[0]) + 1 : 9);
}
function weekRangeShort(el) {
  if (!isMultiWeek(el)) return '';
  return 'uke ' + getWeekNumber(weekStringToMonday(el.week)) + '–' + getWeekNumber(weekStringToMonday(el.weekTo));
}
function getWeekNumber(d) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
function dateToWeek(d) {
  const u = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  u.setUTCDate(u.getUTCDate() + 4 - (u.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(u.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((u - yearStart) / 86400000) + 1) / 7);
  return u.getUTCFullYear() + '-W' + (week < 10 ? '0' + week : '' + week);
}
function formatWeekRange(monday, friday) {
  const m1 = monday.toLocaleString('no', { month: 'long' });
  const m2 = friday.toLocaleString('no', { month: 'long' });
  if (m1 === m2) return `${monday.getDate()}.–${friday.getDate()}. ${m1}`;
  return `${monday.getDate()}. ${m1} – ${friday.getDate()}. ${m2}`;
}
function classMatches(classesStr, cls) {
  return String(classesStr || '').toUpperCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean).includes(cls);
}

// ─── School calendar (read-only context) ──────────────────────

function classifySchoolEvent(summary) {
  const s = (summary || '').toLowerCase();
  if (!s || s.includes('sfo')) return null;
  if (s.includes('planleggingsdag')) return 'planning';
  if (s.includes('første skoledag') || s.includes('siste skoledag')) return 'marker';
  if (
    s.includes('ferie') || s.includes('himmelfartsdag') || s.includes('pinsedag') ||
    s.includes('grunnlovsdag') || s.includes('1.mai') || s.includes('1. mai') ||
    s.includes('skjærtorsdag') || s.includes('langfredag') || s.includes('påskedag') ||
    s.includes('julaften') || s.includes('nyttårsaften') ||
    s.includes('juledag') || s.includes('nyttårsdag')
  ) return 'off';
  return null;
}
function parseICS(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = []; let current = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }
    if (line === 'END:VEVENT')   { if (current) events.push(current); current = null; continue; }
    if (!current) continue;
    const m = line.match(/^([A-Z]+)(?:;[^:]*)?:(.*)$/);
    if (!m) continue;
    if (m[1] === 'DTSTART')      current.dtstart = m[2].trim();
    else if (m[1] === 'SUMMARY') current.summary = unescapeICS(m[2]);
  }
  return events.map(e => ({ date: icsDateToISO(e.dtstart), summary: e.summary || '' })).filter(e => e.date);
}
function icsDateToISO(s) { if (!s) return null; const m = s.match(/^(\d{4})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; }
function unescapeICS(s) { return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\'); }
function buildSchoolDayMap(events) {
  const priority = { off: 3, planning: 2, marker: 1 }; const out = {};
  for (const e of events) {
    const type = classifySchoolEvent(e.summary); if (!type) continue;
    const ex = out[e.date];
    if (!ex) out[e.date] = { type, summaries: [e.summary] };
    else { if (priority[type] > priority[ex.type]) ex.type = type; if (!ex.summaries.includes(e.summary)) ex.summaries.push(e.summary); }
  }
  return out;
}
function loadCachedSchoolDays() {
  const ts = localStorage.getItem(SCHOOL_CAL_TS_KEY);
  if (!ts || Date.now() - Number(ts) > SCHOOL_CAL_TTL) return null;
  try { return JSON.parse(localStorage.getItem(SCHOOL_CAL_KEY)); } catch { return null; }
}
async function loadSchoolCalendar() {
  if (Object.keys(schoolDays).length > 0 && loadCachedSchoolDays()) return;
  try {
    const res = await fetch(SCHOOL_CAL_URL);
    if (!res.ok) return;
    const events = parseICS(await res.text());
    if (events.length === 0) return;
    schoolDays = buildSchoolDayMap(events);
    localStorage.setItem(SCHOOL_CAL_KEY, JSON.stringify(schoolDays));
    localStorage.setItem(SCHOOL_CAL_TS_KEY, String(Date.now()));
  } catch { /* silent */ }
}
