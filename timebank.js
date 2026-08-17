'use strict';

// Tidsbank – a per-class "time bank": bank leftover time from timed tasks, spend
// it to leave early or buy a free period. Storage is browser-local (per class,
// this device) behind a tiny getBank/setBank layer, so swapping to a shared
// server store later is a localised change. Gated on the teacher session.

const SCRIPT_URL = 'https://api.ukeportalen.no';
const RING_C = 339.29;                 // 2·π·54, matches the SVG + CSS dash-array
const PRESETS = [1, 2, 3, 5];          // timer presets (minutes)
const SPEND_PRESETS = [1, 2, 5];       // quick-spend presets (minutes)

let classes = [];
let cls = null;
let pendingDuration = 0;               // seconds the next timer will run
let duration = 0;                      // seconds the running timer was set to
let endAt = 0;                         // ms epoch the running timer ends
let tick = null;                       // interval id
let audio = null;                      // AudioContext (created on first Start)

// ── storage (browser-local) ───────────────────────────────────────────────────
const bankKey = c => 'up_tb_bank_' + c;
const logKey  = c => 'up_tb_log_' + c;
const PERIOD_KEY = 'up_tb_period';     // free-period length (minutes), global
const CLASS_KEY  = 'up_tb_class';

function getBank(c) { return Math.max(0, parseInt(localStorage.getItem(bankKey(c)) || '0', 10) || 0); }
function setBank(c, s) { localStorage.setItem(bankKey(c), String(Math.max(0, Math.round(s)))); }
function getLog(c) { try { const a = JSON.parse(localStorage.getItem(logKey(c)) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function pushLog(c, entry) { const a = getLog(c); a.unshift(entry); localStorage.setItem(logKey(c), JSON.stringify(a.slice(0, 30))); }
function getPeriod() { const v = parseInt(localStorage.getItem(PERIOD_KEY) || '45', 10); return (v >= 1 && v <= 240) ? v : 45; }
function setPeriod(m) { localStorage.setItem(PERIOD_KEY, String(Math.min(240, Math.max(1, Math.round(m))))); }

// Apply a change to the bank (+bank / -spend), log it, re-render.
function adjust(c, deltaSecs, label) {
  const before = getBank(c);
  setBank(c, before + deltaSecs);
  pushLog(c, { ts: Date.now(), delta: Math.round(deltaSecs), label });
  render();
}

// ── formatting ────────────────────────────────────────────────────────────────
function fmtClock(s) { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); }
function fmtHuman(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [];
  if (h) parts.push(h + ' t');
  if (m) parts.push(m + ' min');
  if (sec && !h) parts.push(sec + ' s');
  return parts.length ? parts.join(' ') : '0 min';
}
function fmtAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'nå nettopp';
  const min = Math.floor(diff / 60000);
  if (min < 60) return min + ' min siden';
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs + ' t siden';
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'i går';
  return days + ' dager siden';
}
function classCmp(a, b) { return (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b, 'no'); }

// ── rendering ─────────────────────────────────────────────────────────────────
function render() {
  if (!cls) return;
  const bank = getBank(cls);
  document.getElementById('tbBalance').textContent = fmtHuman(bank);
  document.getElementById('tbBalanceClass').textContent = cls;

  const cost = getPeriod() * 60;
  const hint = document.getElementById('tbFreeHint');
  hint.textContent = bank >= cost
    ? 'Nok til en fri time! 🎉'
    : 'Mangler ' + fmtHuman(cost - bank) + ' til en fri time.';

  const free = document.getElementById('tbFree');
  document.getElementById('tbFreeCost').textContent = 'Koster ' + fmtHuman(cost);
  free.disabled = bank < cost;

  renderLog();
}

function renderLog() {
  const ul = document.getElementById('tbLog');
  const log = getLog(cls);
  ul.innerHTML = '';
  if (!log.length) {
    const li = document.createElement('li');
    li.className = 'tb-log-empty';
    li.textContent = 'Ingen bevegelser ennå. Start en oppgave for å spare tid.';
    ul.appendChild(li);
    return;
  }
  log.forEach(e => {
    const li = document.createElement('li');
    li.className = 'tb-log-row';
    const d = document.createElement('span');
    d.className = 'tb-log-delta ' + (e.delta >= 0 ? 'pos' : 'neg');
    d.textContent = (e.delta >= 0 ? '+' : '−') + fmtHuman(Math.abs(e.delta));
    const l = document.createElement('span'); l.className = 'tb-log-label'; l.textContent = e.label || '';
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
  msg.textContent = 'Tiden er ute!';
  msg.className = 'tb-run-msg timeup';
  msg.hidden = false;
}
function finishTask() {
  const remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000));
  clearInterval(tick); tick = null;
  if (remaining > 0) {
    adjust(cls, remaining, 'Banket ' + fmtClock(remaining) + ' fra en oppgave');
    flashRunMsg('La ' + fmtHuman(remaining) + ' i banken! 🎉', false);
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
function flashRunMsg(text, timeup) {
  const msg = document.getElementById('tbRunMsg');
  msg.textContent = text; msg.className = 'tb-run-msg' + (timeup ? ' timeup' : ''); msg.hidden = false;
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
function spend(secs) {
  if (secs <= 0) return;
  const bank = getBank(cls);
  if (bank < secs) { uiAlert('Ikke nok tid i banken. Du har ' + fmtHuman(bank) + '.'); return; }
  adjust(cls, -secs, 'Brukte ' + fmtHuman(secs));
}
async function buyFreePeriod() {
  const cost = getPeriod() * 60, bank = getBank(cls);
  if (bank < cost) return;
  if (!await uiConfirm('Kjøpe en fri time for ' + fmtHuman(cost) + '? Da står det ' + fmtHuman(bank - cost) + ' igjen i banken.',
      { title: 'Kjøp fri time', okText: 'Kjøp', danger: false })) return;
  adjust(cls, -cost, 'Kjøpte fri time (' + getPeriod() + ' min)');
}

// ── build static controls ─────────────────────────────────────────────────────
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
  period.value = getPeriod();
  period.addEventListener('change', () => { setPeriod(parseInt(period.value, 10) || 45); period.value = getPeriod(); render(); });

  document.getElementById('tbAdjust').addEventListener('click', async () => {
    const v = await uiPrompt('Juster banken manuelt (minutter – kan være negativt):', { title: 'Juster tidsbanken', label: 'Minutter', okText: 'Juster' });
    const m = parseInt(v, 10);
    if (isNaN(m) || m === 0) return;
    adjust(cls, m * 60, 'Manuell justering');
  });
  document.getElementById('tbReset').addEventListener('click', async () => {
    if (!await uiConfirm('Nullstille tidsbanken for ' + cls + '? Både saldo og historikk slettes. Dette kan ikke angres.',
        { title: 'Nullstill', okText: 'Nullstill', danger: true })) return;
    setBank(cls, 0);
    localStorage.removeItem(logKey(cls));
    render();
  });
}

function buildClassPicker() {
  const sel = document.getElementById('tbClass');
  sel.innerHTML = '';
  classes.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
  sel.addEventListener('change', () => {
    if (tick) cancelTimer();
    cls = sel.value;
    localStorage.setItem(CLASS_KEY, cls);
    render();
  });
}

// ── init / session gate ───────────────────────────────────────────────────────
async function init() {
  document.getElementById('tbTheme').addEventListener('click', () => { if (window.UPTheme) UPTheme.cycle(); });

  let me;
  try { me = await (await fetch(SCRIPT_URL + '?action=me', { credentials: 'include' })).json(); }
  catch { me = { error: 'network' }; }
  if (!me || me.error) { location.replace('teacher.html'); return; }   // not a teacher session → send to login

  let list = [...(me.classes || []), ...(me.kontakt || [])];
  if (!list.length) {
    try { const cfg = await (await fetch(SCRIPT_URL + '?action=config')).json(); list = (cfg.grades || []).flatMap(g => g.classes || []); }
    catch { list = []; }
  }
  classes = [...new Set(list.filter(Boolean))].sort(classCmp);
  if (!classes.length) { document.getElementById('tbGate').textContent = 'Ingen klasser funnet. Legg til klasser i profilen på lærersiden.'; return; }

  buildClassPicker();
  cls = localStorage.getItem(CLASS_KEY);
  if (!classes.includes(cls)) cls = classes[0];
  document.getElementById('tbClass').value = cls;

  buildControls();
  document.getElementById('tbGate').hidden = true;
  document.getElementById('tbMain').hidden = false;
  render();
}

window.addEventListener('DOMContentLoaded', init);
