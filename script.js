'use strict';

// ─── Configuration ────────────────────────────────────────────

// ukeplan backend – plan elements AND assessments (read-only here, merged into
// the "Vurdering" column). Assessments come from ?action=vurderinger.
const SCRIPT_URL = 'https://api.ukeportalen.no';

const CLASS_KEY      = 'up_class';          // chosen class (single)
const ELECTIVE_KEY   = 'up_electives';      // chosen elective subjects (array; null = not chosen yet)
const WEEK_CACHE_KEY = 'up_weeks';          // { "8A|2026-W24": { ts, data } }
const VURD_CACHE_KEY = 'up_vurd';
const VURD_TS_KEY    = 'up_vurd_ts';
const HEND_CACHE_KEY = 'up_hend';
const HEND_TS_KEY    = 'up_hend_ts';
const DONE_KEY       = 'up_done';            // { elementId: true } – locally checked-off homework
const ALL_CACHE_KEY  = 'up_all';             // all plan elements (for fag-progresjon)
const ALL_TS_KEY     = 'up_all_ts';
const VARIANT_KEY    = 'up_variant';         // personal/adapted-plan code, e.g. "8A-K7X9M"
const NAME_KEY       = 'up_name';            // student display name (personalization)
const ONBOARDED_KEY  = 'up_onboarded';       // '1' once the first-run wizard is finished
const LANDING_KEY    = 'up_landing';         // startside: 'hjem' | 'ukeplan' | 'last' (default hjem)
const TAB_KEY        = 'up_last_tab';         // last-visited tab, restored on reload
const HIDE_BE_KEY    = 'up_hide_be';          // beskjeder+hendelser block collapsed?
const ACK_BESKJED_KEY = 'up_ack_beskjed';    // { [beskjedKey]: true } – acknowledged beskjeder
const SEEN_LEKSER_KEY = 'up_seen_lekser';    // { "<planKey>|<week>": [lekseKeys] } – new-lekse baseline
const CELEBRATED_KEY = 'up_celebrated';      // { "<planKey>|<week>": { milestone: 1 } } – fired celebrations
const CACHE_TTL      = 60 * 60 * 1000;       // 1 hour

const SCHOOL_CAL_URL    = 'https://sspkalender.prokom.no/api/iCalTidspunkt/?Kunde=nesakskoleruta&Id=0&Categories=438,439';
const SCHOOL_CAL_KEY    = 'up_school_cal';
const SCHOOL_CAL_TS_KEY = 'up_school_cal_ts';
const SCHOOL_CAL_TTL    = 24 * 60 * 60 * 1000;

// Classes + subjects come from the school config (server `?action=config`,
// editable by a super-admin). These are the DEFAULTS (offline / before config
// loads / if unset); `applySchoolConfig` reassigns them – hence `let`.
let CLASS_GRADES = [
  { label: '8.',  classes: ['8A','8B','8C','8D','8E','8F'] },
  { label: '9.',  classes: ['9A','9B','9C','9D','9E','9F'] },
  { label: '10.', classes: ['10A','10B','10C','10D','10E','10F'] },
];
let CLASSES = CLASS_GRADES.flatMap(g => g.classes);

// Core subjects (everyone has these) + electives/tilvalgsfag (chosen per student).
let CORE_SUBJECTS = [
  'Norsk','Matematikk','Engelsk','Naturfag','Samfunnsfag','KRLE',
  'Kroppsøving','Musikk','Kunst og håndverk','Mat og helse','Utdanningsvalg',
];
let ELECTIVE_SUBJECTS = [
  'Spansk','Fransk','Tysk','Engelsk fordypning',
  'Arbeidslivsfag (ALF)','Fysisk aktivitet og helse (Fysak)','Friluftsliv',
  'Innsats for andre','Programmering','Teknologi og design','Design og redesign',
  'Matematikk 1T','Medier og kommunikasjon',
];
let SUBJECTS = [...CORE_SUBJECTS, ...ELECTIVE_SUBJECTS];
// Alphabetical (Norwegian) order for the Fag dropdown; the board keeps the
// curriculum order of SUBJECTS (see subjectSort).
let SUBJECTS_SORTED = [...SUBJECTS].sort((a, b) => a.localeCompare(b, 'no'));

// ── School config (classes + subjects), fetched from the server ──────────────
const CONFIG_KEY = 'up_school_config';
function applySchoolConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.grades)) return false;
  const grades = cfg.grades
    .filter(g => g && g.label && Array.isArray(g.classes) && g.classes.length)
    .map(g => ({ label: String(g.label), classes: g.classes.map(c => String(c).toUpperCase()) }));
  const core = Array.isArray(cfg.coreSubjects) ? cfg.coreSubjects.map(String) : [];
  const elec = Array.isArray(cfg.electiveSubjects) ? cfg.electiveSubjects.map(String) : [];
  if (!grades.length || (!core.length && !elec.length)) return false;
  CLASS_GRADES = grades;
  CLASSES = CLASS_GRADES.flatMap(g => g.classes);
  CORE_SUBJECTS = core;
  ELECTIVE_SUBJECTS = elec;
  SUBJECTS = [...CORE_SUBJECTS, ...ELECTIVE_SUBJECTS];
  SUBJECTS_SORTED = [...SUBJECTS].sort((a, b) => a.localeCompare(b, 'no'));
  return true;
}
(function () { try { const c = JSON.parse(localStorage.getItem(CONFIG_KEY)); if (c) applySchoolConfig(c); } catch {} })();
async function refreshSchoolConfig() {
  try {
    const res = await fetch(`${SCRIPT_URL}?action=config`);
    const cfg = await res.json();
    if (cfg && !cfg.error && applySchoolConfig(cfg)) localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch { /* keep cache/defaults */ }
}

const DAYS = ['man','tir','ons','tor','fre'];
const DAY_LABEL = { man: 'Mandag', tir: 'Tirsdag', ons: 'Onsdag', tor: 'Torsdag', fre: 'Fredag' };
const DAY_LONG  = { man: 'mandag', tir: 'tirsdag', ons: 'onsdag', tor: 'torsdag', fre: 'fredag' };

// Element types that are class-wide (no subject) → shown in the banner.
const GENERAL_TYPES = ['beskjed', 'timeendring', 'utstyr', 'aktivitet', 'annet'];
const GENERAL_ICON  = { beskjed: '📣', timeendring: '🕑', utstyr: '🎒', aktivitet: '🚌', annet: '📌' };

let selectedClass = null;
let variantCode   = null;               // active personal-plan code, or null
let viewBase      = false;              // "Se vanlig plan" – show the class plan while a code is stored
let weekMonday    = mondayOf(new Date());

// Plan content is fetched/filtered under the variant code when one is active
// (unless "Se vanlig plan" is on); assessments, calendar and the class label keep
// using the base class (selectedClass), so a personal plan inherits its vurderinger.
function planKey() { return (variantCode && !viewBase) ? variantCode : selectedClass; }

// A tilpasset plan FOLLOWS THE REGULAR CLASS PLAN by default: only subjects in
// `variantAdaptedSubjects` use the pupil's own content; the rest (and all
// beskjeder) inherit the base class. These support that merge on the student side.
let variantAdaptedSubjects = [];   // subjects the active code adapts
let variantInfoCode = null;        // the code adaptedSubjects was loaded for
function variantBaseClass() { return (variantCode && parseVariantClass(variantCode)) || selectedClass; }
async function loadVariantInfo() {
  if (!variantCode) { variantAdaptedSubjects = []; variantInfoCode = null; return; }
  try {
    const res = await fetch(`${SCRIPT_URL}?action=variant_info&code=${encodeURIComponent(variantCode)}`);
    const data = await res.json();
    variantAdaptedSubjects = (data && Array.isArray(data.adaptedSubjects)) ? data.adaptedSubjects : [];
  } catch { variantAdaptedSubjects = []; }
  variantInfoCode = variantCode;
}
// Classes to FETCH for a week: a variant view also pulls the base class so
// non-adapted subjects + beskjeder can be inherited.
function fetchClassesFor(key) {
  return (variantCode && !viewBase && key === variantCode) ? (variantCode + ' ' + variantBaseClass()) : key;
}
// Resolve the raw base+code payload into the effective plan: adapted subjects use
// code content, everything else the base class, all normalised to the code so the
// existing renderers (which match planKey()) work unchanged.
function applyVariantMerge(raw) {
  if (!Array.isArray(raw)) return [];
  if (!variantCode || viewBase) return raw;
  const code = variantCode, base = variantBaseClass();
  const SUBJ = ['læringsmål', 'ressurs', 'lekse'];
  const out = [];
  raw.forEach(el => {
    const wantClass = (SUBJ.includes(el.type) && el.subject && !variantAdaptedSubjects.includes(el.subject)) ? base
                    : (SUBJ.includes(el.type) && el.subject) ? code
                    : base;   // general/beskjeder inherit the class
    if (classMatches(el.classes, wantClass)) out.push(Object.assign({}, el, { classes: code }));
  });
  return out;
}
// The class whose content a given subject draws from in the current view (used by
// the Fag tab, which reads the full public set rather than the merged week).
function contentClassFor(subject) {
  if (variantCode && !viewBase) return variantAdaptedSubjects.includes(subject) ? variantCode : variantBaseClass();
  return planKey();
}

// The stored key is "<CLASS>-<SUFFIX>", but pupils only ever enter/receive the
// SUFFIX – the class comes from their class choice, so a code resolves only
// together with the right class (and never reveals which class it belongs to).
function parseVariantClass(code) {
  const m = /^(\d{1,2}[A-Z])-[A-Z0-9]{3,}$/.exec(String(code || '').trim().toUpperCase());
  return m && CLASSES.includes(m[1]) ? m[1] : null;
}
function variantSuffix(full) {
  const i = String(full || '').indexOf('-');
  return i < 0 ? '' : full.slice(i + 1);
}
let planData      = [];                 // plan elements for current class+week
let previewWeekData = [];               // next week's elements (Friday "day before" preview)
let previewWeekKey  = null;             // "class|week" the preview data is for / in flight
let vurdData      = [];                 // all assessments (filtered client-side)
let hendData      = [];                 // all calendar events (filtered client-side by class/date)
let lastFocusedEl = null;
let schoolDays    = loadCachedSchoolDays() || {}; // ISO date -> { type, summaries }

// Which tab to open, per the Startside preference: a fixed tab ('hjem'/'ukeplan')
// or 'last' = wherever the user last was (resolveLanding, defined below).
let currentTab       = resolveLanding();
let ukeplanView      = 'uke';      // 'uke' | 'dag'
let selectedDayIndex = 0;          // 0..4 (Mon..Fri), for the day view
let planDataKey      = null;       // "<planKey>|<week>" that planData currently holds
let dashBeskjedIdx   = 0;          // which unacknowledged beskjed the stepper shows
let dashLekseIdx     = 0;          // which remaining lekse the deck shows (cycle position)
let newLekseKeys     = [];         // lekser added since the last dashboard review (this week)
let dashReviewedKey  = null;       // "<planKey>|<week>" the new-lekse review last ran for
let newLekserPending = false;      // a fresh review found new lekser → announce once (modal)
let modalLanding     = null;       // startside tentatively picked in the profile
let allPlanData      = [];         // all plan elements (fag-progresjon)
let electives        = null;       // chosen elective subjects (null = not chosen yet → show all)
let studentName      = localStorage.getItem(NAME_KEY) || '';   // display name (personalization)
let modalClass       = null;       // class tentatively picked in the profile/onboarding
let modalElectives   = [];         // electives tentatively picked in the profile/onboarding
let modalName        = '';         // name tentatively typed in the profile/onboarding
let fagFrom          = null;       // week range filter for the Fag tab
let fagTo            = null;
let calStart         = null;       // date range for the Vurderingskalender tab
let calEnd           = null;

// ─── Lifecycle ────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', init);

async function init() {
  setupListeners();
  loadSchoolCalendar();
  // Service worker is registered (+ auto-reload on update) from rich.js, shared
  // by both pages.
  // Fetch the school config (classes/subjects) before validating the stored class
  // below; a cached copy was already applied synchronously at module load.
  await refreshSchoolConfig();

  selectedClass = localStorage.getItem(CLASS_KEY);
  if (selectedClass && !CLASSES.includes(selectedClass)) selectedClass = null;
  // A stored personal-plan code derives the base class from its prefix.
  variantCode = localStorage.getItem(VARIANT_KEY) || null;
  if (variantCode) {
    const base = parseVariantClass(variantCode);
    if (base) selectedClass = base; else variantCode = null;
  }
  electives = loadElectives();
  populateFagSubjects();

  updateClassLabel();
  updateWeekLabel();

  if (!selectedClass) {
    hideOverlay();
    // A brand-new visitor gets the guided onboarding; a returning one who somehow
    // cleared their class just gets the profile modal to re-pick.
    if (!localStorage.getItem(ONBOARDED_KEY)) showStudentOnboarding();
    else showClassModal();
    return;
  }
  setTab(currentTab);   // land on the student's Startside (default «Min uke»)
  await loadWeek();
}

function setupListeners() {
  document.getElementById('prevWeekBtn').addEventListener('click', () => changeWeek(-1));
  document.getElementById('nextWeekBtn').addEventListener('click', () => changeWeek(1));
  document.getElementById('jumpTodayBtn').addEventListener('click', jumpToThisWeek);
  document.getElementById('weekJumpBtn').addEventListener('click', openWeekPicker);
  document.getElementById('refreshBtn').addEventListener('click', () => {
    if (currentTab === 'fag') loadAllPlan({ skipCache: true });
    else loadWeek({ skipCache: true });
    // Assessments are cached separately (up to 1 h); refresh them too so a newly
    // added vurdering shows up without waiting for the cache to expire.
    loadAssessments({ skipCache: true });
    loadHendelser({ skipCache: true });
  });

  // Theme lives in the profile modal now (segmented Auto/Lyst/Mørkt, live).
  const themeSeg = document.getElementById('studentThemeSeg');
  if (themeSeg && window.UPTheme) {
    themeSeg.addEventListener('click', e => {
      const btn = e.target.closest('.theme-seg-btn'); if (!btn) return;
      UPTheme.set(btn.dataset.themePref);
      syncThemeSeg(themeSeg);
    });
  }
  // Startside preference (Min uke / Ukeplan) – tentative until Lagre.
  const landingSeg = document.getElementById('studentLandingSeg');
  if (landingSeg) {
    landingSeg.addEventListener('click', e => {
      const btn = e.target.closest('.theme-seg-btn'); if (!btn) return;
      modalLanding = btn.dataset.landing;
      landingSeg.querySelectorAll('.theme-seg-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
  }

  // Profile modal (name · class · valgfag · tema) – opened by the class pill AND
  // the Profil button; the wizard reruns from inside it.
  document.getElementById('viewBaseToggle').addEventListener('click', () => {
    viewBase = !viewBase;
    planData = []; previewWeekKey = null; planDataKey = null; dashReviewedKey = null;
    updateViewBaseToggle();
    loadWeek();
  });
  document.getElementById('classBtn').addEventListener('click', showClassModal);
  document.getElementById('profileBtn').addEventListener('click', showClassModal);
  document.getElementById('classModalClose').addEventListener('click', () => closeClassModal());
  document.getElementById('classModalOverlay').addEventListener('click', () => closeClassModal());
  document.getElementById('classConfirm').addEventListener('click', confirmClassModal);
  document.getElementById('rerunOnboardBtn').addEventListener('click', () => { closeClassModal(); showStudentOnboarding(); });

  // Onboarding wizard nav.
  document.getElementById('sOnboardNext').addEventListener('click', sNext);
  document.getElementById('sOnboardBack').addEventListener('click', sBack);

  document.getElementById('tabHjem').addEventListener('click', () => setTab('hjem'));
  document.getElementById('tabUkeplan').addEventListener('click', () => setTab('ukeplan'));
  document.getElementById('tabFag').addEventListener('click', () => setTab('fag'));
  document.getElementById('tabVurd').addEventListener('click', () => setTab('vurd'));
  document.getElementById('viewUke').addEventListener('click', () => setView('uke'));
  document.getElementById('viewDag').addEventListener('click', () => setView('dag'));
  document.getElementById('calStart').addEventListener('change', onCalDateChange);
  document.getElementById('calEnd').addEventListener('change', onCalDateChange);

  const fagSel = document.getElementById('fagSubject');
  populateFagSubjects();
  fagSel.addEventListener('change', () => { fagFrom = null; fagTo = null; renderFag(); });
  document.getElementById('fagFrom').addEventListener('change', e => { fagFrom = e.target.value; renderFag(); });
  document.getElementById('fagTo').addEventListener('change', e => { fagTo = e.target.value; renderFag(); });

  document.addEventListener('keydown', e => {
    const classOpen   = document.getElementById('classModal').classList.contains('open');
    const onboardOpen = document.getElementById('sOnboardModal').classList.contains('open');
    if (e.key === 'Escape') {
      if (classOpen) closeClassModal();
      else if (onboardOpen) closeStudentOnboarding();
      return;
    }
    if (e.key === 'Tab') {
      if (classOpen) trapFocus(document.getElementById('classModal'), e);
      else if (onboardOpen) trapFocus(document.getElementById('sOnboardModal'), e);
    }
    // Week navigation with arrow keys (only in the Ukeplan tab, no modal/dialog
    // open, and not while typing in a field).
    const ae = document.activeElement;
    const typing = ae && (ae.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName));
    if (!classOpen && !onboardOpen &&
        !document.querySelector('.ui-dialog') && !typing &&
        selectedClass && currentTab === 'ukeplan') {
      if (e.key === 'ArrowLeft')  changeWeek(-1);
      if (e.key === 'ArrowRight') changeWeek(1);
    }
  });
}

// ─── Tabs & view switching ────────────────────────────────────

function setTab(tab) {
  currentTab = tab;
  localStorage.setItem(TAB_KEY, tab);   // restore where they were on next reload
  [['tabHjem', 'hjem'], ['tabUkeplan', 'ukeplan'], ['tabFag', 'fag'], ['tabVurd', 'vurd']].forEach(([id, t]) => {
    const btn = document.getElementById(id);
    const on = tab === t;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  // Week-nav follows both the dashboard and Ukeplan (both are week-scoped); the
  // uke/dag view-toggle is Ukeplan-only.
  const showNav = tab === 'ukeplan' || tab === 'hjem';
  // visibility (not display) so the controls-row keeps a constant size across tabs
  document.querySelector('.week-nav').style.visibility     = showNav ? 'visible' : 'hidden';
  document.getElementById('jumpTodayBtn').style.visibility = showNav ? 'visible' : 'hidden';
  document.getElementById('viewToggle').style.display      = tab === 'ukeplan' ? '' : 'none';
  document.getElementById('dashboardView').hidden = tab !== 'hjem';
  document.getElementById('board').hidden      = tab !== 'ukeplan';
  document.getElementById('fagView').hidden    = tab !== 'fag';
  document.getElementById('calControls').hidden = tab !== 'vurd';
  document.getElementById('calendar').hidden   = tab !== 'vurd';
  if (tab === 'fag') loadAllPlan();
  else render();
}

function setView(v) {
  ukeplanView = v;
  document.getElementById('viewUke').classList.toggle('active', v === 'uke');
  document.getElementById('viewDag').classList.toggle('active', v === 'dag');
  render();
}

function selectDay(i) {
  selectedDayIndex = i;
  setView('dag');
}

// ─── Week navigation ──────────────────────────────────────────

function changeWeek(delta) {
  weekMonday = addDays(weekMonday, delta * 7);
  updateWeekLabel();
  if (selectedClass) loadWeek();
}

function jumpToThisWeek() {
  weekMonday = mondayOf(new Date());
  updateWeekLabel();
  if (selectedClass) loadWeek();
}

// All weeks of the school year containing the viewed week (for the week picker).
function schoolYearWeeks() {
  const b = getSchoolYearBounds(weekMonday);
  const parse = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const out = [];
  let m = mondayOf(parse(b.start));
  const end = mondayOf(parse(b.end));
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
  const [y, mo, d] = chosen.split('-').map(Number);
  weekMonday = mondayOf(new Date(y, mo - 1, d));
  updateWeekLabel();
  if (selectedClass) loadWeek();
}

function updateWeekLabel() {
  const friday = addDays(weekMonday, 4);
  document.getElementById('weekLabel').textContent = 'Uke ' + getWeekNumber(weekMonday);
  document.getElementById('weekRange').textContent = formatWeekRange(weekMonday, friday);
}

// ─── Data loading ─────────────────────────────────────────────

async function loadWeek(opts = {}) {
  const { skipCache = false } = opts;
  // Know which subjects the code adapts before merging a variant view.
  if (variantCode && !viewBase && variantInfoCode !== variantCode) await loadVariantInfo();
  const week = dateToWeek(weekMonday);
  const key  = planKey();
  const background = planData.length > 0 || !!getCachedWeek(key, week);

  // Assessments + events caches (small datasets, fetched once per hour).
  loadAssessments({ skipCache });
  loadHendelser({ skipCache });

  if (!skipCache) {
    const cached = getCachedWeek(key, week);
    if (cached) {
      planData = applyVariantMerge(cached);
      planDataKey = key + '|' + week;
      render();
      hideOverlay();
      // refresh in the background
      fetchWeek(key, week, { background: true });
      return;
    }
  }

  if (background) showBgLoading(); else showOverlay();
  await fetchWeek(key, week, { background });
}

async function fetchWeek(cls, week, opts = {}) {
  const { background = false } = opts;
  try {
    // For a variant view, fetch both the code's own content and the base
    // class's, so non-adapted subjects can inherit the class plan.
    const url = `${SCRIPT_URL}?action=week&classes=${encodeURIComponent(fetchClassesFor(cls))}&week=${encodeURIComponent(week)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(data.error || 'Ugyldig svar');
    // Only adopt if still the active plan+week (user may have navigated away).
    if (cls === planKey() && week === dateToWeek(weekMonday)) {
      planData = applyVariantMerge(data);
      planDataKey = cls + '|' + week;
      render();
    }
    setCachedWeek(cls, week, data);
    updateStatus();
    if (background) hideBgLoading(); else hideOverlay();
  } catch (err) {
    if (background) hideBgLoading();
    else showOverlayError('Kunne ikke laste ukeplanen. Sjekk tilkoblingen og prøv igjen.');
  }
}

// The day view shows beskjeder a day early ("dagen før"). For the Friday view
// the next school day is the FOLLOWING week's Monday, so make sure that week's
// data is loaded (reusing the per-week cache) and re-render when it arrives.
function ensureNextWeekData() {
  if (!selectedClass) return;
  const planK = planKey();
  const nextWeek = dateToWeek(addDays(weekMonday, 7));
  const key = planK + '|' + nextWeek;
  if (previewWeekKey === key) return;          // already loaded or in flight
  previewWeekKey = key;
  const cached = getCachedWeek(planK, nextWeek);
  if (cached) { previewWeekData = applyVariantMerge(cached); return; }
  const url = `${SCRIPT_URL}?action=week&classes=${encodeURIComponent(fetchClassesFor(planK))}&week=${encodeURIComponent(nextWeek)}`;
  fetch(url)
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (!Array.isArray(data)) return;
      setCachedWeek(planK, nextWeek, data);
      if (previewWeekKey !== key) return;       // user navigated away meanwhile
      previewWeekData = applyVariantMerge(data);
      if (currentTab === 'ukeplan' && ukeplanView === 'dag') renderDayView();
    })
    .catch(() => {});
}

async function loadAssessments(opts = {}) {
  const { skipCache = false } = opts;
  if (!skipCache) {
    const ts = localStorage.getItem(VURD_TS_KEY);
    if (ts && Date.now() - Number(ts) < CACHE_TTL) {
      try { vurdData = JSON.parse(localStorage.getItem(VURD_CACHE_KEY)) || []; } catch { vurdData = []; }
      return;
    }
  }
  try {
    const res = await fetch(`${SCRIPT_URL}?action=vurderinger`);
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data)) return;
    vurdData = data;
    localStorage.setItem(VURD_CACHE_KEY, JSON.stringify(data));
    localStorage.setItem(VURD_TS_KEY, String(Date.now()));
    render();
  } catch {
    // Silent – keep whatever was cached.
  }
}

// Calendar events (hendelser) – same 1 h cache pattern as assessments.
async function loadHendelser(opts = {}) {
  const { skipCache = false } = opts;
  if (!skipCache) {
    const ts = localStorage.getItem(HEND_TS_KEY);
    if (ts && Date.now() - Number(ts) < CACHE_TTL) {
      try { hendData = JSON.parse(localStorage.getItem(HEND_CACHE_KEY)) || []; } catch { hendData = []; }
      return;
    }
  }
  try {
    const res = await fetch(`${SCRIPT_URL}?action=hendelser`);
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data)) return;
    hendData = data;
    localStorage.setItem(HEND_CACHE_KEY, JSON.stringify(data));
    localStorage.setItem(HEND_TS_KEY, String(Date.now()));
    render();
  } catch { /* keep cached */ }
}

// The ISO dates a hendelse covers (single day when dateTo empty), capped.
function hendDates(h) {
  const out = [];
  if (!h || !h.date) return out;
  let d = isoToDate(h.date);
  const end = h.dateTo ? isoToDate(h.dateTo) : d;
  let guard = 0;
  while (d <= end && guard++ < 120) { out.push(toISODate(d)); d = addDays(d, 1); }
  return out;
}
// An event with no classes is school-wide; else it must list the student's class.
function hendForStudent(h) { return !h.classes || classMatches(h.classes, selectedClass); }
function eventsOnDate(iso) { return hendData.filter(h => hendForStudent(h) && hendDates(h).includes(iso)); }

// Urgency of an upcoming event relative to TODAY (for the Min uke panel). null
// only when the event is fully in the past. Four tiers, most→least prominent:
// now (today/tomorrow), week (rest of this week), coming (next week – "the week
// before"), senere (everything further out, most muted – so nothing is hidden).
function eventUrgency(h) {
  const today = new Date();
  const todayISO = toISODate(today);
  const tomorrowISO = toISODate(addDays(today, 1));
  const nextMondayISO = toISODate(addDays(mondayOf(today), 7));
  const nextSundayISO = toISODate(addDays(mondayOf(today), 13));   // end of next week
  const days = hendDates(h);
  const upcoming = days.filter(iso => iso >= todayISO);
  if (!upcoming.length) return null;   // fully past
  const nextDay = upcoming[0];
  const longDate = iso => capitalizeFirst(isoToDate(iso).toLocaleDateString('no', { weekday: 'long', day: 'numeric', month: 'short' }));
  if (days.includes(todayISO)) return { tier: 'now', rank: 0, label: 'I dag', day: todayISO };
  if (nextDay === tomorrowISO)  return { tier: 'now', rank: 0, label: 'I morgen', day: nextDay };
  if (nextDay < nextMondayISO)  return { tier: 'week', rank: 1, label: capitalizeFirst(isoToDate(nextDay).toLocaleDateString('no', { weekday: 'long' })), day: nextDay };
  if (nextDay <= nextSundayISO) return { tier: 'coming', rank: 2, label: 'Neste uke · ' + longDate(nextDay), day: nextDay };
  return { tier: 'senere', rank: 3, label: 'Senere · ' + longDate(nextDay), day: nextDay };
}

// ─── Class selection ──────────────────────────────────────────

function updateClassLabel() {
  document.getElementById('classBtnLabel').textContent = selectedClass || 'Velg klasse';
  updateViewBaseToggle();
}
// "Se vanlig plan" toggle: visible only when a personal code is stored; flips the
// content view between the pupil's adapted plan and the class's regular plan.
function updateViewBaseToggle() {
  const btn = document.getElementById('viewBaseToggle');
  if (!btn) return;
  btn.hidden = !variantCode;
  btn.textContent = viewBase ? 'Se min plan' : 'Se vanlig plan';
  btn.classList.toggle('active', viewBase);
}

function loadElectives() {
  const raw = localStorage.getItem(ELECTIVE_KEY);
  if (raw === null) return null;
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}

// Whether a subject should be shown for this student. Core subjects always;
// electives only if chosen. Before any choice is made (null), show everything.
function subjectVisible(subject) {
  if (!subject || !ELECTIVE_SUBJECTS.includes(subject)) return true;
  if (electives === null) return true;
  return electives.includes(subject);
}

function populateFagSubjects() {
  const sel = document.getElementById('fagSubject');
  const current = sel.value;
  sel.innerHTML = '';
  SUBJECTS_SORTED.filter(subjectVisible).forEach(s => {
    const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o);
  });
  if ([...sel.options].some(o => o.value === current)) sel.value = current;
}

// Grade-grouped single-select class grid, bound to `modalClass`; `onPick` fires
// after a selection. Shared by the profile modal + the onboarding class step.
function buildClassGridInto(grid, onPick) {
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
      btn.className = 'class-modal-btn' + (cls === modalClass ? ' active' : '');
      btn.textContent = cls;
      btn.addEventListener('click', () => {
        modalClass = cls;
        grid.querySelectorAll('.class-modal-btn').forEach(b => b.classList.toggle('active', b === btn));
        if (onPick) onPick();
      });
      wrap.appendChild(btn);
    });
    grid.appendChild(wrap);
  });
}
// Multi-select elective grid toggling into `modalElectives`. Shared too;
// `onChange` (optional) fires after each toggle (profile modal summary).
function buildElectiveGridInto(grid, onChange) {
  grid.innerHTML = '';
  ELECTIVE_SUBJECTS.forEach(sub => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'class-modal-btn' + (modalElectives.includes(sub) ? ' active' : '');
    btn.textContent = sub;
    btn.addEventListener('click', () => {
      if (modalElectives.includes(sub)) modalElectives = modalElectives.filter(s => s !== sub);
      else modalElectives.push(sub);
      btn.classList.toggle('active');
      if (onChange) onChange();
    });
    grid.appendChild(btn);
  });
}
// Collapsed-summary text for the profile modal's class + valgfag sections.
function updateClassModalSummaries() {
  const cs = document.getElementById('spClassSel');
  if (cs) cs.textContent = modalClass || 'ingen valgt';
  const es = document.getElementById('spElectiveSel');
  if (es) es.textContent = modalElectives.length ? modalElectives.join(', ') : 'ingen';
}
// Reflect the current theme on a segmented Auto/Lyst/Mørkt control.
function syncThemeSeg(container) {
  if (!container || !window.UPTheme) return;
  const p = UPTheme.get();
  container.querySelectorAll('.theme-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.themePref === p));
}
// Startside preference: 'hjem' (default), 'ukeplan', or 'last' (last-visited tab).
function getLanding() {
  const v = localStorage.getItem(LANDING_KEY);
  return (v === 'ukeplan' || v === 'last') ? v : 'hjem';
}
// The tab to actually open, resolving 'last' → the last-visited tab (up_last_tab).
function resolveLanding() {
  const l = getLanding();
  if (l !== 'last') return l;   // 'hjem' | 'ukeplan'
  const last = localStorage.getItem(TAB_KEY);
  return (last && ['hjem', 'ukeplan', 'fag', 'vurd'].includes(last)) ? last : 'hjem';
}

// The profile/settings modal (name · class · valgfag · tema). Opened by the class
// pill + the Profil button; the class modal's markup is reused for it.
function showClassModal() {
  modalClass = selectedClass;
  modalElectives = electives ? electives.slice() : [];
  document.getElementById('studentName').value = studentName;
  buildClassGridInto(document.getElementById('classModalGrid'),
    () => { document.getElementById('variantError').hidden = true; updateClassConfirm(); updateClassModalSummaries(); });
  buildElectiveGridInto(document.getElementById('electiveGrid'), updateClassModalSummaries);
  updateClassModalSummaries();

  const vInput = document.getElementById('variantInput');
  vInput.value = variantSuffix(variantCode);
  document.getElementById('variantError').hidden = true;
  document.querySelector('.variant-box').open = !!variantCode;
  vInput.oninput = () => { document.getElementById('variantError').hidden = true; };

  syncThemeSeg(document.getElementById('studentThemeSeg'));
  modalLanding = getLanding();
  document.getElementById('studentLandingSeg').querySelectorAll('.theme-seg-btn')
    .forEach(b => b.classList.toggle('active', b.dataset.landing === modalLanding));
  updateClassConfirm();
  rememberFocus();
  document.getElementById('classModalOverlay').classList.add('open');
  document.getElementById('classModal').classList.add('open');
  document.body.classList.add('scroll-locked');
  setTimeout(() => document.getElementById('studentName').focus(), 60);
}

function updateClassConfirm() {
  // A class is always required; the code is an optional add-on that only works
  // together with the chosen class.
  document.getElementById('classConfirm').disabled = !modalClass;
}

function confirmClassModal() {
  if (!modalClass) return;
  const suffix = document.getElementById('variantInput').value.trim();
  if (suffix) {
    if (!/^[A-Za-z0-9]{3,}$/.test(suffix)) {
      const err = document.getElementById('variantError');
      err.textContent = 'Ugyldig kode. Bruk bokstavene og tallene du fikk av læreren (f.eks. K7X9M).';
      err.hidden = false;
      return;
    }
    variantCode   = (modalClass + '-' + suffix).toUpperCase();
    selectedClass = modalClass;
    localStorage.setItem(VARIANT_KEY, variantCode);
  } else {
    variantCode = null;
    selectedClass = modalClass;
    localStorage.removeItem(VARIANT_KEY);
  }
  viewBase = false;   // a fresh code/class starts on the pupil's own plan
  localStorage.setItem(CLASS_KEY, selectedClass);
  electives = modalElectives.slice();
  localStorage.setItem(ELECTIVE_KEY, JSON.stringify(electives));
  studentName = document.getElementById('studentName').value.trim();
  if (studentName) localStorage.setItem(NAME_KEY, studentName); else localStorage.removeItem(NAME_KEY);
  if (modalLanding === 'ukeplan' || modalLanding === 'last') localStorage.setItem(LANDING_KEY, modalLanding);
  else localStorage.removeItem(LANDING_KEY);   // 'hjem' is the default → no key
  planData = [];           // drop any previous plan so the new one is fetched fresh
  planDataKey = null; dashReviewedKey = null;
  previewWeekKey = null;
  updateClassLabel();
  populateFagSubjects();
  closeClassModal();
  loadWeek();
}

function closeClassModal() {
  document.getElementById('classModalOverlay').classList.remove('open');
  document.getElementById('classModal').classList.remove('open');
  document.body.classList.remove('scroll-locked');
  restoreFocus();
}

// ─── First-run onboarding wizard (velkommen · navn · klasse · valgfag · mål) ───
// Mirrors the teacher journey (shared UPJourney bar + slide anim); localStorage
// only. Tentative choices live in modalClass/modalElectives/modalName until the
// finish step commits them (same keys the profile modal writes).
let sStep = 0, sDir = 'next';
const S_NODES = 5;
const S_PROGRESS = { 0: [1, 1], 1: [1, 2], 2: [2, 3], 3: [3, 4], 4: [5, 5] };
function sPara(cls, text) { const p = document.createElement('p'); p.className = cls; p.textContent = text; return p; }

function showStudentOnboarding() {
  sStep = 0; sDir = 'next';
  modalClass = selectedClass || null;
  modalElectives = electives ? electives.slice() : [];
  modalName = studentName || '';
  UPJourney.build(document.getElementById('sOnboardProgress'), S_NODES);
  rememberFocus();
  document.getElementById('sOnboardOverlay').classList.add('open');
  document.getElementById('sOnboardModal').classList.add('open');
  document.body.classList.add('scroll-locked');
  renderSStep();
}
function renderSStep() {
  const title = document.getElementById('sOnboardTitle');
  const body  = document.getElementById('sOnboardBody');
  const back  = document.getElementById('sOnboardBack');
  const next  = document.getElementById('sOnboardNext');
  body.innerHTML = '';
  back.disabled = sStep === 0;
  next.textContent = 'Neste';
  next.disabled = false;
  UPJourney.update(document.getElementById('sOnboardProgress'), S_PROGRESS[sStep][0], S_PROGRESS[sStep][1]);

  if (sStep === 0) {
    title.textContent = 'Velkommen til Ukeportalen!';
    body.appendChild(sPara('onboard-lead', 'Her ser du ukeplanen for klassen din – tema, lekser og vurderinger. Vi setter opp profilen din på noen få steg.'));
    body.appendChild(sPara('class-modal-hint', 'Alt du fyller inn lagres bare i denne nettleseren, på din egen enhet – ingenting sendes til noen.'));
  } else if (sStep === 1) {
    title.textContent = 'Hva heter du?';
    body.appendChild(sPara('class-modal-hint', 'Navnet vises bare på din egen enhet – det sendes ingen steder. Du kan hoppe over.'));
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'input'; inp.placeholder = 'Navnet ditt'; inp.value = modalName;
    inp.addEventListener('input', () => { modalName = inp.value; });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') sNext(); });
    body.appendChild(inp);
    setTimeout(() => inp.focus(), 80);
  } else if (sStep === 2) {
    title.textContent = 'Hvilken klasse går du i?';
    const grid = document.createElement('div'); grid.className = 'class-modal-grid';
    body.appendChild(grid);
    buildClassGridInto(grid, () => { next.disabled = !modalClass; });
    next.disabled = !modalClass;   // class is required to continue
  } else if (sStep === 3) {
    title.textContent = 'Hvilket valgfag og tilvalgsfag har du?';
    body.appendChild(sPara('class-modal-hint', 'Huk av valgfagene og tilvalgsfagene du har, så viser vi bare dine.'));
    const grid = document.createElement('div'); grid.className = 'class-modal-grid elective-grid';
    body.appendChild(grid);
    buildElectiveGridInto(grid);
  } else if (sStep === 4) {
    title.textContent = 'Alt klart!';
    const nm = (modalName || '').trim();
    body.appendChild(sPara('onboard-lead onboard-celebrate', '🎉 Klar' + (nm ? ', ' + nm : '') + '! Ukeplanen din er satt opp.'));
    next.textContent = 'Åpne ukeplanen';
    playSVictory();
  }
  playSEnter();
}
function sNext() {
  if (sStep >= 4) { completeStudentOnboarding(); return; }
  if (sStep === 2 && !modalClass) return;   // class required
  sDir = 'next'; sStep++; renderSStep();
}
function sBack() { if (sStep === 0) return; sDir = 'back'; sStep--; renderSStep(); }
function completeStudentOnboarding() {
  studentName = (modalName || '').trim();
  if (studentName) localStorage.setItem(NAME_KEY, studentName); else localStorage.removeItem(NAME_KEY);
  localStorage.setItem(ONBOARDED_KEY, '1');
  selectedClass = modalClass;
  variantCode = null; localStorage.removeItem(VARIANT_KEY);   // codes are entered later via the profile
  localStorage.setItem(CLASS_KEY, selectedClass);
  electives = modalElectives.slice();
  localStorage.setItem(ELECTIVE_KEY, JSON.stringify(electives));
  planData = []; previewWeekKey = null; planDataKey = null; dashReviewedKey = null;
  updateClassLabel();
  populateFagSubjects();
  closeStudentOnboarding();
  setTab(resolveLanding());
  loadWeek();
}
function closeStudentOnboarding() {
  document.getElementById('sOnboardOverlay').classList.remove('open');
  document.getElementById('sOnboardModal').classList.remove('open');
  document.body.classList.remove('scroll-locked');
  restoreFocus();
}
function playSEnter() {
  const b = document.getElementById('sOnboardBody');
  b.style.setProperty('--enter-x', sDir === 'back' ? '-22px' : '22px');
  b.classList.remove('onboard-anim');
  void b.offsetWidth;             // reflow so the animation replays each step
  b.classList.add('onboard-anim');
}
function playSVictory() { UPJourney.victory(document.getElementById('sOnboardProgress')); }

// ─── Rendering ────────────────────────────────────────────────

function render() {
  if (!selectedClass) return;
  updateDashBadge();
  if (currentTab === 'hjem') { renderDashboard(); return; }
  if (currentTab === 'fag')  { renderFag(); return; }
  if (currentTab === 'vurd') { renderCalendar(); return; }
  if (ukeplanView === 'dag') renderDayView();
  else renderWeekView();
}

// ─── Min uke (student dashboard) ──────────────────────────────
// A focused landing that tracks the week: a zero-safe lekse-completion meter with
// day/subject/week milestone celebrations, beskjeder stepped through one at a time
// (acknowledged in up_ack_beskjed), a "nytt denne uka" notice for lekser added since
// the last dashboard review (up_seen_lekser baseline), and this week's vurderinger.

function weekKey() { return planKey() + '|' + dateToWeek(weekMonday); }
function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } }
function writeJSON(key, obj) { try { localStorage.setItem(key, JSON.stringify(obj)); } catch {} }
function prefersReducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

// Visible lekser for the viewed week (each element = one checkable item).
function weekLekser() { return planData.filter(p => p.type === 'lekse' && p.description && subjectVisible(p.subject)); }
// This week's beskjeder (general elements). A stable key per element.
function weekBeskjeder() { return planData.filter(p => GENERAL_TYPES.includes(p.type) && p.description && subjectVisible(p.subject)); }
function beskjedKey(el) { return el.id || ('b:' + (el.type || '') + ':' + (el.subject || '') + ':' + (el.day || '') + ':' + el.description); }
function unreadBeskjeder() { const acked = readJSON(ACK_BESKJED_KEY); return weekBeskjeder().filter(p => !acked[beskjedKey(p)]); }

function updateDashBadge() {
  const b = document.getElementById('dashBadge');
  if (!b) return;
  const n = selectedClass ? unreadBeskjeder().length : 0;
  b.textContent = n; b.hidden = n === 0;
}

// Diff the week's lekser against the stored "seen" baseline, once per week-load.
function reviewNewLekser() {
  const key = weekKey();
  if (planDataKey !== key) { newLekseKeys = []; return; }   // data for this week not loaded yet
  if (dashReviewedKey === key) return;                      // already reviewed this load
  dashReviewedKey = key;
  dashLekseIdx = 0;                                         // fresh week → start the deck at the top
  dashRingPct = null;                                      // snap the ring on arrival, don't tween from another week
  { const c = weekDoneCount(); dashRingDoneKey = (c.total > 0 && c.doneN >= c.total) ? key : null; }
  const cur = weekLekser().map(doneKey);
  const store = readJSON(SEEN_LEKSER_KEY);
  const seen = Array.isArray(store[key]) ? store[key] : null;
  newLekseKeys = seen ? cur.filter(k => !seen.includes(k)) : [];   // first visit → nothing is "new"
  store[key] = seen ? [...new Set(seen.concat(cur))] : cur;
  writeJSON(SEEN_LEKSER_KEY, store);
  if (newLekseKeys.length) newLekserPending = true;   // announce once, as a modal on entry
  seedMilestones();   // don't fire confetti for progress already made before this load
}

function renderDashboard() {
  reviewNewLekser();
  updateDashBadge();
  const view = document.getElementById('dashboardView');
  view.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'dash-header';
  const h = document.createElement('h2'); h.className = 'dash-greeting';
  h.textContent = 'Hei' + (studentName ? ', ' + studentName : '') + '!';
  const wk = document.createElement('p'); wk.className = 'dash-week';
  const thisWeek = dateToWeek(weekMonday) === dateToWeek(mondayOf(new Date()));
  wk.textContent = 'Uke ' + getWeekNumber(weekMonday) + (thisWeek ? ' – denne uka' : '');
  header.appendChild(h); header.appendChild(wk);
  view.appendChild(header);

  if (planDataKey !== weekKey()) {   // still loading this week's data
    const p = document.createElement('p'); p.className = 'dash-loading'; p.textContent = 'Laster …';
    view.appendChild(p);
    return;
  }

  const be = buildDashBeskjedEvents();
  if (be) view.appendChild(be);
  view.appendChild(buildLekseDeck());
  const vwrap = buildDashVurd();
  if (vwrap) view.appendChild(vwrap);

  checkMilestones();
  if (newLekserPending) { newLekserPending = false; showNewLekserDialog(); }
}

// Announce lekser added since the pupil's last visit this week, as a modal they
// dismiss with «Skjønner» (the items are also tagged «nytt» in the list).
function showNewLekserDialog() {
  const items = weekLekser().filter(el => newLekseKeys.includes(doneKey(el)));
  if (!items.length) return;
  buildUiDialog({
    title: 'Nytt denne uka',
    render(ctx) {
      const p = document.createElement('p');
      p.className = 'ui-dialog-message';
      p.textContent = (items.length === 1 ? 'Det har kommet 1 ny lekse' : 'Det har kommet ' + items.length + ' nye lekser')
        + ' siden sist du var her:';
      ctx.body.appendChild(p);
      const ul = document.createElement('ul');
      ul.className = 'dash-new-list';
      items.forEach(el => {
        const li = document.createElement('li'); li.className = 'rich-content';
        const day = parseDays(el.day)[0];
        const lead = (el.subject ? '<strong>' + escapeHtml(el.subject) + '</strong>' : '') + (day ? ' (' + DAY_LABEL[day] + ')' : '');
        li.innerHTML = (lead ? lead + ': ' : '') + sanitizeHtml(el.description || '');
        ul.appendChild(li);
      });
      ctx.body.appendChild(ul);
    },
    buttons: [{ label: 'Skjønner', className: 'btn-primary', primary: true, value: true }],
  });
}

// One beskjed at a time, with Neste (cycle) + Skjønner (acknowledge).
function buildBeskjedStepper() {
  const unread = unreadBeskjeder();
  if (!unread.length) return null;
  if (dashBeskjedIdx >= unread.length) dashBeskjedIdx = 0;
  const el = unread[dashBeskjedIdx];
  const card = document.createElement('div');
  card.className = 'dash-beskjed';
  const head = document.createElement('div'); head.className = 'dash-beskjed-head';
  const icon = document.createElement('span'); icon.className = 'dash-beskjed-icon'; icon.textContent = GENERAL_ICON[el.type] || '📌';
  const count = document.createElement('span'); count.className = 'dash-beskjed-count';
  count.textContent = 'Beskjed ' + (dashBeskjedIdx + 1) + ' av ' + unread.length;
  head.appendChild(icon); head.appendChild(count);
  card.appendChild(head);
  const body = document.createElement('div'); body.className = 'dash-beskjed-body rich-content';
  body.innerHTML = generalPrefix(el) + sanitizeHtml(el.description);
  card.appendChild(body);
  const actions = document.createElement('div'); actions.className = 'dash-beskjed-actions';
  if (unread.length > 1) {
    const next = document.createElement('button');
    next.type = 'button'; next.className = 'btn btn-ghost btn-tiny';
    next.textContent = 'Neste ›';
    next.addEventListener('click', () => { dashBeskjedIdx = (dashBeskjedIdx + 1) % unread.length; renderDashboard(); });
    actions.appendChild(next);
  }
  const ok = document.createElement('button');
  ok.type = 'button'; ok.className = 'btn btn-primary btn-tiny';
  ok.textContent = 'Skjønner';
  ok.addEventListener('click', () => {
    const acked = readJSON(ACK_BESKJED_KEY); acked[beskjedKey(el)] = true; writeJSON(ACK_BESKJED_KEY, acked);
    dashBeskjedIdx = 0; renderDashboard();
  });
  actions.appendChild(ok);
  card.appendChild(actions);
  return card;
}

// Beskjeder dismissed this week, tucked into a collapsible so they can be found
// – or un-dismissed – again (mirrors the "✓ N gjort" lekse drawer).
function buildBeskjedArchive() {
  const acked = readJSON(ACK_BESKJED_KEY);
  const dismissed = weekBeskjeder().filter(p => acked[beskjedKey(p)]);
  if (!dismissed.length) return null;
  const det = document.createElement('details'); det.className = 'dash-beskjed-archive';
  const sum = document.createElement('summary'); sum.className = 'dash-archive-sum';
  sum.textContent = 'Tidligere beskjeder (' + dismissed.length + ')';
  det.appendChild(sum);
  dismissed.forEach(el => {
    const row = document.createElement('div'); row.className = 'dash-archive-item';
    const icon = document.createElement('span'); icon.className = 'dash-archive-icon';
    icon.textContent = GENERAL_ICON[el.type] || '📌';
    const body = document.createElement('div'); body.className = 'dash-archive-body rich-content';
    body.innerHTML = generalPrefix(el) + sanitizeHtml(el.description);
    const undo = document.createElement('button');
    undo.type = 'button'; undo.className = 'link-btn dash-archive-undo';
    undo.textContent = 'Vis igjen';
    undo.title = 'Flytt beskjeden tilbake øverst';
    undo.addEventListener('click', () => {
      const a = readJSON(ACK_BESKJED_KEY); delete a[beskjedKey(el)]; writeJSON(ACK_BESKJED_KEY, a);
      dashBeskjedIdx = 0; renderDashboard();
    });
    row.appendChild(icon); row.appendChild(body); row.appendChild(undo);
    det.appendChild(row);
  });
  return det;
}

// The lekse deck: one remaining task at a time with a progress ring, cycle it
// with ‹ ›, and "✓ Gjort" advances to the next. Done tasks tuck into a
// collapsible below so the screen only shows what's left – less to decide at
// once. Zero-safe; milestones/celebrations still fire from checkMilestones().
function buildLekseDeck() {
  const wrap = document.createElement('div');
  wrap.className = 'dash-section dash-deck';
  const lekser = weekLekser();
  const done = getDoneSet();
  const total = lekser.length;

  if (total === 0) {
    const p = document.createElement('p');
    p.className = 'dash-nolekser';
    p.textContent = 'Ingen lekser denne uka 🎉';
    wrap.appendChild(p);
    return wrap;
  }

  const doneItems = lekser.filter(el => done[doneKey(el)]);
  const todo = lekser.filter(el => !done[doneKey(el)]).sort(byDay);
  const doneN = doneItems.length;

  // Whether this render is the fresh completion (checked BEFORE buildDeckHead,
  // which consumes the same once-only gate for the ring finale).
  const freshComplete = !todo.length && !prefersReducedMotion() && dashRingDoneKey !== weekKey();

  wrap.appendChild(buildDeckHead(doneN, total));

  if (!todo.length) {
    const clear = document.createElement('div');
    clear.className = 'dash-deck-allclear' + (freshComplete ? ' dash-deck-anim' : '');
    clear.innerHTML = '<span class="dash-deck-check">✓</span> Alt gjort denne uka!';
    wrap.appendChild(clear);
  } else {
    if (dashLekseIdx >= todo.length) dashLekseIdx = todo.length - 1;
    if (dashLekseIdx < 0) dashLekseIdx = 0;
    wrap.appendChild(buildLekseCard(todo[dashLekseIdx]));
    if (todo.length > 1) wrap.appendChild(buildDeckNav(todo.length));
  }

  if (doneN) wrap.appendChild(buildDoneCollapsible(doneItems));
  return wrap;
}

// Progress ring + "N igjen" headline.
function buildDeckHead(doneN, total) {
  const head = document.createElement('div');
  head.className = 'dash-deck-head';
  head.appendChild(buildProgressRing(doneN, total));
  const txt = document.createElement('div'); txt.className = 'dash-deck-headtext';
  const left = total - doneN;
  const big = document.createElement('div'); big.className = 'dash-deck-left';
  big.textContent = left === 0 ? 'Alt gjort!' : (left + (left === 1 ? ' lekse igjen' : ' lekser igjen'));
  const sub = document.createElement('div'); sub.className = 'dash-deck-sub';
  // Honest progress line; the ring itself runs one step ahead (endowed progress).
  sub.textContent = doneN === 0 ? 'Kom i gang!' : (doneN + ' av ' + total + ' gjort');
  txt.appendChild(big); txt.appendChild(sub);
  head.appendChild(txt);
  return head;
}

// Endowed progress: a flat 5% head start so the ring never starts at 0% – just
// enough to signify that opening the ukeplan is already a bit of progress (the
// endowed-progress effect nudges completion). Fixed, so a small week doesn't
// look half-done; real task progress fills the remaining 95% up to a true 100%.
// The "N av M gjort" line above stays literally true; only the ring is endowed.
const ENDOW_BASE = 0.05;
function endowedPct(doneN, total) { return ENDOW_BASE + (1 - ENDOW_BASE) * (total ? doneN / total : 0); }

const SVG_NS = 'http://www.w3.org/2000/svg';
let dashRingPct = null;       // last endowed pct drawn (so the ring tweens between states)
let dashRingDoneKey = null;   // weekKey whose completion finale has already played
function ringCircle(cls, r) {
  const e = document.createElementNS(SVG_NS, 'circle');
  e.setAttribute('class', cls);
  e.setAttribute('cx', '23'); e.setAttribute('cy', '23'); e.setAttribute('r', String(r));
  return e;
}
// The progress ring. It TWEENS from its previous fill to the new one (each render
// makes a fresh SVG, so the Web Animations API drives the fill – a CSS transition
// wouldn't fire on a brand-new element). On real completion it plays a finale: a
// second colour sweeps the ring and a checkmark draws in place of the "%".
function buildProgressRing(doneN, total) {
  const complete = total > 0 && doneN >= total;
  const target = endowedPct(doneN, total);
  const reduce = prefersReducedMotion();
  const r = 19, c = 2 * Math.PI * r, key = weekKey();
  const finale = complete && !reduce && dashRingDoneKey !== key;   // play the finale only on fresh completion
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'dash-ring' + (complete ? ' is-complete' : '') + (finale ? ' finale' : ''));
  svg.setAttribute('viewBox', '0 0 46 46');
  svg.appendChild(ringCircle('dash-ring-track', r));

  const prog = ringCircle('dash-ring-prog', r);
  prog.setAttribute('stroke-dasharray', c.toFixed(1));
  prog.setAttribute('stroke-dashoffset', (c * (1 - target)).toFixed(1));
  prog.setAttribute('transform', 'rotate(-90 23 23)');
  svg.appendChild(prog);
  const from = dashRingPct == null ? target : dashRingPct;
  if (!reduce && from !== target) {
    prog.animate([{ strokeDashoffset: c * (1 - from) }, { strokeDashoffset: c * (1 - target) }],
      { duration: 500, easing: 'ease' });
  }
  dashRingPct = target;

  if (complete) {
    dashRingDoneKey = key;
    // Second colour sweeping over the ring.
    const cel = ringCircle('dash-ring-cel', r);
    cel.setAttribute('stroke-dasharray', c.toFixed(1));
    cel.setAttribute('stroke-dashoffset', '0');
    cel.setAttribute('transform', 'rotate(-90 23 23)');
    svg.appendChild(cel);
    if (finale) cel.animate([{ strokeDashoffset: c }, { strokeDashoffset: 0 }],
      { duration: 650, easing: 'ease-out', delay: 250, fill: 'backwards' });
    // Checkmark drawn in place of the "%".
    const check = document.createElementNS(SVG_NS, 'path');
    check.setAttribute('class', 'dash-ring-check');
    check.setAttribute('d', 'M16 23.5 L21 28.5 L31 16.5');
    check.setAttribute('pathLength', '1');
    check.setAttribute('stroke-dasharray', '1');
    check.setAttribute('stroke-dashoffset', '0');
    svg.appendChild(check);
    if (finale) check.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
      { duration: 380, easing: 'ease', delay: 720, fill: 'backwards' });
  } else {
    if (dashRingDoneKey === key) dashRingDoneKey = null;   // re-arm the finale after un-complete
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'dash-ring-label');
    label.setAttribute('x', '23'); label.setAttribute('y', '23');
    label.setAttribute('text-anchor', 'middle'); label.setAttribute('dominant-baseline', 'central');
    label.textContent = Math.round(target * 100) + '%';
    svg.appendChild(label);
  }
  return svg;
}

// A calm, deterministic accent per subject (earthy palette; works in both themes).
const SUBJECT_ACCENTS = ['#4f9d8e', '#c06a44', '#c99a3b', '#5b7fb0', '#9b6a97', '#7a9a5b', '#b5716a', '#5aa0a8'];
function subjectAccent(subject) {
  if (!subject) return 'var(--primary)';
  let h = 0; for (let i = 0; i < subject.length; i++) h = (h * 31 + subject.charCodeAt(i)) >>> 0;
  return SUBJECT_ACCENTS[h % SUBJECT_ACCENTS.length];
}

// One remaining lekse as a focused card.
function buildLekseCard(el) {
  const card = document.createElement('div');
  card.className = 'dash-lekse-card dash-deck-anim';
  card.style.setProperty('--subj', subjectAccent(el.subject));
  const top = document.createElement('div'); top.className = 'dash-lc-top';
  const dot = document.createElement('span'); dot.className = 'dash-lc-dot'; top.appendChild(dot);
  const subj = document.createElement('span'); subj.className = 'dash-lc-subj';
  subj.textContent = el.subject || 'Lekse'; top.appendChild(subj);
  const day = parseDays(el.day)[0];
  if (day) { const d = document.createElement('span'); d.className = 'dash-lc-day'; d.textContent = DAY_LABEL[day]; top.appendChild(d); }
  if (newLekseKeys.includes(doneKey(el))) { const n = document.createElement('span'); n.className = 'dash-lc-new'; n.textContent = 'nytt'; top.appendChild(n); }
  card.appendChild(top);

  const body = document.createElement('div'); body.className = 'dash-lc-body rich-content';
  body.innerHTML = sanitizeHtml(el.description || '');
  card.appendChild(body);

  const act = document.createElement('button');
  act.type = 'button'; act.className = 'btn btn-primary dash-lc-done';
  act.textContent = 'Merk som gjort';
  // Marking done drops this card from `todo`; the same index shows the next one.
  // If it's the LAST remaining task, animate the card out first, then reveal the
  // completed state – mid-list ones already feel animated via the incoming card.
  act.addEventListener('click', () => {
    const done = getDoneSet();
    const lastLeft = weekLekser().filter(e => !done[doneKey(e)] && doneKey(e) !== doneKey(el)).length === 0;
    if (lastLeft && !prefersReducedMotion()) {
      act.disabled = true;
      card.classList.add('dash-card-exit');
      setTimeout(() => { toggleDone(doneKey(el), true); renderDashboard(); }, 240);
    } else {
      toggleDone(doneKey(el), true); renderDashboard();
    }
  });
  card.appendChild(act);
  return card;
}

// Cycle controls: static ‹ › with a fixed "n / m" counter between (no per-task
// dots – those would change count and drift the arrows as tasks are completed).
function buildDeckNav(count) {
  const nav = document.createElement('div'); nav.className = 'dash-deck-nav';
  const mk = (txt, label, delta) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'dash-deck-arrow'; b.textContent = txt;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', () => { dashLekseIdx = (dashLekseIdx + delta + count) % count; renderDashboard(); });
    return b;
  };
  nav.appendChild(mk('‹', 'Forrige lekse', -1));
  const c = document.createElement('span'); c.className = 'dash-deck-counter'; c.textContent = (dashLekseIdx + 1) + ' / ' + count;
  nav.appendChild(c);
  nav.appendChild(mk('›', 'Neste lekse', 1));
  return nav;
}

// Completed lekser, tucked into a collapsible so they're out of the way but can
// be un-checked (mis-click recovery).
function buildDoneCollapsible(items) {
  const det = document.createElement('details'); det.className = 'dash-done-box';
  const sum = document.createElement('summary'); sum.className = 'dash-done-sum';
  sum.textContent = '✓ ' + items.length + ' gjort';
  det.appendChild(sum);
  const ul = document.createElement('ul'); ul.className = 'homework-list dash-done-list';
  items.slice().sort(byDay).forEach(el => {
    const li = document.createElement('li'); li.className = 'homework-item done';
    const lbl = document.createElement('label'); lbl.className = 'hw-label';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'hw-check'; cb.checked = true;
    cb.addEventListener('change', () => { toggleDone(doneKey(el), false); renderDashboard(); });
    const span = document.createElement('span'); span.className = 'hw-text rich-content';
    const pre = el.subject ? '<strong>' + escapeHtml(el.subject) + ':</strong> ' : '';
    span.innerHTML = pre + sanitizeHtml(el.description || '');
    lbl.appendChild(cb); lbl.appendChild(span); li.appendChild(lbl); ul.appendChild(li);
  });
  det.appendChild(ul);
  return det;
}

function buildDashVurd() {
  const vs = currentWeekVurd();
  if (!vs.length) return null;
  const wrap = document.createElement('div'); wrap.className = 'dash-section dash-vurd';
  const h = document.createElement('h3'); h.className = 'dash-section-title'; h.textContent = 'Vurderinger denne uka';
  wrap.appendChild(h);
  vs.forEach(v => wrap.appendChild(buildAssessmentCard(v, { showDay: true, hideClasses: true })));
  return wrap;
}

// One event line (★ label: description [range]).
function buildEventRow(row) {
  const { ev, tier, label } = row;
  const line = document.createElement('div');
  line.className = 'event-item tier-' + tier;
  const star = document.createElement('span'); star.className = 'event-item-star'; star.textContent = '★'; line.appendChild(star);
  const body = document.createElement('span'); body.className = 'event-item-body';
  const range = ev.dateTo && ev.dateTo !== ev.date ? ' (' + shortDate(ev.date) + '–' + shortDate(ev.dateTo) + ')' : '';
  body.innerHTML = '<strong>' + escapeHtml(label) + ':</strong> ' + escapeHtml(ev.description || 'Hendelse') + escapeHtml(range);
  line.appendChild(body);
  return line;
}
// Append rows; collapse the "senere" tier behind a details when there are >2.
function appendEventRows(wrap, rows) {
  const near = rows.filter(r => r.tier !== 'senere');
  const senere = rows.filter(r => r.tier === 'senere');
  near.forEach(r => wrap.appendChild(buildEventRow(r)));
  if (!senere.length) return;
  if (senere.length <= 2) { senere.forEach(r => wrap.appendChild(buildEventRow(r))); return; }
  const det = document.createElement('details'); det.className = 'events-senere';
  const sum = document.createElement('summary'); sum.className = 'events-senere-sum';
  sum.textContent = 'Senere (' + senere.length + ')';
  det.appendChild(sum);
  senere.forEach(r => det.appendChild(buildEventRow(r)));
  wrap.appendChild(det);
}

// Progress milestones over the week's total lekser: first done, halfway, and all
// done. The first two get a small confetti burst, finishing everything gets a
// bigger one. Returns [id, reached, level] triples (shared by seed + check).
function milestoneLevels(total, doneN) {
  const half = Math.ceil(total / 2);
  return [
    ['first', doneN >= 1, 'small'],
    ['half',  half > 1 && doneN >= half, 'small'],   // skip when half === first (total ≤ 2)
    ['all',   doneN >= total, 'big'],
  ];
}
function weekDoneCount() {
  const lekser = weekLekser();
  const done = getDoneSet();
  return { total: lekser.length, doneN: lekser.filter(el => done[doneKey(el)]).length };
}
// On a fresh week-load, mark already-reached milestones as celebrated WITHOUT
// firing, so returning mid-week doesn't set off confetti on arrival.
function seedMilestones() {
  const { total, doneN } = weekDoneCount();
  if (!total) return;
  const key = weekKey();
  const store = readJSON(CELEBRATED_KEY);
  const cel = store[key] || {};
  milestoneLevels(total, doneN).forEach(([id, reached]) => { if (reached) cel[id] = 1; });
  store[key] = cel; writeJSON(CELEBRATED_KEY, store);
}
// Fire once per newly-reached milestone. A milestone that becomes un-reached
// (e.g. a task un-checked or a new lekse added) is cleared so it can re-fire.
// Only the biggest newly-reached level animates.
function checkMilestones() {
  const { total, doneN } = weekDoneCount();
  if (!total) return;
  const key = weekKey();
  const store = readJSON(CELEBRATED_KEY);
  const cel = store[key] || {};
  const rank = { small: 1, big: 2 };
  const MSG = { first: 'Du er i gang!', half: 'Over halvveis!', all: 'Du er ferdig!' };
  let fired = null, firedId = null;
  milestoneLevels(total, doneN).forEach(([id, reached, level]) => {
    if (reached && !cel[id]) { cel[id] = 1; if (!fired || rank[level] > rank[fired]) { fired = level; firedId = id; } }
    else if (!reached && cel[id]) { delete cel[id]; }
  });
  store[key] = cel; writeJSON(CELEBRATED_KEY, store);
  if (fired) { playCelebration(fired); showToast(MSG[firedId], { duration: firedId === 'all' ? 3500 : 2600, celebrate: true }); }
}

// A confetti burst – bigger and longer for the whole-week finish. Reduced-motion
// → none (the "✓ Alt gjort" line already gives static feedback).
function playCelebration(level) {
  if (prefersReducedMotion()) return;
  const layer = document.createElement('div');
  layer.className = 'celebrate-layer';
  const big = level === 'big';
  const n = big ? 44 : 16;
  const colors = ['#1e5c55', '#b5502f', '#f4c04e', '#4f9d8e', '#e88b5a'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('span');
    p.className = 'confetti';
    p.style.setProperty('--x', (Math.random() * 100) + 'vw');
    p.style.setProperty('--dx', (Math.random() * 160 - 80) + 'px');
    p.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
    p.style.setProperty('--delay', (Math.random() * (big ? 0.25 : 0.15)).toFixed(2) + 's');
    p.style.setProperty('--dur', ((big ? 1.0 : 0.9) + Math.random() * 0.7).toFixed(2) + 's');
    p.style.background = colors[i % colors.length];
    layer.appendChild(p);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), big ? 2500 : 1600);
}

// Lightweight toast (the student page's #toast lives in index.html; styled by
// .toast/.toast.show in styles.css). Used for milestone messages.
function showToast(message, opts = {}) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  const msg = toast.querySelector('.toast-msg');
  if (msg) msg.textContent = message;
  toast.classList.toggle('toast-celebrate', !!opts.celebrate);
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(toast._timer);
  toast._timer = setTimeout(hideToast, opts.duration ?? 3000);
}
function hideToast() {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.classList.remove('show');
  setTimeout(() => { toast.hidden = true; }, 250);
}

// ─── Fag-progresjon tab (one subject, week by week) ───────────

async function loadAllPlan(opts = {}) {
  const { skipCache = false } = opts;
  if (!skipCache) {
    const ts = localStorage.getItem(ALL_TS_KEY);
    if (ts && Date.now() - Number(ts) < CACHE_TTL) {
      try { allPlanData = JSON.parse(localStorage.getItem(ALL_CACHE_KEY)) || []; } catch { allPlanData = []; }
      renderFag();
      return;
    }
  }
  showBgLoading();
  try {
    const res = await fetch(`${SCRIPT_URL}?action=public`);
    const data = await res.json();
    if (Array.isArray(data)) {
      allPlanData = data;
      localStorage.setItem(ALL_CACHE_KEY, JSON.stringify(data));
      localStorage.setItem(ALL_TS_KEY, String(Date.now()));
    }
  } catch { /* keep whatever we have */ }
  hideBgLoading();
  renderFag();
}

function renderFag() {
  const board = document.getElementById('fagBoard');
  if (!board) return;
  board.innerHTML = '';
  const subject = document.getElementById('fagSubject').value;

  const plan = allPlanData.filter(p => p.subject === subject && classMatches(p.classes, contentClassFor(subject)));
  const vurd = vurdData.filter(v => v.date && v.subject === subject && classMatches(v.classes, selectedClass));

  const weeks = new Set();
  plan.forEach(p => { if (p.week) weeksBetween(p.week, p.weekTo || p.week).forEach(w => weeks.add(w)); });
  vurd.forEach(v => weeks.add(dateToWeek(new Date(v.date))));
  const sorted = [...weeks].sort();

  if (!sorted.length) {
    fillWeekSelect('fagFrom', [], null);
    fillWeekSelect('fagTo', [], null);
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Ingen plan registrert i ' + subject + ' for ' + selectedClass + ' ennå.';
    board.appendChild(p);
    return;
  }

  // Week range filter (fra uke … til uke)
  if (!fagFrom || sorted.indexOf(fagFrom) === -1) fagFrom = sorted[0];
  if (!fagTo   || sorted.indexOf(fagTo)   === -1) fagTo   = sorted[sorted.length - 1];
  if (fagFrom > fagTo) { const t = fagFrom; fagFrom = fagTo; fagTo = t; }
  fillWeekSelect('fagFrom', sorted, fagFrom);
  fillWeekSelect('fagTo', sorted, fagTo);
  const visible = sorted.filter(w => w >= fagFrom && w <= fagTo);

  const wrap = document.createElement('div');
  wrap.className = 'board-wrap';
  const table = document.createElement('table');
  table.className = 'plan-table fag-table';
  const thead = table.createTHead();
  const hr = thead.insertRow();
  ['Uke', 'Tema og læringsmål', 'Ressurser', 'Lekser', 'Vurdering'].forEach(h => { const th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
  const tbody = table.createTBody();
  const nowWeek = dateToWeek(mondayOf(new Date()));

  visible.forEach(wk => {
    const monday = weekStringToMonday(wk);
    const goals = plan.filter(p => p.type === 'læringsmål' && inWeek(p, wk)).map(p => p.description).filter(Boolean);
    const resources = plan.filter(p => p.type === 'ressurs' && inWeek(p, wk)).map(p => p.description).filter(Boolean);
    const hw    = plan.filter(p => p.type === 'lekse' && p.description && inWeek(p, wk)).slice().sort(byDay);
    const wv    = vurd.filter(v => dateToWeek(new Date(v.date)) === wk).map(v => ({ ...v, day: dayOf(new Date(v.date)) }));

    const tr = tbody.insertRow();
    const wc = tr.insertCell();
    wc.className = 'prog-week' + (wk === nowWeek ? ' is-now' : '');
    wc.innerHTML = 'Uke ' + getWeekNumber(monday) + '<span class="prog-week-range">' + formatWeekRange(monday, addDays(monday, 4)) + '</span>';

    // data-label drives a per-cell heading on mobile (the table stacks there).
    const gc = tr.insertCell();
    gc.dataset.label = 'Tema og læringsmål';
    if (goals.length) { gc.className = 'rich-content'; gc.innerHTML = goals.map(sanitizeHtml).join('<br>'); }
    else { gc.className = 'cell-empty'; gc.textContent = '–'; }

    const rc = tr.insertCell();
    rc.dataset.label = 'Ressurser';
    if (resources.length) { rc.className = 'rich-content'; rc.innerHTML = resources.map(sanitizeHtml).join('<br>'); }
    else { rc.className = 'cell-empty'; rc.textContent = '–'; }

    const hc = tr.insertCell();
    hc.dataset.label = 'Lekser';
    if (hw.length) {
      hw.forEach(h => {
        const d = document.createElement('div');
        d.className = 'rich-content';
        const dp = (h.day && DAY_LABEL[h.day]) ? '<strong>' + DAY_LABEL[h.day] + ':</strong> ' : '';
        d.innerHTML = dp + sanitizeHtml(h.description || '');
        hc.appendChild(d);
      });
    } else { hc.className = 'cell-empty'; hc.textContent = '–'; }

    const vc = tr.insertCell();
    vc.dataset.label = 'Vurdering';
    vc.className = 'cell-vurd';
    if (wv.length) {
      wv.forEach(v => {
        const tag = document.createElement('span');
        tag.className = 'vurd-tag';
        const dot = document.createElement('span'); dot.className = 'vurd-dot'; tag.appendChild(dot);
        tag.appendChild(document.createTextNode((v.day && DAY_LABEL[v.day] ? DAY_LABEL[v.day] + ': ' : '') + (v.description || v.notes || 'Vurdering')));
        vc.appendChild(tag);
      });
    } else { vc.classList.add('cell-empty'); vc.textContent = '–'; }
  });

  wrap.appendChild(table);
  board.appendChild(wrap);
}

// Assessments for the current class + week, with a derived weekday.
function currentWeekVurd() {
  const week = dateToWeek(weekMonday);
  return vurdData
    .filter(v => v.date && dateToWeek(new Date(v.date)) === week && classMatches(v.classes, selectedClass) && subjectVisible(v.subject))
    .map(v => ({ ...v, day: dayOf(new Date(v.date)) }));
}

function renderWeekView() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  const weekVurd = currentWeekVurd();
  board.appendChild(buildWeekStrip(weekVurd));
  const be = buildBeskjedEvents();
  if (be) board.appendChild(be);
  board.appendChild(buildSubjectBoard(weekVurd));
}

function renderDayView() {
  if (selectedDayIndex === 4) ensureNextWeekData();   // Friday previews next Monday
  const board = document.getElementById('board');
  board.innerHTML = '';
  const weekVurd = currentWeekVurd();
  board.appendChild(buildWeekStrip(weekVurd));
  board.appendChild(buildDayDetail(selectedDayIndex, weekVurd));
}

// Everything for one weekday, shown inline (replaces the old slide-in panel).
function buildDayDetail(i, weekVurd) {
  const wrap   = document.createElement('div');
  wrap.className = 'day-detail';
  const date   = addDays(weekMonday, i);
  const dayKey = DAYS[i];
  const iso    = toISODate(date);

  const head = document.createElement('h2');
  head.className = 'day-detail-title';
  head.textContent = formatDateLong(date);
  wrap.appendChild(head);

  const sch = schoolDays[iso];
  if (sch) wrap.appendChild(buildSchoolDayCard(sch));

  // Calendar events this day (idrettsdag, leirskole …) – folded into the
  // "Beskjeder og praktisk" section below.
  const dayEvents = eventsOnDate(iso);

  // Vurderinger that day
  const dayVurd = weekVurd.filter(v => v.day === dayKey);
  if (dayVurd.length) {
    const sec = daySection('Vurderinger');
    dayVurd.forEach(v => sec.appendChild(buildAssessmentCard(v)));
    wrap.appendChild(sec);
  }

  // Lekser that day (with check-off). Multi-day aware; whole-week lekser
  // (no day set) show every day.
  const dayHw = planData.filter(p => p.type === 'lekse' && p.description && subjectVisible(p.subject) &&
    (parseDays(p.day).includes(dayKey) || parseDays(p.day).length === 0));
  if (dayHw.length) {
    const sec = daySection('Lekser');
    sec.appendChild(buildHomeworkList(dayHw, 'subject'));
    wrap.appendChild(sec);
  }

  // Beskjeder / praktisk: this day's items + week-general (no day) ones,
  // PLUS a heads-up for items tied to the next school day ("vis dagen før").
  // Next school day: Mon–Thu → the next weekday this week; Fri → next Monday
  // (which lives in the following week, see previewWeekData).
  const isGeneral = p => GENERAL_TYPES.includes(p.type) && p.description && subjectVisible(p.subject);
  const dayGeneral = planData.filter(p => isGeneral(p) &&
    (parseDays(p.day).includes(dayKey) || parseDays(p.day).length === 0));

  const shownIds = new Set(dayGeneral.map(p => p.id).filter(Boolean));
  let preview;
  if (i < 4) {
    const nextKey = DAYS[i + 1];
    preview = planData.filter(p => isGeneral(p) && parseDays(p.day).includes(nextKey));
  } else {
    const nextWeek = dateToWeek(addDays(weekMonday, 7));
    preview = previewWeekData.filter(p => isGeneral(p) && classMatches(p.classes, planKey()) &&
      parseDays(p.day).includes('man') && weeksBetween(p.week, p.weekTo || p.week).includes(nextWeek));
  }
  // Don't repeat an item that's already shown as today's (multi-day elements).
  preview = preview.filter(p => !p.id || !shownIds.has(p.id));

  // One "Beskjeder og praktisk" section holding this day's calendar events
  // (idrettsdag …) up top, then the day's own beskjeder, then next-school-day
  // items in a muted, clearly-separated "Til i morgen" block.
  let sec = null;
  const ensureBeskjedSec = () => {
    if (!sec) { sec = daySection('Beskjeder og praktisk'); wrap.appendChild(sec); }
    return sec;
  };
  if (dayEvents.length) {
    ensureBeskjedSec();
    dayEvents.forEach(ev => sec.appendChild(buildEventCard(ev)));
  }
  const gsToday = buildGeneralSection(dayGeneral);
  if (gsToday) { ensureBeskjedSec(); sec.appendChild(gsToday); }
  if (preview.length) {
    ensureBeskjedSec();
    const box = document.createElement('div');
    box.className = 'day-heads-up';
    const lab = document.createElement('div');
    lab.className = 'day-heads-up-label';
    lab.textContent = i < 4 ? 'Til i morgen' : 'Til neste skoledag';
    box.appendChild(lab);
    const gsNext = buildGeneralSection(preview);
    if (gsNext) box.appendChild(gsNext);
    sec.appendChild(box);
  }

  if (!sch && !dayEvents.length && !dayVurd.length && !dayHw.length && !dayGeneral.length && !preview.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = variantCode
      ? 'Finner ingenting her. Har du skrevet koden riktig?'
      : 'Ingenting registrert for denne dagen.';
    wrap.appendChild(empty);
  }
  return wrap;
}

function daySection(title) {
  const sec = document.createElement('section');
  sec.className = 'day-section';
  const h = document.createElement('h3');
  h.className = 'day-section-title';
  h.textContent = title;
  sec.appendChild(h);
  return sec;
}

function buildAssessmentCard(v, opts = {}) {
  const card = document.createElement('div');
  card.className = 'assessment-card';
  const subject = document.createElement('div');
  subject.className = 'ac-subject';
  subject.textContent = v.subject || 'Vurdering';
  card.appendChild(subject);
  // Min uke shows the weekday it falls on instead of the class(es).
  if (opts.showDay && v.date) {
    const day = document.createElement('div');
    day.className = 'ac-day';
    day.textContent = capitalizeFirst(isoToDate(v.date).toLocaleDateString('no', { weekday: 'long', day: 'numeric', month: 'short' }));
    card.appendChild(day);
  }
  if (v.classes && !opts.hideClasses) {
    const cls = document.createElement('div');
    cls.className = 'ac-classes';
    cls.textContent = v.classes;
    card.appendChild(cls);
  }
  if (v.description || v.notes) {
    const desc = document.createElement('div');
    desc.className = 'ac-desc';
    desc.textContent = v.description || v.notes;
    card.appendChild(desc);
  }
  if (v.teacher) {
    const t = document.createElement('div');
    t.className = 'ac-teacher';
    t.textContent = v.teacher;
    card.appendChild(t);
  }
  return card;
}

// Mon–Fri strip with dates, school-calendar tint and assessment dots.
function buildWeekStrip(weekVurd) {
  const strip = document.createElement('div');
  strip.className = 'week-strip';

  for (let i = 0; i < 5; i++) {
    const date    = addDays(weekMonday, i);
    const iso     = toISODate(date);
    const dayKey  = DAYS[i];
    const sch     = schoolDays[iso];
    const dayVurd = weekVurd.filter(v => v.day === dayKey);

    const cell = document.createElement('div');
    cell.className = 'strip-day';
    if (iso === toISODate(new Date())) cell.classList.add('today');
    if (sch) cell.classList.add('school-' + sch.type);
    if (ukeplanView === 'dag' && i === selectedDayIndex) cell.classList.add('selected');

    const name = document.createElement('span');
    name.className = 'strip-day-name';
    name.textContent = DAY_LABEL[dayKey];
    cell.appendChild(name);

    const num = document.createElement('span');
    num.className = 'strip-day-num';
    num.textContent = date.getDate() + '.';
    cell.appendChild(num);

    if (sch) {
      const tag = document.createElement('span');
      tag.className = 'strip-day-tag';
      tag.textContent = sch.type === 'planning' ? 'Plan.dag' : sch.type === 'off' ? 'Fri' : '';
      if (tag.textContent) cell.appendChild(tag);
    }

    if (dayVurd.length) {
      const dot = document.createElement('span');
      dot.className = 'strip-day-dot';
      dot.title = dayVurd.map(v => v.subject).join(', ');
      cell.appendChild(dot);
    }

    // ★ marks a day with a calendar event, so a hendelse in the viewed week is
    // visible on the strip and its day view (idrettsdag, leirskole …).
    const dayEvents = eventsOnDate(iso);
    if (dayEvents.length) {
      const ev = document.createElement('span');
      ev.className = 'strip-day-event';
      ev.textContent = '★';
      ev.title = dayEvents.map(e => e.description || 'Hendelse').join(', ');
      cell.appendChild(ev);
    }

    cell.tabIndex = 0;
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label', 'Vis ' + DAY_LABEL[dayKey] + ' ' + date.getDate() + '.');
    cell.addEventListener('click', () => selectDay(i));
    cell.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDay(i); }
    });

    strip.appendChild(cell);
  }
  return strip;
}

// General (class-wide) elements → banner of chips.
function buildBanner() {
  const general = planData.filter(p => GENERAL_TYPES.includes(p.type) && p.description && subjectVisible(p.subject));
  return buildGeneralSection(general);
}

// The rolling upcoming-events panel body (anchored to today, tiered), or null.
function buildStudentEventsPanel() {
  const rows = [];
  hendData.forEach(h => { if (hendForStudent(h)) { const u = eventUrgency(h); if (u) rows.push(Object.assign({ ev: h }, u)); } });
  if (!rows.length) return null;
  rows.sort((a, b) => a.rank - b.rank || a.day.localeCompare(b.day));
  const panel = document.createElement('div'); panel.className = 'events-panel';
  appendEventRows(panel, rows);
  return panel;
}
// Two-column "Beskjeder og praktisk info | Hendelser" grid from a beskjeder node
// + events node (either may be null; a lone column spans full width).
function studentBeGrid(beskjedNode, eventsNode) {
  if (!beskjedNode && !eventsNode) return null;
  const grid = document.createElement('div');
  grid.className = 'be-grid';
  const col = (title, content) => {
    const c = document.createElement('div'); c.className = 'be-col';
    const h = document.createElement('h3'); h.className = 'be-head'; h.textContent = title; c.appendChild(h);
    c.appendChild(content); grid.appendChild(c);
  };
  if (beskjedNode) col('Beskjeder og praktisk info', beskjedNode);
  if (eventsNode)  col('Hendelser', eventsNode);
  if (grid.children.length === 1) grid.classList.add('be-grid-single');
  return grid;
}
// Combined section for the week view (beskjeder banner + events), wrapped in a
// persisted show/hide toggle. Returns null when there's nothing to show.
function buildBeskjedEvents() {
  const grid = studentBeGrid(buildBanner(), buildStudentEventsPanel());
  if (!grid) return null;
  const wrap = document.createElement('div');
  const collapsed = localStorage.getItem(HIDE_BE_KEY) === '1';
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'be-toggle';
  toggle.textContent = (collapsed ? '▸ Vis' : '▾ Skjul') + ' beskjeder og hendelser';
  toggle.addEventListener('click', () => { localStorage.setItem(HIDE_BE_KEY, collapsed ? '0' : '1'); render(); });
  wrap.appendChild(toggle);
  if (!collapsed) wrap.appendChild(grid);
  return wrap;
}
// Min uke: the same beskjeder+hendelser combination. The beskjeder column holds
// the stepper (unread) + the "Tidligere beskjeder" archive below it; the events
// column holds upcoming hendelser. (No hide toggle – it's the landing focus.)
function buildDashBeskjedEvents() {
  const stepper = buildBeskjedStepper();
  const archive = buildBeskjedArchive();
  let beskjed = null;
  if (stepper || archive) {
    beskjed = document.createElement('div');
    beskjed.className = 'dash-beskjed-col';
    if (stepper) beskjed.appendChild(stepper);
    if (archive) beskjed.appendChild(archive);
  }
  return studentBeGrid(beskjed, buildStudentEventsPanel());
}

// Label prefix for a general element. Day is bold; day + fag are combined into
// one label when both are set (e.g. "Man · Matematikk:").
function generalPrefix(p) {
  const dl = daysLabel(p.day);
  if (dl && p.subject) return '<strong>' + escapeHtml(dl) + ' · ' + escapeHtml(p.subject) + ':</strong> ';
  if (p.subject)       return '<strong>' + escapeHtml(p.subject) + ':</strong> ';
  if (dl)              return '<strong>' + escapeHtml(dl) + ':</strong> ';
  return '';
}

// One box per type (📣 Beskjeder, 🕑 Timeendringer …), each listing its items.
// Items show "Fag:" if subject-linked and the day(s) if set.
function buildGeneralSection(elements) {
  if (!elements.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'banner';
  GENERAL_TYPES.forEach(type => {
    const items = elements.filter(e => e.type === type && e.description);
    if (!items.length) return;
    const box = document.createElement('div');
    box.className = 'banner-chip banner-' + type;
    const icon = document.createElement('span');
    icon.className = 'banner-icon';
    icon.textContent = GENERAL_ICON[type] || '📌';
    box.appendChild(icon);
    const list = document.createElement('div');
    list.className = 'banner-list';
    items.forEach(p => {
      const line = document.createElement('div');
      line.className = 'banner-line rich-content';
      line.innerHTML = generalPrefix(p) + sanitizeHtml(p.description);
      list.appendChild(line);
    });
    box.appendChild(list);
    wrap.appendChild(box);
  });
  return wrap.children.length ? wrap : null;
}

// Subject rows: Fag | Tema og læringsmål | Lekser. Ressurser is a subheading
// inside the Tema-cell; Vurdering is a full-width strip under the subject row.
function buildSubjectBoard(weekVurd) {
  // Collect subjects that have any content this week.
  const bySubject = {};
  function bucket(subject) {
    const key = subject || 'Annet';
    if (!bySubject[key]) bySubject[key] = { goals: [], resources: [], homework: [], vurd: [] };
    return bySubject[key];
  }
  planData.forEach(p => {
    if (p.type === 'læringsmål' && p.subject) bucket(p.subject).goals.push(p);
    if (p.type === 'ressurs'    && p.subject) bucket(p.subject).resources.push(p);
    if (p.type === 'lekse'      && p.subject) bucket(p.subject).homework.push(p);
  });
  weekVurd.forEach(v => bucket(v.subject).vurd.push(v));

  const subjects = Object.keys(bySubject).sort(subjectSort).filter(subjectVisible);

  const wrap = document.createElement('div');
  wrap.className = 'board-wrap';

  if (subjects.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = variantCode
      ? 'Finner ingenting her. Har du skrevet koden riktig?'
      : 'Ingen ukeplan lagt inn for ' + selectedClass + ' denne uka ennå.';
    wrap.appendChild(empty);
    return wrap;
  }

  const COLS = ['Fag', 'Tema og læringsmål', 'Lekser'];
  const table = document.createElement('table');
  table.className = 'plan-table';
  const thead = table.createTHead();
  const hr = thead.insertRow();
  COLS.forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    hr.appendChild(th);
  });

  const tbody = table.createTBody();
  subjects.forEach(subject => {
    const data = bySubject[subject];
    const tr = tbody.insertRow();

    const tdSubject = tr.insertCell();
    tdSubject.className = 'cell-subject';
    tdSubject.textContent = subject;

    tr.appendChild(buildGoalsCell(data.goals.map(g => g.description), data.resources.map(r => r.description)));
    tr.appendChild(buildHomeworkCell(data.homework.slice().sort(byDay)));

    // Vurderinger no longer have a column – they show as a full-width strip
    // under the subject's row when there's one this week.
    if (data.vurd.length) {
      tr.classList.add('has-vurd');
      tbody.appendChild(buildVurdRow(data.vurd, COLS.length));
    }
  });

  wrap.appendChild(table);
  return wrap;
}

// Full-width "Vurdering: …" strip placed under a subject row.
function buildVurdRow(vurd, colspan) {
  const tr = document.createElement('tr');
  tr.className = 'vurd-row';
  const td = document.createElement('td');
  td.className = 'cell-vurd-row';
  td.colSpan = colspan;
  tr.appendChild(td);

  // Each vurdering is labelled with the day it falls on when it has one, e.g.
  // "Vurdering på fredag: …" (else just "Vurdering: …").
  vurd.forEach((v, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'vurd-row-sep';
      sep.textContent = ' · ';
      td.appendChild(sep);
    }
    const label = document.createElement('span');
    label.className = 'vurd-row-label';
    const dayName = v.day && DAY_LONG[v.day];
    label.textContent = dayName ? 'Vurdering på ' + dayName + ':' : 'Vurdering:';
    td.appendChild(label);

    const item = document.createElement('span');
    item.className = 'vurd-row-item';
    item.appendChild(document.createTextNode(' ' + (v.description || v.notes || 'Vurdering')));
    td.appendChild(item);
  });
  return tr;
}

// Tema og læringsmål cell: goals, then (if any) a "Ressurser" subheading with
// the resources listed below – Ressurser no longer has its own column.
function buildGoalsCell(goals, resources) {
  goals = goals.filter(Boolean);
  resources = resources.filter(Boolean);
  const td = document.createElement('td');
  td.className = 'cell-goals';
  if (!goals.length && !resources.length) { td.classList.add('cell-empty'); td.textContent = '–'; return td; }

  if (goals.length) appendRichItems(td, goals);
  if (resources.length) {
    const h = document.createElement('div');
    h.className = 'cell-subheading' + (goals.length ? ' cell-subheading-sep' : '');
    h.textContent = 'Ressurser';
    td.appendChild(h);
    appendRichItems(td, resources);
  }
  return td;
}

// Render rich-text items into a parent: a single item inline, several as a list.
function appendRichItems(parent, items) {
  if (items.length === 1) {
    const div = document.createElement('div');
    div.className = 'rich-content';
    renderRich(div, items[0]);
    parent.appendChild(div);
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'cell-list';
  items.forEach(t => { const li = document.createElement('li'); li.classList.add('rich-content'); renderRich(li, t); ul.appendChild(li); });
  parent.appendChild(ul);
}

// Homework cell with local check-off boxes (one per homework element).
function buildHomeworkCell(elements) {
  const td = document.createElement('td');
  td.className = 'cell-homework';
  const items = elements.filter(e => e.description);
  if (items.length === 0) { td.classList.add('cell-empty'); td.textContent = '–'; return td; }
  td.appendChild(buildHomeworkList(items));
  return td;
}

// prefixMode: 'day' (default, used in the week board) shows "Man:";
// 'subject' (used in the day view, where the day is already known) shows "Norsk:".
function buildHomeworkList(elements, prefixMode) {
  const items = elements.filter(e => e.description).slice().sort(byDay);
  const done = getDoneSet();
  const ul = document.createElement('ul');
  ul.className = 'homework-list';
  items.forEach(el => {
    const id = doneKey(el);
    const li = document.createElement('li');
    li.className = 'homework-item';
    const label = document.createElement('label');
    label.className = 'hw-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'hw-check';
    cb.checked = !!done[id];
    if (cb.checked) li.classList.add('done');
    cb.addEventListener('change', () => { toggleDone(id, cb.checked); li.classList.toggle('done', cb.checked); });
    const span = document.createElement('span');
    span.className = 'hw-text rich-content';
    let prefix = '';
    if (prefixMode === 'subject') {
      // Day view: "Norsk:" – but a lekse without a day applies all week, so
      // mark it "Norsk ukelekse:".
      const weekly = parseDays(el.day).length === 0;
      if (el.subject)   prefix = '<strong>' + escapeHtml(el.subject) + (weekly ? ' ukelekse' : '') + ':</strong> ';
      else if (weekly)  prefix = '<strong>Ukelekse:</strong> ';
    } else if (daysLabel(el.day)) {
      prefix = '<strong>' + daysLabel(el.day) + ':</strong> ';
    }
    span.innerHTML = prefix + sanitizeHtml(el.description || '');
    label.appendChild(cb);
    label.appendChild(span);
    li.appendChild(label);
    ul.appendChild(li);
  });
  return ul;
}

function doneKey(el) {
  // Prefer the stable id; fall back to content for id-less (manual) rows.
  return el.id || ('x:' + (el.subject || '') + ':' + (el.day || '') + ':' + el.description);
}
function getDoneSet() {
  try { return JSON.parse(localStorage.getItem(DONE_KEY)) || {}; } catch { return {}; }
}
function toggleDone(id, on) {
  const s = getDoneSet();
  if (on) s[id] = true; else delete s[id];
  localStorage.setItem(DONE_KEY, JSON.stringify(s));
}
function byDay(a, b) {
  const order = { man: 1, tir: 2, ons: 3, tor: 4, fre: 5 };
  return (firstDayIndex(a) || 9) - (firstDayIndex(b) || 9);
}
function firstDayIndex(el) { const d = parseDays(el.day); return d.length ? DAYS.indexOf(d[0]) + 1 : 9; }
function parseDays(s) {
  return String(s || '').toLowerCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean)
    .filter(d => DAYS.includes(d)).sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
}
function daysLabel(s) { return parseDays(s).map(d => DAY_LABEL[d]).join(', '); }
function isMultiWeek(el) { return el.weekTo && el.weekTo > el.week; }

function homeworkText(h) {
  if (h.day && DAY_LABEL[h.day]) return DAY_LABEL[h.day] + ': ' + h.description;
  return h.description;
}

function subjectSort(a, b) {
  const ia = SUBJECTS.indexOf(a), ib = SUBJECTS.indexOf(b);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return a.localeCompare(b, 'no');
}

// ─── Vurderingskalender tab (month grid of assessments) ───────

function onCalDateChange() {
  let s = document.getElementById('calStart').value;
  let e = document.getElementById('calEnd').value;
  if (s && e && s > e) { const t = s; s = e; e = t; showToast('Datointervallet ble byttet om'); }
  calStart = s; calEnd = e;
  renderCalendar();
}

function renderCalendar() {
  const root = document.getElementById('calendar');
  root.innerHTML = '';

  // Default range: today → +2 months, clamped to the school year (as before).
  if (!calStart || !calEnd) {
    const today = new Date();
    const two = new Date(today.getFullYear(), today.getMonth() + 2, today.getDate());
    calStart = clampToSchoolYear(toISODate(today));
    calEnd   = clampToSchoolYear(toISODate(two));
  }
  const bounds = getSchoolYearBounds(new Date());
  const startEl = document.getElementById('calStart');
  const endEl   = document.getElementById('calEnd');
  startEl.min = endEl.min = bounds.start;
  startEl.max = endEl.max = bounds.end;
  startEl.value = calStart;
  endEl.value   = calEnd;

  const detail = document.createElement('div');
  detail.id = 'vurdDetail';
  detail.className = 'vurd-detail';
  root.appendChild(detail);

  const startDate = new Date(calStart);
  const endDate   = new Date(calEnd); endDate.setHours(23, 59, 59);

  const byDate = {};
  vurdData.filter(v => v.date && classMatches(v.classes, selectedClass) && subjectVisible(v.subject)).forEach(v => {
    const d = new Date(v.date);
    if (d < startDate || d > endDate) return;
    (byDate[v.date] = byDate[v.date] || []).push(v);
  });

  let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const endMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  while (cursor <= endMonth) {
    root.appendChild(buildMonthCard(cursor, byDate));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
}

function buildMonthCard(monthDate, byDate) {
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

        // Calendar events (hendelser): a distinct tinted cell + a ★ marker.
        const evs = eventsOnDate(iso);
        if (evs.length) {
          td.classList.add('has-event');
          const em = document.createElement('span');
          em.className = 'cal-event-badge';
          em.textContent = '★';
          em.title = evs.map(e => e.description).filter(Boolean).join(', ');
          td.appendChild(em);
        }

        // Clickable when there are assessments, an event, OR a school-calendar note.
        if (items.length || evs.length || sch) {
          const snap = new Date(cursor);
          const snapItems = items.slice();
          const cell = td;
          td.tabIndex = 0;
          td.setAttribute('role', 'button');
          const openDay = () => {
            document.querySelectorAll('#calendar .cal-table td.selected').forEach(c => c.classList.remove('selected'));
            cell.classList.add('selected');
            showVurdDetail(snap, snapItems);
          };
          td.addEventListener('click', openDay);
          td.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDay(); } });
        }
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

function showVurdDetail(date, items) {
  const box = document.getElementById('vurdDetail');
  if (!box) return;
  box.innerHTML = '';
  const h = document.createElement('h3');
  h.className = 'vurd-detail-title';
  h.textContent = formatDateLong(date);
  box.appendChild(h);

  const sch = schoolDays[toISODate(date)];
  if (sch) box.appendChild(buildSchoolDayCard(sch));

  if (items.length === 0 && sch) {
    const note = document.createElement('p');
    note.className = 'panel-empty';
    note.textContent = 'Ingen vurderinger denne dagen.';
    box.appendChild(note);
  }

  eventsOnDate(toISODate(date)).forEach(ev => box.appendChild(buildEventCard(ev)));
  items.forEach(v => box.appendChild(buildAssessmentCard(v)));
  box.classList.add('active');
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// A calendar event (hendelse) card – read-only, star-marked, with its range.
function buildEventCard(ev) {
  const card = document.createElement('div');
  card.className = 'assessment-card event-card';
  const head = document.createElement('div');
  head.className = 'event-card-head';
  head.textContent = '★ Hendelse';
  if (ev.dateTo && ev.dateTo !== ev.date) {
    const range = document.createElement('span');
    range.className = 'event-card-range';
    range.textContent = shortDate(ev.date) + '–' + shortDate(ev.dateTo);
    head.appendChild(range);
  }
  card.appendChild(head);
  const desc = document.createElement('div');
  desc.className = 'event-card-desc';
  desc.textContent = ev.description || '';
  card.appendChild(desc);
  return card;
}
function shortDate(iso) { return isoToDate(iso).toLocaleDateString('no', { day: 'numeric', month: 'short' }); }

// ─── Overlay & indicators ─────────────────────────────────────

function showOverlay() {
  const overlay = document.getElementById('overlay');
  overlay.querySelector('.overlay-text').textContent = 'Laster...';
  overlay.querySelector('.spinner').style.display = '';
  overlay.querySelector('.overlay-retry')?.remove();
  overlay.classList.add('active');
}
function hideOverlay() { document.getElementById('overlay').classList.remove('active'); }
function showOverlayError(msg) {
  const overlay = document.getElementById('overlay');
  overlay.querySelector('.spinner').style.display = 'none';
  overlay.querySelector('.overlay-text').textContent = msg;
  if (!overlay.querySelector('.overlay-retry')) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary overlay-retry';
    btn.textContent = 'Prøv igjen';
    btn.addEventListener('click', () => loadWeek({ skipCache: true }));
    overlay.querySelector('.overlay-inner').appendChild(btn);
  }
  overlay.classList.add('active');
}
function showBgLoading() { document.getElementById('bgLoading')?.classList.add('active'); }
function hideBgLoading() { document.getElementById('bgLoading')?.classList.remove('active'); }

function updateStatus() {
  document.getElementById('lastUpdated').textContent =
    'Sist oppdatert: ' + new Date().toLocaleString('no');
}

// ─── Cache (per class+week) ───────────────────────────────────

function readWeekCache() {
  try { return JSON.parse(localStorage.getItem(WEEK_CACHE_KEY)) || {}; } catch { return {}; }
}
function getCachedWeek(cls, week) {
  const entry = readWeekCache()[cls + '|' + week];
  if (!entry || Date.now() - entry.ts > CACHE_TTL) return null;
  return entry.data;
}
function setCachedWeek(cls, week, data) {
  const cache = readWeekCache();
  cache[cls + '|' + week] = { ts: Date.now(), data };
  try { localStorage.setItem(WEEK_CACHE_KEY, JSON.stringify(cache)); } catch {}
}

// ─── Focus management ─────────────────────────────────────────

function rememberFocus() { lastFocusedEl = document.activeElement; }
function restoreFocus() {
  if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
    try { lastFocusedEl.focus(); } catch {}
  }
  lastFocusedEl = null;
}
function trapFocus(container, e) {
  const focusables = [...container.querySelectorAll(
    'button:not([disabled]):not([hidden]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter(el => el.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ─── Date / week utilities ────────────────────────────────────

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = d.getDay() || 7; // Mon=1 … Sun=7
  d.setDate(d.getDate() - dow + 1);
  return d;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Parse a "YYYY-MM-DD" string as a LOCAL date (avoids the UTC shift of new Date(iso)).
function isoToDate(iso) { const [y, m, d] = String(iso || '').split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); }
function dayOf(date) {
  const dow = date.getDay(); // 0=Sun … 6=Sat
  return ['', 'man', 'tir', 'ons', 'tor', 'fre', ''][dow] || '';
}
function getWeekNumber(d) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
// ISO week string matching the backend's isoWeekString().
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
// Fill a <select> with week options (value = week string, label = "Uke N").
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

function inWeek(el, w) { return el.week <= w && (el.weekTo || el.week) >= w; }
function weeksBetween(a, b) {
  const out = [];
  let m = weekStringToMonday(a);
  const end = weekStringToMonday(b || a);
  let guard = 0;
  while (m <= end && guard++ < 80) { out.push(dateToWeek(m)); m = addDays(m, 7); }
  return out.length ? out : [a];
}

// "2026-W24" → Monday Date of that ISO week.
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
function formatDateLong(d) {
  const days = ['Søndag','Mandag','Tirsdag','Onsdag','Torsdag','Fredag','Lørdag'];
  return `${days[d.getDay()]} ${d.getDate()}. ${d.toLocaleString('no', { month: 'long' })} ${d.getFullYear()} – uke ${getWeekNumber(d)}`;
}
function classMatches(classesStr, cls) {
  return String(classesStr || '').toUpperCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean).includes(cls);
}
function capitalizeFirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// School-year bounds: Aug 15 (year Y) → Jun 21 (year Y+1), switching on Jun 22.
function getSchoolYearBounds(today) {
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
  const pastJun21 = m > 5 || (m === 5 && d > 21);
  if (pastJun21) return { start: `${y}-08-15`, end: `${y + 1}-06-21` };
  return { start: `${y - 1}-08-15`, end: `${y}-06-21` };
}
function clampToSchoolYear(iso) {
  const b = getSchoolYearBounds(new Date());
  if (iso < b.start) return b.start;
  if (iso > b.end)   return b.end;
  return iso;
}

// ─── School calendar (Nes kommune iCal) ───────────────────────

const SCHOOL_TYPE_LABEL = { off: 'Skolefri', planning: 'Planleggingsdag', marker: 'Skoledag-markering' };

function buildSchoolDayCard(sch) {
  const card = document.createElement('div');
  card.className = 'school-day-card school-day-' + sch.type;
  const label = document.createElement('div');
  label.className = 'school-day-label';
  label.textContent = SCHOOL_TYPE_LABEL[sch.type] || sch.type;
  card.appendChild(label);
  sch.summaries.forEach(s => {
    const line = document.createElement('div');
    line.className = 'school-day-summary';
    line.textContent = s;
    card.appendChild(line);
  });
  return card;
}

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
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }
    if (line === 'END:VEVENT')   { if (current) events.push(current); current = null; continue; }
    if (!current) continue;
    const m = line.match(/^([A-Z]+)(?:;[^:]*)?:(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'DTSTART')      current.dtstart = val.trim();
    else if (key === 'SUMMARY') current.summary = unescapeICS(val);
  }
  return events
    .map(e => ({ date: icsDateToISO(e.dtstart), summary: e.summary || '' }))
    .filter(e => e.date);
}
function icsDateToISO(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function unescapeICS(s) {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}
function buildSchoolDayMap(events) {
  const priority = { off: 3, planning: 2, marker: 1 };
  const out = {};
  for (const e of events) {
    const type = classifySchoolEvent(e.summary);
    if (!type) continue;
    const existing = out[e.date];
    if (!existing) out[e.date] = { type, summaries: [e.summary] };
    else {
      if (priority[type] > priority[existing.type]) existing.type = type;
      if (!existing.summaries.includes(e.summary)) existing.summaries.push(e.summary);
    }
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
    const text = await res.text();
    const events = parseICS(text);
    if (events.length === 0) return;
    schoolDays = buildSchoolDayMap(events);
    localStorage.setItem(SCHOOL_CAL_KEY, JSON.stringify(schoolDays));
    localStorage.setItem(SCHOOL_CAL_TS_KEY, String(Date.now()));
    if (selectedClass) render();
  } catch {
    // Silent.
  }
}
