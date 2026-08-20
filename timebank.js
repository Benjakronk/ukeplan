'use strict';

// Tidsbank – a per-class "time bank": bank leftover time from timed tasks, spend
// it to leave early or buy a free period. Balance + history + free-period length
// live SERVER-SIDE (class_timebank table), so the bank is shared across teachers
// and devices for a class. Session-gated on the teacher cookie.

const SCRIPT_URL = 'https://api.ukeportalen.no';
const RING_C = 339.29;                 // 2·π·54, matches the SVG + CSS dash-array
const PRESETS = [1, 2, 3, 5];          // timer presets (minutes)
const SPEND_PRESETS = [1, 2, 5];       // quick-spend presets (minutes)
const CLASS_KEY = 'up_tb_class';       // remember the last picked class (UI only)

let classes = [];
let cls = null;
let state = { class: null, seconds: 0, period: 45, log: [] };   // server-owned
let pendingDuration = 0;               // seconds the next timer will run
let duration = 0;                      // seconds the running timer was set to
let endAt = 0;                         // ms epoch the running timer ends
let tick = null;                       // interval id
let audio = null;                      // AudioContext (created on first Start)

// ── server ────────────────────────────────────────────────────────────────────
async function api(action, params = {}, method = 'POST') {
  let res;
  if (method === 'GET') {
    res = await fetch(SCRIPT_URL + '?' + new URLSearchParams(Object.assign({ action }, params)), { credentials: 'include' });
  } else {
    res = await fetch(SCRIPT_URL, { method: 'POST', credentials: 'include', body: new URLSearchParams(Object.assign({ action }, params)) });
  }
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}
function showError(e) { uiAlert('Kunne ikke nå tidsbanken. Sjekk nettet og prøv igjen.' + (e && e.message ? '\n\n(' + e.message + ')' : '')); }

async function loadClass(c) {
  cls = c;
  try { state = await api('timebank_get', { class: c }, 'GET'); }
  catch (e) { state = { class: c, seconds: 0, period: 45, log: [] }; showError(e); }
  document.getElementById('tbPeriod').value = state.period;
  render();
}
// Apply a +bank / -spend on the server, adopt the returned state, re-render.
async function doAdjust(delta, label) {
  try { state = await api('timebank_adjust', { class: cls, delta: String(Math.round(delta)), label: label || '' }); render(); return true; }
  catch (e) { showError(e); return false; }
}

// ── formatting ────────────────────────────────────────────────────────────────
function fmtClock(s) { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); }
function fmtHuman(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [];
  if (h) parts.push(h + ' t');
  if (m) parts.push(m + ' min');
  if (sec) parts.push(sec + ' s');   // always show seconds (matches the student tidsbank)
  return parts.length ? parts.join(' ') : '0 s';
}
function fmtAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'nå nettopp';
  const min = Math.floor(diff / 60000);
  if (min < 60) return min + ' min siden';
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs + ' t siden';
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'i går' : days + ' dager siden';
}
function classCmp(a, b) { return (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b, 'no'); }

// ── rendering ─────────────────────────────────────────────────────────────────
function render() {
  if (!cls) return;
  const bank = state.seconds;
  document.getElementById('tbBalance').textContent = fmtHuman(bank);
  document.getElementById('tbBalanceClass').textContent = cls;

  const cost = state.period * 60;
  document.getElementById('tbFreeHint').textContent = bank >= cost
    ? 'Nok til en fritime! 🎉'
    : 'Mangler ' + fmtHuman(cost - bank) + ' til en fritime.';
  document.getElementById('tbFreeCost').textContent = 'Koster ' + fmtHuman(cost);
  document.getElementById('tbFree').disabled = bank < cost;

  renderLog();
}
function renderLog() {
  const ul = document.getElementById('tbLog');
  const log = Array.isArray(state.log) ? state.log : [];
  ul.innerHTML = '';
  if (!log.length) {
    const li = document.createElement('li');
    li.className = 'tb-log-empty';
    li.textContent = 'Ingen bevegelser ennå. Start en oppgave for å spare tid.';
    ul.appendChild(li);
    return;
  }
  log.forEach(e => {
    const li = document.createElement('li'); li.className = 'tb-log-row';
    const d = document.createElement('span');
    d.className = 'tb-log-delta ' + (e.delta >= 0 ? 'pos' : 'neg');
    d.textContent = (e.delta >= 0 ? '+' : '−') + fmtHuman(Math.abs(e.delta));
    const l = document.createElement('span'); l.className = 'tb-log-label';
    l.textContent = (e.label || '') + (e.by ? ' · @' + e.by : '');
    const t = document.createElement('span'); t.className = 'tb-log-time'; t.textContent = fmtAgo(e.ts);
    li.append(d, l, t);
    ul.appendChild(li);
  });
}

// ── timer ─────────────────────────────────────────────────────────────────────
function setPending(secs, presetEl) {
  pendingDuration = Math.max(0, Math.round(secs));
  document.querySelectorAll('#tbPresets .tb-preset').forEach(b => b.classList.toggle('active', b === presetEl));
}
function readCustom() {
  const m = parseInt(document.getElementById('tbCustomMin').value, 10) || 0;
  const s = parseInt(document.getElementById('tbCustomSec').value, 10) || 0;
  return m * 60 + s;
}
function startTimer() {
  const secs = pendingDuration || readCustom();
  if (secs <= 0) { uiAlert('Sett en tid først (velg en knapp eller skriv inn minutter).'); return; }
  duration = secs;
  endAt = Date.now() + secs * 1000;
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
  document.getElementById('tbSetup').hidden = true;
  document.getElementById('tbRunning').hidden = false;
  document.getElementById('tbRunMsg').hidden = true;
  document.getElementById('tbDone').disabled = false;
  updateCountdown();
  tick = setInterval(updateCountdown, 200);
}
function updateCountdown() {
  const remaining = Math.max(0, (endAt - Date.now()) / 1000);
  document.getElementById('tbCount').textContent = fmtClock(Math.ceil(remaining));
  const ratio = duration ? remaining / duration : 0;
  document.getElementById('tbRingFg').style.strokeDashoffset = String(RING_C * (1 - ratio));
  document.querySelector('.tb-ring-wrap').classList.toggle('low', remaining <= 15);
  if (remaining <= 0) timeUp();
}
function timeUp() {
  clearInterval(tick); tick = null;
  beep();
  document.getElementById('tbDone').disabled = true;      // nothing left to bank
  const msg = document.getElementById('tbRunMsg');
  msg.textContent = 'Tiden er ute!'; msg.className = 'tb-run-msg timeup'; msg.hidden = false;
}
async function finishTask() {
  const remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000));
  clearInterval(tick); tick = null;
  if (remaining > 0) {
    const ok = await doAdjust(remaining, 'Banket ' + fmtClock(remaining) + ' fra en oppgave');
    flashRunMsg(ok ? 'La ' + fmtHuman(remaining) + ' i banken! 🎉' : 'Kunne ikke lagre – prøv igjen.', !ok);
  } else {
    flashRunMsg('Tiden var ute – ingenting å banke denne gangen.', true);
  }
  setTimeout(resetTimer, 2200);
}
function cancelTimer() { clearInterval(tick); tick = null; resetTimer(); }
function resetTimer() {
  document.getElementById('tbRunning').hidden = true;
  document.getElementById('tbSetup').hidden = false;
  document.getElementById('tbRunMsg').hidden = true;
  document.querySelector('.tb-ring-wrap').classList.remove('low');
}
function flashRunMsg(text, warn) {
  const msg = document.getElementById('tbRunMsg');
  msg.textContent = text; msg.className = 'tb-run-msg' + (warn ? ' timeup' : ''); msg.hidden = false;
}
function beep() {
  if (!audio) return;
  try {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.5);
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + 0.5);
  } catch { /* audio not available */ }
}

// ── spend ─────────────────────────────────────────────────────────────────────
async function spend(secs) {
  if (secs <= 0) return;
  if (state.seconds < secs) { uiAlert('Ikke nok tid i banken. Du har ' + fmtHuman(state.seconds) + '.'); return; }
  await doAdjust(-secs, 'Brukte ' + fmtHuman(secs));
}
async function buyFreePeriod() {
  const cost = state.period * 60;
  if (state.seconds < cost) return;
  if (!await uiConfirm('Kjøpe en fritime for ' + fmtHuman(cost) + '? Da står det ' + fmtHuman(state.seconds - cost) + ' igjen i banken.',
      { title: 'Kjøp fritime', okText: 'Kjøp' })) return;
  await doAdjust(-cost, 'Kjøpte fritime (' + state.period + ' min)');
}

// ── controls / init ───────────────────────────────────────────────────────────
function buildControls() {
  const presets = document.getElementById('tbPresets');
  PRESETS.forEach(m => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tb-preset'; b.textContent = m + ' min';
    b.addEventListener('click', () => {
      document.getElementById('tbCustomMin').value = '';
      document.getElementById('tbCustomSec').value = '';
      setPending(m * 60, b);
    });
    presets.appendChild(b);
  });
  ['tbCustomMin', 'tbCustomSec'].forEach(id => document.getElementById(id).addEventListener('input', () => setPending(readCustom(), null)));
  document.getElementById('tbStart').addEventListener('click', startTimer);
  document.getElementById('tbDone').addEventListener('click', finishTask);
  document.getElementById('tbCancel').addEventListener('click', cancelTimer);

  const sq = document.getElementById('tbSpendQuick');
  SPEND_PRESETS.forEach(m => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tb-preset'; b.textContent = '− ' + m + ' min';
    b.addEventListener('click', () => spend(m * 60));
    sq.appendChild(b);
  });
  document.getElementById('tbSpend').addEventListener('click', () => {
    const m = parseInt(document.getElementById('tbSpendMin').value, 10) || 0;
    if (m > 0) { spend(m * 60); document.getElementById('tbSpendMin').value = ''; }
  });
  document.getElementById('tbFree').addEventListener('click', buyFreePeriod);

  const period = document.getElementById('tbPeriod');
  period.addEventListener('change', async () => {
    const m = parseInt(period.value, 10) || 45;
    try { state = await api('timebank_period', { class: cls, period: String(m) }); } catch (e) { showError(e); }
    period.value = state.period;
    render();
  });
  document.getElementById('tbAdjust').addEventListener('click', async () => {
    const v = await uiPrompt('Juster banken manuelt (minutter – kan være negativt):', { title: 'Juster tidsbanken', label: 'Minutter', okText: 'Juster' });
    const m = parseInt(v, 10);
    if (isNaN(m) || m === 0) return;
    await doAdjust(m * 60, 'Manuell justering');
  });
  document.getElementById('tbReset').addEventListener('click', async () => {
    if (!await uiConfirm('Nullstille tidsbanken for ' + cls + '? Både saldo og historikk slettes. Dette kan ikke angres.',
        { title: 'Nullstill', okText: 'Nullstill', danger: true })) return;
    try { state = await api('timebank_reset', { class: cls }); render(); } catch (e) { showError(e); }
  });
}

function buildClassPicker() {
  const sel = document.getElementById('tbClass');
  sel.innerHTML = '';
  classes.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
  sel.addEventListener('change', () => {
    if (tick) cancelTimer();
    localStorage.setItem(CLASS_KEY, sel.value);
    loadClass(sel.value);
  });
}

async function init() {
  document.getElementById('tbTheme').addEventListener('click', () => { if (window.UPTheme) UPTheme.cycle(); });

  let me;
  try { me = await (await fetch(SCRIPT_URL + '?action=me', { credentials: 'include' })).json(); }
  catch { me = { error: 'network' }; }
  if (!me || me.error) { location.replace('teacher.html'); return; }   // not a teacher session → login

  let list = [...(me.classes || []), ...(me.kontakt || [])];
  if (!list.length) {
    try { const cfg = await (await fetch(SCRIPT_URL + '?action=config')).json(); list = (cfg.grades || []).flatMap(g => g.classes || []); }
    catch { list = []; }
  }
  classes = [...new Set(list.filter(Boolean))].sort(classCmp);
  if (!classes.length) { document.getElementById('tbGate').textContent = 'Ingen klasser funnet. Legg til klasser i profilen på lærersiden.'; return; }

  buildClassPicker();
  buildControls();
  let start = localStorage.getItem(CLASS_KEY);
  if (!classes.includes(start)) start = classes[0];
  document.getElementById('tbClass').value = start;

  document.getElementById('tbGate').hidden = true;
  document.getElementById('tbMain').hidden = false;
  await loadClass(start);

  // Shared bank: pick up other teachers' changes when returning to the tab.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && cls && !tick) loadClass(cls); });
}

window.addEventListener('DOMContentLoaded', init);
