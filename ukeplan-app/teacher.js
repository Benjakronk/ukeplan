'use strict';

// ─── Configuration ────────────────────────────────────────────

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxP4BS2wc1RWcjjqEtrSfhpydaeGgTvk5GwjCpZ342wJLQmXap7aMwmBPI2L-DCXXcH/exec';
const VURD_URL   = 'https://script.google.com/macros/s/AKfycbwsXqoLZW8RlIAwvGN1yQXgpLnB3aCbVtjrmt4X5v302Fpbd9XFsSiobBOOTC4z1q5n/exec';

const TOKEN_KEY   = 'up_token';
const CLASS_KEY   = 'up_teacher_class';
const TNAME_KEY   = 'up_teacher_name';

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

const DAYS = ['man','tir','ons','tor','fre'];
const DAY_LABEL = { man: 'Man', tir: 'Tir', ons: 'Ons', tor: 'Tor', fre: 'Fre' };

// Types managed as subject cells vs. class-wide banner elements.
// 'vurdering' is special: it lives in the vurderingskalender backend, not the
// ukeplan sheet, and is date-specific rather than week-level.
const SUBJECT_TYPES = ['læringsmål', 'ressurs', 'lekse'];
const GENERAL_TYPES = ['beskjed', 'timeendring', 'utstyr', 'aktivitet', 'annet'];
const MODAL_TYPES   = ['lekse', 'læringsmål', 'ressurs', 'vurdering', 'beskjed', 'timeendring', 'utstyr', 'aktivitet', 'annet'];
const TYPE_LABEL = {
  'læringsmål': 'Tema og læringsmål', 'ressurs': 'Ressurser', 'lekse': 'Lekse', 'vurdering': 'Vurdering', 'beskjed': 'Beskjed',
  'timeendring': 'Timeendring', 'utstyr': 'Utstyr', 'aktivitet': 'Aktivitet', 'annet': 'Annet',
};
const GENERAL_ICON = { beskjed: '📣', timeendring: '🕑', utstyr: '🎒', aktivitet: '🚌', annet: '📌' };

const VURD_TOKEN_KEY = 'up_vurd_token';

let token         = sessionStorage.getItem(TOKEN_KEY) || null;
let vurdToken     = sessionStorage.getItem(VURD_TOKEN_KEY) || null;
let editingVurd   = null; // the vurdering object being edited in the modal, or null
let selectedClass = localStorage.getItem(CLASS_KEY) || null;
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

let teacherTab   = 'ukeplan';  // 'ukeplan' | 'vurd' | 'oversikt'

// Vurderinger-tab view + filters (independent of the global class pill)
let vurdView     = 'table';    // 'table' | 'cal'
let vfClasses    = [];         // selected class filter (empty = all classes)
let vfSubjects   = [];         // selected subject filter (empty = all subjects)
let vfTeachers   = [];         // selected teacher filter (empty = all teachers)
let vfDesc       = '';         // free-text search in the description (empty = all)
let vfStart      = '';         // ISO date – lower date bound (empty = none)
let vfEnd        = '';         // ISO date – upper date bound (empty = none)
let oversiktMode = 'compare';  // 'compare' (classes, one week) | 'prog' (one class, all weeks)
let oversiktData = [];         // all-classes plan elements for the oversikt week (compare mode)
let oversiktWeek = null;
let allPlanData  = [];         // all plan elements (progresjon mode)
let allPlanTs    = 0;
let ovFrom       = null;       // week range filter (progresjon)
let ovTo         = null;

// ─── Lifecycle ────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', init);

function init() {
  setupAuthListeners();
  setupDashboardListeners();
  setupModalListeners();
  loadSchoolCalendar();

  if (selectedClass && !CLASSES.includes(selectedClass)) selectedClass = null;
  document.getElementById('teacherName').value = teacherName;

  if (token) {
    showDashboard();
    updateClassLabel();
    updateWeekLabel();
    if (selectedClass) loadData();
    else { hideOverlay(); showClassModal(); }
  } else {
    showLogin();
  }
}

// ─── Authentication ───────────────────────────────────────────

function setupAuthListeners() {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
}

async function handleLogin(e) {
  e.preventDefault();
  const name = document.getElementById('loginName').value.trim();
  const pw = document.getElementById('passwordInput').value;
  const errEl = document.getElementById('loginError');
  errEl.hidden = true;
  if (!name) { errEl.textContent = 'Skriv inn navnet ditt'; errEl.hidden = false; return; }
  showOverlay();
  try {
    const body = new URLSearchParams({ action: 'login', password: pw });
    const res  = await fetch(SCRIPT_URL, { method: 'POST', body });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    token = data.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    teacherName = name;
    localStorage.setItem(TNAME_KEY, name);
    document.getElementById('teacherName').value = name;
    // Best-effort: log into the vurderingskalender backend with the same
    // password so assessments can be edited here. Silent if it differs.
    vurdLogin(pw).catch(() => {});
    document.getElementById('passwordInput').value = '';
    hideOverlay();
    showDashboard();
    updateClassLabel();
    updateWeekLabel();
    if (selectedClass) loadData();
    else showClassModal();
  } catch (err) {
    hideOverlay();
    errEl.textContent = err.message || 'Innlogging feilet';
    errEl.hidden = false;
  }
}

function handleLogout() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(VURD_TOKEN_KEY);
  token = null;
  vurdToken = null;
  showLogin();
}

function handleExpired() {
  sessionStorage.removeItem(TOKEN_KEY);
  token = null;
  showLogin();
  showToast('Økten utløp — logg inn på nytt.');
}

function showLogin() {
  document.getElementById('dashboard').hidden = true;
  document.getElementById('loginScreen').classList.add('active');
  document.getElementById('loginName').value = teacherName || '';
  hideOverlay();
  const focusId = teacherName ? 'passwordInput' : 'loginName';
  setTimeout(() => document.getElementById(focusId).focus(), 60);
}

function showDashboard() {
  document.getElementById('loginScreen').classList.remove('active');
  document.getElementById('dashboard').hidden = false;
}

// ─── Authenticated API helper ─────────────────────────────────

async function api(action, params = {}) {
  const body = new URLSearchParams(Object.assign({ action, token }, params));
  const res  = await fetch(SCRIPT_URL, { method: 'POST', body });
  const data = await res.json();
  if (data && data.error) {
    if (data.error === 'Unauthorized') { handleExpired(); }
    throw new Error(data.error);
  }
  return data;
}

// ─── Vurderingskalender backend (assessments) ─────────────────

async function vurdLogin(password) {
  const body = new URLSearchParams({ action: 'login', password });
  const res  = await fetch(VURD_URL, { method: 'POST', body });
  const data = await res.json();
  if (data && data.token) {
    vurdToken = data.token;
    sessionStorage.setItem(VURD_TOKEN_KEY, vurdToken);
    return true;
  }
  return false;
}

// Ensures we hold a vurderingskalender token; prompts for its password if the
// ukeplan password differed (so the silent login failed).
async function ensureVurdToken() {
  if (vurdToken) return true;
  const pw = await uiPrompt('Skriv inn passordet for vurderingskalenderen for å kunne lagre vurderinger.', {
    title: 'Passord', label: 'Passord', password: true, okText: 'Logg inn',
  });
  if (!pw) return false;
  const ok = await vurdLogin(pw);
  if (!ok) showToast('Feil passord for vurderingskalenderen.');
  return ok;
}

async function vurdApi(action, params = {}) {
  if (!vurdToken && !(await ensureVurdToken())) throw new Error('Ikke innlogget for vurderinger');
  const body = new URLSearchParams(Object.assign({ action, token: vurdToken }, params));
  const res  = await fetch(VURD_URL, { method: 'POST', body });
  const data = await res.json();
  if (data && data.error) {
    if (data.error === 'Unauthorized') {
      vurdToken = null;
      sessionStorage.removeItem(VURD_TOKEN_KEY);
    }
    throw new Error(data.error);
  }
  return data;
}

// ─── Data loading ─────────────────────────────────────────────

async function loadData(opts = {}) {
  const { background = false } = opts;
  loadAssessments();

  if (background) showBgLoading(); else showOverlay();
  const week = dateToWeek(weekMonday);
  try {
    const url = `${SCRIPT_URL}?action=week&classes=${encodeURIComponent(selectedClass)}&week=${encodeURIComponent(week)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(data.error || 'Ugyldig svar');
    if (selectedClass && week === dateToWeek(weekMonday)) {
      planData = data;
      render();
    }
    updateStatus();
    if (background) hideBgLoading(); else hideOverlay();
  } catch (err) {
    if (background) hideBgLoading();
    else showOverlayError('Kunne ikke laste data. Sjekk tilkoblingen og prøv igjen.');
  }
}

async function loadAssessments() {
  try {
    const res = await fetch(`${VURD_URL}?action=public`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data)) { vurdData = data; render(); }
  } catch { /* silent */ }
}

// ─── Week navigation ──────────────────────────────────────────

function changeWeek(delta) {
  weekMonday = addDays(weekMonday, delta * 7);
  updateWeekLabel();
  if (!selectedClass) return;
  if (teacherTab === 'oversikt') refreshOversikt(); else loadData();
}
function jumpToThisWeek() {
  weekMonday = mondayOf(new Date());
  updateWeekLabel();
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
  document.getElementById('prevWeekBtn').addEventListener('click', () => changeWeek(-1));
  document.getElementById('nextWeekBtn').addEventListener('click', () => changeWeek(1));
  document.getElementById('jumpTodayBtn').addEventListener('click', jumpToThisWeek);
  document.getElementById('refreshBtn').addEventListener('click', () => loadData({ background: true }));
  document.getElementById('classBtn').addEventListener('click', showClassModal);
  document.getElementById('classModalClose').addEventListener('click', closeClassModal);
  document.getElementById('classModalOverlay').addEventListener('click', closeClassModal);
  document.getElementById('addBtn').addEventListener('click', () => openAddModal());
  document.getElementById('cloneBtn').addEventListener('click', cloneFromPreviousWeek);
  document.getElementById('printBtn').addEventListener('click', () => window.print());

  document.getElementById('tTabUkeplan').addEventListener('click', () => setTeacherTab('ukeplan'));
  document.getElementById('tTabVurd').addEventListener('click', () => setTeacherTab('vurd'));
  document.getElementById('tTabOversikt').addEventListener('click', () => setTeacherTab('oversikt'));
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
  SUBJECTS.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; subjSel.appendChild(o); });
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
    teacherName = nameInput.value.trim();
    localStorage.setItem(TNAME_KEY, teacherName);
  });
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
      btn.type = 'button';
      btn.className = 'class-modal-btn';
      btn.textContent = cls;
      if (cls === selectedClass) btn.classList.add('active');
      btn.addEventListener('click', () => pickClass(cls));
      wrap.appendChild(btn);
    });
    grid.appendChild(wrap);
  });
  document.getElementById('classModalOverlay').classList.add('open');
  document.getElementById('classModal').classList.add('open');
  document.body.classList.add('scroll-locked');
}

function pickClass(cls) {
  selectedClass = cls;
  localStorage.setItem(CLASS_KEY, cls);
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

function render() {
  if (!selectedClass) return;
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

function buildGeneralLine(el) {
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
  line.title = 'Klikk for å redigere';
  line.addEventListener('click', () => openElementEdit(el));
  return line;
}

// Subject board: all subjects as rows; Læringsmål + Lekser editable.
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
  SUBJECTS.forEach(subject => {
    const tr = tbody.insertRow();
    const tdSubject = tr.insertCell();
    tdSubject.className = 'cell-subject';
    tdSubject.textContent = subject;

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
    placeholder: '—',
    className: 'edit-rich',
    onCommit: html => commitRichCell(ed, html),
  });
  ed.dataset.subject = subject;
  ed.dataset.type    = type;
  ed.dataset.ids     = JSON.stringify(single.map(e => e.id).filter(Boolean));
  td.appendChild(ed);
  multi.forEach(el => td.appendChild(buildElementChip(el)));
  return td;
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
const DAY_OPTIONS = [['', '—'], ['man', 'Man'], ['tir', 'Tir'], ['ons', 'Ons'], ['tor', 'Tor'], ['fre', 'Fre']];

function buildHomeworkEditCell(subject, elements) {
  const td = document.createElement('td');
  td.className = 'cell-edit cell-homework-edit';
  // Simple lekser (single week, ≤1 day) edit inline; multi-week/multi-day → chips.
  const simple  = elements.filter(e => !isMultiWeek(e) && parseDays(e.day).length <= 1);
  const complex = elements.filter(e => isMultiWeek(e) || parseDays(e.day).length > 1);
  const list = document.createElement('div');
  list.className = 'hw-edit-list';
  td.appendChild(list);
  simple.forEach(el => list.appendChild(buildHomeworkRow(subject, el)));

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'hw-edit-add';
  add.textContent = '+ lekse';
  add.addEventListener('click', () => {
    const row = buildHomeworkRow(subject, null);
    list.appendChild(row);
    const f = row.querySelector('.rich-field'); if (f) f.focus();
  });
  td.appendChild(add);
  complex.forEach(el => td.appendChild(buildElementChip(el)));
  return td;
}

function buildHomeworkRow(subject, el) {
  const row = document.createElement('div');
  row.className = 'hw-edit-row';

  const daySel = document.createElement('select');
  daySel.className = 'hw-day';
  DAY_OPTIONS.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; daySel.appendChild(o); });
  daySel.value = (el && parseDays(el.day)[0]) || '';

  const ed = createRichField({
    value: (el && el.description) || '',
    placeholder: 'Ny lekse…',
    className: 'edit-rich hw-edit-text',
    onCommit: () => commitHomeworkRow(row),
  });
  ed.dataset.id      = (el && el.id) || '';
  ed.dataset.subject = subject;

  daySel.addEventListener('change', () => commitHomeworkRow(row));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'hw-edit-del';
  del.textContent = '×';
  del.title = 'Slett lekse';
  del.addEventListener('click', () => deleteHomeworkRow(row));

  row.appendChild(daySel);
  row.appendChild(ed);
  row.appendChild(del);
  return row;
}

// Called on field blur (text change) or day-select change. A per-field _busy
// flag serializes saves on the same row. If a second commit arrives mid-save
// (e.g. you type, then immediately pick a day), it's marked _pending and
// re-run once the in-flight save finishes — by then the row has an id, so the
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
  const week    = dateToWeek(weekMonday);

  const rerunIfPending = () => {
    ed._busy = false;
    if (ed._pending) { ed._pending = false; commitHomeworkRow(row); }
  };

  if (!val) {
    if (id) {
      ed._busy = true; setSaving();
      try { await api('delete', { id }); ed.dataset.id = ''; ed._original = ''; setSaved(); }
      catch (err) { setSaveError(err.message); }
      finally { rerunIfPending(); }
    }
    return;
  }

  ed._busy = true; setSaving();
  try {
    if (id) {
      await api('update', { id, type: 'lekse', classes: selectedClass, week, day, subject, description: val, teacher: teacherName });
    } else {
      const created = await api('create', { type: 'lekse', classes: selectedClass, week, day, subject, description: val, teacher: teacherName });
      ed.dataset.id = created && created.id ? created.id : '';
    }
    ed._original = sanitizeHtml(ed.innerHTML);
    allPlanTs = 0;
    setSaved();
  } catch (err) {
    setSaveError(err.message);
  } finally {
    rerunIfPending();
  }
}

async function deleteHomeworkRow(row) {
  const ed = row.querySelector('.rich-field');
  const id = ed && ed.dataset.id;
  if (id) {
    setSaving();
    try { await api('delete', { id }); setSaved(); }
    catch (err) { setSaveError(err.message); return; }
  }
  row.remove();
}

function buildVurdCell(subject, vurd) {
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
      tag.title = 'Fra det gamle systemet — kan ikke redigeres her';
    }
    td.appendChild(tag);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'vurd-add';
  add.textContent = vurd.length ? '+ vurdering' : '+ legg til';
  add.addEventListener('click', () => openVurdAdd(subject));
  td.appendChild(add);
  return td;
}

async function commitRichCell(ed, html) {
  const ids     = JSON.parse(ed.dataset.ids || '[]');
  const subject = ed.dataset.subject;
  const type    = ed.dataset.type;
  const week    = dateToWeek(weekMonday);
  const val     = html.trim();

  setSaving();
  try {
    if (!val) {
      for (const id of ids) await api('delete', { id });
      ed.dataset.ids = '[]';
    } else if (ids.length) {
      await api('update', {
        id: ids[0], type, classes: selectedClass, week,
        day: '', subject, description: val, teacher: teacherName,
      });
      for (const extra of ids.slice(1)) await api('delete', { id: extra });
      ed.dataset.ids = JSON.stringify([ids[0]]);
    } else {
      const created = await api('create', {
        type, classes: selectedClass, week,
        day: '', subject, description: val, teacher: teacherName,
      });
      ed.dataset.ids = JSON.stringify(created && created.id ? [created.id] : []);
    }
    allPlanTs = 0;
    setSaved();
  } catch (err) {
    setSaveError(err.message);
  }
}


// ─── Add modal ────────────────────────────────────────────────

function setupModalListeners() {
  document.getElementById('addModalClose').addEventListener('click', closeAddModal);
  document.getElementById('addCancel').addEventListener('click', closeAddModal);
  document.getElementById('modalOverlay').addEventListener('click', closeAddModal);
  document.getElementById('addSave').addEventListener('click', saveFromModal);
  document.getElementById('addDelete').addEventListener('click', deleteFromModal);
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
  document.getElementById('dateInput').addEventListener('change', refreshConflicts);

  // Subject select options ("(uten fag)" allowed for general types)
  const sel = document.getElementById('subjectSelect');
  const none = document.createElement('option'); none.value = ''; none.textContent = '(uten fag)'; sel.appendChild(none);
  SUBJECTS.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });

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
  modalClasses   = preset.classes ? preset.classes.slice() : [selectedClass];
  modalDays      = preset.days ? preset.days.slice() : [];
  modalWeekFrom  = preset.weekFrom || weekMonday;
  modalWeekTo    = preset.weekTo || modalWeekFrom;
  document.getElementById('descInput').value = '';
  document.getElementById('vurdTeacherInput').value = preset.teacher || teacherName;
  document.getElementById('subjectSelect').value = preset.subject || (SUBJECT_TYPES.includes(modalType) ? SUBJECTS[0] : '');
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
  document.getElementById('descInput').value = el.description || '';
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
  document.getElementById('descInput').value = v.description || v.notes || '';
  document.getElementById('vurdTeacherInput').value = v.teacher || teacherName;
  document.getElementById('subjectSelect').value = SUBJECTS.includes(v.subject) ? v.subject : SUBJECTS[0];
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
  setTimeout(() => document.getElementById('descInput').focus(), 60);
}

// Constrain the date picker (vurdering) to the modal's start week.
function setDateInputBounds(preferred) {
  const input = document.getElementById('dateInput');
  const monday = modalWeekFrom || weekMonday;
  const sunday = addDays(monday, 6);
  input.min = toISODate(monday);
  input.max = toISODate(sunday);
  if (preferred) { input.value = preferred; return; }
  const todayISO = toISODate(new Date());
  input.value = (todayISO >= input.min && todayISO <= input.max) ? todayISO : input.min;
}

// Populate the from/til week dropdowns centred on the modal's start week.
function buildModalWeekOptions() {
  const fromSel = document.getElementById('weekFrom');
  const toSel   = document.getElementById('weekTo');
  const center  = modalWeekFrom || weekMonday;
  const fromISO = toISODate(modalWeekFrom || center);
  const toISO   = toISODate(modalWeekTo || center);
  fromSel.innerHTML = '';
  toSel.innerHTML = '';
  for (let off = -4; off <= 40; off++) {
    const m = addDays(center, off * 7);
    const label = 'Uke ' + getWeekNumber(m) + ' · ' + formatWeekRange(m, addDays(m, 4));
    const o1 = document.createElement('option'); o1.value = toISODate(m); o1.textContent = label; if (o1.value === fromISO) o1.selected = true; fromSel.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = toISODate(m); o2.textContent = label; if (o2.value === toISO) o2.selected = true; toSel.appendChild(o2);
  }
}

function closeAddModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.getElementById('addModal').classList.remove('open');
  document.body.classList.remove('scroll-locked');
}

function selectModalType(t) {
  modalType = t;
  document.querySelectorAll('#typeBtns .type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === t));
  const isVurd = t === 'vurdering';
  const hasDay = t === 'lekse' || GENERAL_TYPES.includes(t); // lekse + general types
  document.getElementById('subjectRow').style.display    = '';            // all types can carry a subject
  document.getElementById('weekRangeRow').style.display  = isVurd ? 'none' : '';
  document.getElementById('dateRow').style.display       = isVurd ? '' : 'none';
  document.getElementById('dayRow').style.display        = hasDay ? '' : 'none';
  if (!hasDay) { modalDays = []; syncDayBtns(); }
  const subjSel = document.getElementById('subjectSelect');
  if (SUBJECT_TYPES.includes(t) && !subjSel.value) subjSel.value = SUBJECTS[0];
  refreshConflicts();
}

function buildModalClassBtns() {
  const grid = document.getElementById('classBtns');
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
      if (modalClasses.includes(cls)) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (modalClasses.includes(cls)) modalClasses = modalClasses.filter(c => c !== cls);
        else modalClasses.push(cls);
        btn.classList.toggle('active');
        refreshConflicts();
      });
      wrap.appendChild(btn);
    });
    grid.appendChild(wrap);
  });
}

function syncDayBtns() {
  document.querySelectorAll('#dayBtns .day-btn').forEach(b => b.classList.toggle('active', modalDays.includes(b.dataset.day)));
}

async function saveFromModal() {
  if (modalSaving) return;   // a save is already running – ignore extra clicks
  const desc = document.getElementById('descInput').value.trim();
  if (!desc) { showToast('Skriv inn innhold først.'); return; }
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
        await api('update', {
          id: editingElement.id, type: modalType, classes: modalClasses.join(' '),
          week: weekFrom, weekTo, day, subject, description: desc, teacher,
        });
      } else {
        for (const cls of modalClasses) {
          await api('create', {
            type: modalType, classes: cls, week: weekFrom, weekTo, day, subject, description: desc, teacher,
          });
        }
      }
      setSaved();
      closeAddModal();
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
  const subject = document.getElementById('subjectSelect').value;
  const classes = modalClasses.join(' ');
  const teacher = modalTeacherValue();

  setSaving();
  try {
    if (editingVurd && editingVurd.id) {
      await vurdApi('update', { id: editingVurd.id, date, subject, classes, description: desc, teacher });
    } else {
      await vurdApi('create', { date, subject, classes, description: desc, teacher });
    }
    setSaved();
    closeAddModal();
    loadAssessments();
  } catch (err) {
    setSaveError(err.message);
  }
}

async function deleteFromModal() {
  if (editingVurd && editingVurd.id) {
    if (!await uiConfirm('Slette denne vurderingen?', { title: 'Slette vurdering', okText: 'Slett', danger: true })) return;
    setSaving();
    try { await vurdApi('delete', { id: editingVurd.id }); setSaved(); closeAddModal(); loadAssessments(); }
    catch (err) { setSaveError(err.message); }
    return;
  }
  if (editingElement && editingElement.id) {
    if (!await uiConfirm('Slette dette elementet' + (isMultiWeek(editingElement) ? ' (gjelder ' + weekRangeShort(editingElement) + ')' : '') + '?', { title: 'Slette element', okText: 'Slett', danger: true })) return;
    setSaving();
    try { await api('delete', { id: editingElement.id }); setSaved(); closeAddModal(); refreshAfterChange(); }
    catch (err) { setSaveError(err.message); }
  }
}

// ─── Clone previous week ──────────────────────────────────────

async function cloneFromPreviousWeek() {
  const toWeek   = dateToWeek(weekMonday);
  const fromWeek = dateToWeek(addDays(weekMonday, -7));
  const hasContent = planData.some(p => SUBJECT_TYPES.includes(p.type) || GENERAL_TYPES.includes(p.type));
  const msg = hasContent
    ? `Denne uka (${toWeek}) har allerede innhold. Kopier fra forrige uke likevel? (Det kan gi dobbeltoppføringer.)`
    : `Kopiere alt fra forrige uke til uke ${getWeekNumber(weekMonday)} for ${selectedClass}?`;
  if (!await uiConfirm(msg, { title: 'Kopier forrige uke', okText: 'Kopier' })) return;

  setSaving();
  try {
    const result = await api('clone', { fromWeek, toWeek, classes: selectedClass });
    setSaved();
    showToast(`Kopierte ${result.count || 0} element(er) fra forrige uke.`);
    loadData({ background: true });
  } catch (err) {
    setSaveError(err.message);
  }
}

// ─── Tabs ─────────────────────────────────────────────────────

function setTeacherTab(tab) {
  teacherTab = tab;
  [['ukeplan', 'tTabUkeplan', 'paneUkeplan'], ['vurd', 'tTabVurd', 'paneVurd'], ['oversikt', 'tTabOversikt', 'paneOversikt']]
    .forEach(([t, btnId, paneId]) => {
      document.getElementById(btnId).classList.toggle('active', t === tab);
      document.getElementById(paneId).hidden = t !== tab;
    });
  document.getElementById('toolbar').style.display = tab === 'ukeplan' ? '' : 'none';
  // visibility (not display) so the controls-row keeps a constant size across tabs
  document.querySelector('.week-nav').style.visibility = tab === 'vurd' ? 'hidden' : 'visible';
  if (!selectedClass) return;
  if (tab === 'vurd') renderVurd();
  else if (tab === 'oversikt') refreshOversikt();
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
  if (teacherTab === 'oversikt') refreshOversikt();
  else loadData({ background: true });
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

// Calendar view — month cards with a dot per assessment; clicking a day shows
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

function buildVurdMonthCard(monthDate, byDate) {
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
        td.tabIndex = 0;
        td.setAttribute('role', 'button');
        td.addEventListener('click', () => showVurdDayDetail(snap, snapItems));
        td.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showVurdDayDetail(snap, snapItems); } });
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
    const els   = oversiktData.filter(p => p.subject === subject && classMatches(p.classes, cls));
    const goals = els.filter(p => p.type === 'læringsmål').map(p => p.description).filter(Boolean);
    const resources = els.filter(p => p.type === 'ressurs').map(p => p.description).filter(Boolean);
    const hw    = els.filter(p => p.type === 'lekse' && p.description).sort(byDay);
    const vurd  = vurdData.filter(v => v.date && dateToWeek(isoToDate(v.date)) === week && v.subject === subject && classMatches(v.classes, cls));

    const tr = tbody.insertRow();
    const c = tr.insertCell(); c.className = 'cell-subject'; c.textContent = cls;

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
    if (vurd.length) {
      vurd.forEach(v => {
        const vd = dayOf(isoToDate(v.date));
        const s = document.createElement('div');
        s.textContent = (vd && DAY_LABEL[vd] ? DAY_LABEL[vd] + ': ' : '') + (v.description || v.notes || 'Vurdering');
        vc.appendChild(s);
      });
    } else { vc.classList.add('cell-empty'); vc.textContent = '—'; }
  });

  div.appendChild(table);
  board.appendChild(div);
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
    placeholder: '—',
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
  const ids = JSON.parse(ed.dataset.ids || '[]');
  const cls = ed.dataset.cls, subject = ed.dataset.subject, type = ed.dataset.type, week = ed.dataset.week;
  const val = html.trim();
  setSaving();
  try {
    if (!val) {
      for (const id of ids) await api('delete', { id });
      ed.dataset.ids = '[]';
    } else if (ids.length) {
      await api('update', { id: ids[0], type, classes: cls, week, day: '', subject, description: val, teacher: teacherName });
      for (const extra of ids.slice(1)) await api('delete', { id: extra });
      ed.dataset.ids = JSON.stringify([ids[0]]);
    } else {
      const c = await api('create', { type, classes: cls, week, day: '', subject, description: val, teacher: teacherName });
      ed.dataset.ids = JSON.stringify(c && c.id ? [c.id] : []);
    }
    allPlanTs = 0; // invalidate so a later reload picks up the change
    setSaved();
  } catch (err) {
    setSaveError(err.message);
  }
}

function renderOversiktProg() {
  const board = document.getElementById('oversiktBoard');
  if (!board) return;
  board.innerHTML = '';
  document.getElementById('oversiktWeek').textContent = '';
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

    // Tema og Ressurser are editable per week (single-week inline; multi-week as chips).
    tr.appendChild(buildProgEditCell(cls, subject, 'læringsmål', wk, temaEls));
    tr.appendChild(buildProgEditCell(cls, subject, 'ressurs', wk, resEls));

    const hc = tr.insertCell();
    if (hw.length) {
      hw.forEach(h => {
        const d = document.createElement('div');
        d.className = 'rich-content';
        const dp = daysLabel(h.day) ? '<strong>' + daysLabel(h.day) + ':</strong> ' : '';
        d.innerHTML = dp + sanitizeHtml(h.description || '');
        hc.appendChild(d);
      });
    } else { hc.className = 'cell-empty'; hc.textContent = '—'; }

    const vc = tr.insertCell();
    vc.className = 'cell-vurd';
    if (wv.length) {
      wv.forEach(v => {
        const vd = dayOf(isoToDate(v.date));
        const s = document.createElement('div');
        s.textContent = (vd && DAY_LABEL[vd] ? DAY_LABEL[vd] + ': ' : '') + (v.description || v.notes || 'Vurdering');
        vc.appendChild(s);
      });
    } else { vc.classList.add('cell-empty'); vc.textContent = '—'; }
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
function setSaveError(msg) {
  const el = document.getElementById('saveStatus');
  el.textContent = 'Feil: ' + (msg || 'kunne ikke lagre'); el.className = 'save-status error';
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
function showBgLoading() { document.getElementById('bgLoading')?.classList.add('active'); }
function hideBgLoading() { document.getElementById('bgLoading')?.classList.remove('active'); }

function updateStatus() {
  document.getElementById('lastUpdated').textContent = 'Sist oppdatert: ' + new Date().toLocaleString('no');
}

function showToast(message, opts = {}) {
  const toast = document.getElementById('toast');
  toast.querySelector('.toast-msg').textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => { toast.hidden = true; }, 250);
  }, opts.duration ?? 3000);
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
