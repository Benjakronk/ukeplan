'use strict';

// ─── Configuration ────────────────────────────────────────────

// NEW ukeplan backend (homework, learning goals, messages, …).
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxP4BS2wc1RWcjjqEtrSfhpydaeGgTvk5GwjCpZ342wJLQmXap7aMwmBPI2L-DCXXcH/exec';

// EXISTING vurderingskalender backend — assessments are read-only
// here and merged into the "Vurdering" column.
const VURD_URL = 'https://script.google.com/macros/s/AKfycbwsXqoLZW8RlIAwvGN1yQXgpLnB3aCbVtjrmt4X5v302Fpbd9XFsSiobBOOTC4z1q5n/exec';

const CLASS_KEY      = 'up_class';          // chosen class (single)
const WEEK_CACHE_KEY = 'up_weeks';          // { "8A|2026-W24": { ts, data } }
const VURD_CACHE_KEY = 'up_vurd';
const VURD_TS_KEY    = 'up_vurd_ts';
const DONE_KEY       = 'up_done';            // { elementId: true } — locally checked-off homework
const ALL_CACHE_KEY  = 'up_all';             // all plan elements (for fag-progresjon)
const ALL_TS_KEY     = 'up_all_ts';
const CACHE_TTL      = 60 * 60 * 1000;       // 1 hour

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

// Canonical subject order. Subjects not listed are appended alphabetically.
const SUBJECTS = [
  'Norsk','Matematikk','Engelsk','Naturfag','Samfunnsfag','KRLE',
  'Kroppsøving','Musikk','Kunst og håndverk','Mat og helse',
  'Fremmedspråk','Utdanningsvalg',
];

const DAYS = ['man','tir','ons','tor','fre'];
const DAY_LABEL = { man: 'Man', tir: 'Tir', ons: 'Ons', tor: 'Tor', fre: 'Fre' };

// Element types that are class-wide (no subject) → shown in the banner.
const GENERAL_TYPES = ['beskjed', 'timeendring', 'utstyr', 'aktivitet', 'annet'];
const GENERAL_ICON  = { beskjed: '📣', timeendring: '🕑', utstyr: '🎒', aktivitet: '🚌', annet: '📌' };

let selectedClass = null;
let weekMonday    = mondayOf(new Date());
let planData      = [];                 // plan elements for current class+week
let vurdData      = [];                 // all assessments (filtered client-side)
let lastFocusedEl = null;
let schoolDays    = loadCachedSchoolDays() || {}; // ISO date -> { type, summaries }

let currentTab       = 'ukeplan';  // 'ukeplan' | 'fag' | 'vurd'
let ukeplanView      = 'uke';      // 'uke' | 'dag'
let selectedDayIndex = 0;          // 0..4 (Mon..Fri), for the day view
let allPlanData      = [];         // all plan elements (fag-progresjon)
let fagFrom          = null;       // week range filter for the Fag tab
let fagTo            = null;
let calStart         = null;       // date range for the Vurderingskalender tab
let calEnd           = null;

// ─── Lifecycle ────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', init);

async function init() {
  setupListeners();
  loadSchoolCalendar();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  selectedClass = localStorage.getItem(CLASS_KEY);
  if (selectedClass && !CLASSES.includes(selectedClass)) selectedClass = null;

  updateClassLabel();
  updateWeekLabel();

  if (!selectedClass) {
    hideOverlay();
    showClassModal();
    return;
  }
  await loadWeek();
}

function setupListeners() {
  document.getElementById('prevWeekBtn').addEventListener('click', () => changeWeek(-1));
  document.getElementById('nextWeekBtn').addEventListener('click', () => changeWeek(1));
  document.getElementById('jumpTodayBtn').addEventListener('click', jumpToThisWeek);
  document.getElementById('refreshBtn').addEventListener('click', () => {
    if (currentTab === 'fag') loadAllPlan({ skipCache: true });
    else loadWeek({ skipCache: true });
  });
  document.getElementById('classBtn').addEventListener('click', showClassModal);
  document.getElementById('classModalClose').addEventListener('click', () => closeClassModal());
  document.getElementById('classModalOverlay').addEventListener('click', () => closeClassModal());

  document.getElementById('tabUkeplan').addEventListener('click', () => setTab('ukeplan'));
  document.getElementById('tabFag').addEventListener('click', () => setTab('fag'));
  document.getElementById('tabVurd').addEventListener('click', () => setTab('vurd'));
  document.getElementById('viewUke').addEventListener('click', () => setView('uke'));
  document.getElementById('viewDag').addEventListener('click', () => setView('dag'));
  document.getElementById('calStart').addEventListener('change', onCalDateChange);
  document.getElementById('calEnd').addEventListener('change', onCalDateChange);

  const fagSel = document.getElementById('fagSubject');
  SUBJECTS.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; fagSel.appendChild(o); });
  fagSel.addEventListener('change', () => { fagFrom = null; fagTo = null; renderFag(); });
  document.getElementById('fagFrom').addEventListener('change', e => { fagFrom = e.target.value; renderFag(); });
  document.getElementById('fagTo').addEventListener('change', e => { fagTo = e.target.value; renderFag(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('classModal').classList.contains('open')) closeClassModal();
      return;
    }
    if (e.key === 'Tab') {
      const modal = document.getElementById('classModal');
      if (modal.classList.contains('open')) trapFocus(modal, e);
    }
    // Week navigation with arrow keys (only in the Ukeplan tab, no modal open).
    if (!document.getElementById('classModal').classList.contains('open') && selectedClass && currentTab === 'ukeplan') {
      if (e.key === 'ArrowLeft')  changeWeek(-1);
      if (e.key === 'ArrowRight') changeWeek(1);
    }
  });
}

// ─── Tabs & view switching ────────────────────────────────────

function setTab(tab) {
  currentTab = tab;
  document.getElementById('tabUkeplan').classList.toggle('active', tab === 'ukeplan');
  document.getElementById('tabFag').classList.toggle('active', tab === 'fag');
  document.getElementById('tabVurd').classList.toggle('active', tab === 'vurd');
  const isUke = tab === 'ukeplan';
  // visibility (not display) so the controls-row keeps a constant size across tabs
  document.querySelector('.week-nav').style.visibility     = isUke ? 'visible' : 'hidden';
  document.getElementById('jumpTodayBtn').style.visibility = isUke ? 'visible' : 'hidden';
  document.getElementById('viewToggle').style.display      = isUke ? '' : 'none';
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

function updateWeekLabel() {
  const friday = addDays(weekMonday, 4);
  document.getElementById('weekLabel').textContent = 'Uke ' + getWeekNumber(weekMonday);
  document.getElementById('weekRange').textContent = formatWeekRange(weekMonday, friday);
}

// ─── Data loading ─────────────────────────────────────────────

async function loadWeek(opts = {}) {
  const { skipCache = false } = opts;
  const week = dateToWeek(weekMonday);
  const background = planData.length > 0 || !!getCachedWeek(selectedClass, week);

  // Assessments cache (small dataset, fetched once per hour).
  loadAssessments({ skipCache });

  if (!skipCache) {
    const cached = getCachedWeek(selectedClass, week);
    if (cached) {
      planData = cached;
      render();
      hideOverlay();
      // refresh in the background
      fetchWeek(selectedClass, week, { background: true });
      return;
    }
  }

  if (background) showBgLoading(); else showOverlay();
  await fetchWeek(selectedClass, week, { background });
}

async function fetchWeek(cls, week, opts = {}) {
  const { background = false } = opts;
  try {
    const url = `${SCRIPT_URL}?action=week&classes=${encodeURIComponent(cls)}&week=${encodeURIComponent(week)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(data.error || 'Ugyldig svar');
    // Only adopt if still the active class+week (user may have navigated away).
    if (cls === selectedClass && week === dateToWeek(weekMonday)) {
      planData = data;
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
    const res = await fetch(`${VURD_URL}?action=public`);
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data)) return;
    vurdData = data;
    localStorage.setItem(VURD_CACHE_KEY, JSON.stringify(data));
    localStorage.setItem(VURD_TS_KEY, String(Date.now()));
    render();
  } catch {
    // Silent — keep whatever was cached.
  }
}

// ─── Class selection ──────────────────────────────────────────

function updateClassLabel() {
  document.getElementById('classBtnLabel').textContent = selectedClass || 'Velg klasse';
}

function showClassModal() {
  const grid = document.getElementById('classModalGrid');
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
      btn.type        = 'button';
      btn.className   = 'class-modal-btn';
      btn.textContent = cls;
      if (cls === selectedClass) btn.classList.add('active');
      btn.addEventListener('click', () => pickClass(cls));
      wrap.appendChild(btn);
    });
    grid.appendChild(wrap);
  });

  rememberFocus();
  document.getElementById('classModalOverlay').classList.add('open');
  document.getElementById('classModal').classList.add('open');
  document.body.classList.add('scroll-locked');
  setTimeout(() => grid.querySelector('.class-modal-btn.active, .class-modal-btn')?.focus(), 60);
}

function pickClass(cls) {
  selectedClass = cls;
  localStorage.setItem(CLASS_KEY, cls);
  updateClassLabel();
  closeClassModal();
  loadWeek();
}

function closeClassModal() {
  document.getElementById('classModalOverlay').classList.remove('open');
  document.getElementById('classModal').classList.remove('open');
  document.body.classList.remove('scroll-locked');
  restoreFocus();
}

// ─── Rendering ────────────────────────────────────────────────

function render() {
  if (!selectedClass) return;
  if (currentTab === 'fag')  { renderFag(); return; }
  if (currentTab === 'vurd') { renderCalendar(); return; }
  if (ukeplanView === 'dag') renderDayView();
  else renderWeekView();
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

  const plan = allPlanData.filter(p => p.subject === subject && classMatches(p.classes, selectedClass));
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
  table.className = 'plan-table';
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

    const gc = tr.insertCell();
    if (goals.length) { gc.className = 'rich-content'; gc.innerHTML = goals.map(sanitizeHtml).join('<br>'); }
    else { gc.className = 'cell-empty'; gc.textContent = '—'; }

    const rc = tr.insertCell();
    if (resources.length) { rc.className = 'rich-content'; rc.innerHTML = resources.map(sanitizeHtml).join('<br>'); }
    else { rc.className = 'cell-empty'; rc.textContent = '—'; }

    const hc = tr.insertCell();
    if (hw.length) {
      hw.forEach(h => {
        const d = document.createElement('div');
        d.className = 'rich-content';
        const dp = (h.day && DAY_LABEL[h.day]) ? '<strong>' + DAY_LABEL[h.day] + ':</strong> ' : '';
        d.innerHTML = dp + sanitizeHtml(h.description || '');
        hc.appendChild(d);
      });
    } else { hc.className = 'cell-empty'; hc.textContent = '—'; }

    const vc = tr.insertCell();
    vc.className = 'cell-vurd';
    if (wv.length) {
      wv.forEach(v => {
        const tag = document.createElement('span');
        tag.className = 'vurd-tag';
        const dot = document.createElement('span'); dot.className = 'vurd-dot'; tag.appendChild(dot);
        tag.appendChild(document.createTextNode((v.day && DAY_LABEL[v.day] ? DAY_LABEL[v.day] + ': ' : '') + (v.description || v.notes || 'Vurdering')));
        vc.appendChild(tag);
      });
    } else { vc.classList.add('cell-empty'); vc.textContent = '—'; }
  });

  wrap.appendChild(table);
  board.appendChild(wrap);
}

// Assessments for the current class + week, with a derived weekday.
function currentWeekVurd() {
  const week = dateToWeek(weekMonday);
  return vurdData
    .filter(v => v.date && dateToWeek(new Date(v.date)) === week && classMatches(v.classes, selectedClass))
    .map(v => ({ ...v, day: dayOf(new Date(v.date)) }));
}

function renderWeekView() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  const weekVurd = currentWeekVurd();
  board.appendChild(buildWeekStrip(weekVurd));
  const banner = buildBanner();
  if (banner) board.appendChild(banner);
  board.appendChild(buildSubjectBoard(weekVurd));
}

function renderDayView() {
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

  // Vurderinger that day
  const dayVurd = weekVurd.filter(v => v.day === dayKey);
  if (dayVurd.length) {
    const sec = daySection('Vurderinger');
    dayVurd.forEach(v => sec.appendChild(buildAssessmentCard(v)));
    wrap.appendChild(sec);
  }

  // Lekser that day (with check-off). Multi-day aware.
  const dayHw = planData.filter(p => p.type === 'lekse' && p.description && parseDays(p.day).includes(dayKey));
  if (dayHw.length) {
    const sec = daySection('Lekser');
    sec.appendChild(buildHomeworkList(dayHw, 'subject'));
    wrap.appendChild(sec);
  }

  // Beskjeder / praktisk: this day's items + week-general (no day) ones
  const dayGeneral = planData.filter(p =>
    GENERAL_TYPES.includes(p.type) && p.description &&
    (parseDays(p.day).includes(dayKey) || parseDays(p.day).length === 0));
  const gs = buildGeneralSection(dayGeneral);
  if (gs) {
    const sec = daySection('Beskjeder og praktisk');
    sec.appendChild(gs);
    wrap.appendChild(sec);
  }

  if (!sch && !dayVurd.length && !dayHw.length && !dayGeneral.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Ingenting registrert for denne dagen.';
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

function buildAssessmentCard(v) {
  const card = document.createElement('div');
  card.className = 'assessment-card';
  const subject = document.createElement('div');
  subject.className = 'ac-subject';
  subject.textContent = v.subject || 'Vurdering';
  card.appendChild(subject);
  if (v.classes) {
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
  const general = planData.filter(p => GENERAL_TYPES.includes(p.type) && p.description);
  return buildGeneralSection(general);
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
      let prefix = '';
      if (p.subject) prefix += '<strong>' + escapeHtml(p.subject) + ':</strong> ';
      const dl = daysLabel(p.day);
      if (dl) prefix += '<em>' + dl + ':</em> ';
      line.innerHTML = prefix + sanitizeHtml(p.description);
      list.appendChild(line);
    });
    box.appendChild(list);
    wrap.appendChild(box);
  });
  return wrap.children.length ? wrap : null;
}

// Subject rows: Fag | Læringsmål | Lekser | Vurdering.
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

  const subjects = Object.keys(bySubject).sort(subjectSort);

  const wrap = document.createElement('div');
  wrap.className = 'board-wrap';

  if (subjects.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Ingen ukeplan lagt inn for ' + selectedClass + ' denne uka ennå.';
    wrap.appendChild(empty);
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'plan-table';
  const thead = table.createTHead();
  const hr = thead.insertRow();
  ['Fag', 'Tema og læringsmål', 'Ressurser', 'Lekser', 'Vurdering'].forEach(h => {
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

    tr.appendChild(buildListCell(data.goals.map(g => g.description), 'cell-goals'));
    tr.appendChild(buildListCell(data.resources.map(r => r.description), 'cell-resources'));
    tr.appendChild(buildHomeworkCell(data.homework.slice().sort(byDay)));
    tr.appendChild(buildVurdCell(data.vurd));
  });

  wrap.appendChild(table);
  return wrap;
}

function buildListCell(items, className) {
  const td = document.createElement('td');
  td.className = className;
  items = items.filter(Boolean);
  if (items.length === 0) { td.classList.add('cell-empty'); td.textContent = '—'; return td; }
  if (items.length === 1) { td.classList.add('rich-content'); renderRich(td, items[0]); return td; }
  const ul = document.createElement('ul');
  ul.className = 'cell-list';
  items.forEach(t => { const li = document.createElement('li'); li.classList.add('rich-content'); renderRich(li, t); ul.appendChild(li); });
  td.appendChild(ul);
  return td;
}

// Homework cell with local check-off boxes (one per homework element).
function buildHomeworkCell(elements) {
  const td = document.createElement('td');
  td.className = 'cell-homework';
  const items = elements.filter(e => e.description);
  if (items.length === 0) { td.classList.add('cell-empty'); td.textContent = '—'; return td; }
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
    const prefix = (prefixMode === 'subject')
      ? (el.subject ? '<strong>' + escapeHtml(el.subject) + ':</strong> ' : '')
      : (daysLabel(el.day) ? '<strong>' + daysLabel(el.day) + ':</strong> ' : '');
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

function buildVurdCell(vurd) {
  const td = document.createElement('td');
  td.className = 'cell-vurd';
  if (vurd.length === 0) { td.classList.add('cell-empty'); td.textContent = '—'; return td; }
  vurd.forEach(v => {
    const tag = document.createElement('span');
    tag.className = 'vurd-tag';
    const dot = document.createElement('span');
    dot.className = 'vurd-dot';
    tag.appendChild(dot);
    const label = v.day && DAY_LABEL[v.day] ? DAY_LABEL[v.day] : '';
    tag.appendChild(document.createTextNode(
      (label ? label + ': ' : '') + (v.description || v.notes || 'Vurdering')
    ));
    td.appendChild(tag);
  });
  return td;
}

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
  vurdData.filter(v => v.date && classMatches(v.classes, selectedClass)).forEach(v => {
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

        // Clickable when there are assessments OR a school-calendar note.
        if (items.length || sch) {
          const snap = new Date(cursor);
          const snapItems = items.slice();
          td.tabIndex = 0;
          td.setAttribute('role', 'button');
          td.addEventListener('click', () => showVurdDetail(snap, snapItems));
          td.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showVurdDetail(snap, snapItems); } });
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

  items.forEach(v => box.appendChild(buildAssessmentCard(v)));
  box.classList.add('active');
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

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
