'use strict';

// =============================================================
// Shared rich-text utilities (loaded before script.js / teacher.js)
//
// Teachers format text with a small floating toolbar (bold /
// underline / link). Content is stored as a CONSTRAINED HTML
// subset and sanitized both on save and on render, so nothing
// dangerous from the shared sheet can reach a student's browser.
//
// Allowed: <strong> <em> <u> <a href> <br>. Everything else is
// reduced to its text content; block elements become line breaks.
// =============================================================

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const BLOCK_TAGS = { DIV: 1, P: 1, LI: 1 };

function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  const lines = serializeLines(tpl.content);
  // A trailing blank line is never meaningful; drop it. But KEEP leading and
  // interior blanks – a teacher may deliberately open a beskjed with a blank
  // line or separate paragraphs with one.
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('<br>').trim();
}

// Serialize a contenteditable subtree into an array of visual lines (inline HTML).
// Line breaks come from <br> and from block boundaries; a block's own filler <br>
// (Chrome's empty-line marker) is NOT double-counted, so one blank line stays one
// blank line and re-editing is idempotent (the old serializer grew blanks each
// save because <div><br></div> became <br> + a block <br>).
function serializeLines(parent) {
  const lines = [''];
  const append = html => { lines[lines.length - 1] += html; };
  const brk = () => lines.push('');
  parent.childNodes.forEach(node => {
    if (node.nodeType === 3) { append(escapeHtml(node.nodeValue)); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'BR') { brk(); return; }
    if (BLOCK_TAGS[tag]) {
      if (lines[lines.length - 1] !== '') brk();          // block starts a fresh line
      const sub = serializeLines(node);
      if (sub.length > 1 && sub[sub.length - 1] === '') sub.pop();  // drop filler-<br> line
      append(sub[0]);
      for (let i = 1; i < sub.length; i++) lines.push(sub[i]);
      brk();                                              // next sibling on a new line
      return;
    }
    append(serializeInlineTag(node));                     // strong/em/u/a → inline HTML
  });
  return lines;
}

// Inline (non-block) element → cleaned inline HTML, keeping <br> literal.
function serializeInlineTag(node) {
  const tag = node.tagName;
  if (tag === 'BR') return '<br>';
  if (tag === 'A') {
    const href = node.getAttribute('href') || '';
    if (/^(https?:|mailto:)/i.test(href)) {
      return '<a href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer">' + serializeInlineChildren(node) + '</a>';
    }
    return serializeInlineChildren(node);   // drop unsafe link, keep its text
  }
  if (tag === 'B' || tag === 'STRONG') return '<strong>' + serializeInlineChildren(node) + '</strong>';
  if (tag === 'I' || tag === 'EM')     return '<em>' + serializeInlineChildren(node) + '</em>';
  if (tag === 'U')                     return '<u>' + serializeInlineChildren(node) + '</u>';
  // A block that turned up in inline context (e.g. a pasted <div> inside <strong>):
  // keep its content, mark the break so nothing merges onto one line.
  if (BLOCK_TAGS[tag]) return serializeInlineChildren(node) + '<br>';
  return serializeInlineChildren(node);     // unknown tag: keep contents only
}

function serializeInlineChildren(node) {
  let out = '';
  node.childNodes.forEach(ch => {
    if (ch.nodeType === 3) { out += escapeHtml(ch.nodeValue); return; }
    if (ch.nodeType === 1) out += serializeInlineTag(ch);
  });
  return out;
}

// Set element content from stored HTML, sanitized.
function renderRich(el, html) {
  el.innerHTML = sanitizeHtml(html);
}
// Plain-text fallback (e.g. titles / aria labels) from stored HTML.
function richToText(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = sanitizeHtml(html);
  return (tpl.content.textContent || '').trim();
}

// =============================================================
// In-app dialogs (replace native alert / confirm / prompt)
// Built dynamically and styled via .ui-dialog* in styles.css, so
// they work on both the student and teacher pages without markup.
// =============================================================

function _uiLabelledInput(labelText, value, placeholder, type) {
  const field = document.createElement('label');
  field.className = 'ui-dialog-field';
  if (labelText) {
    const span = document.createElement('span');
    span.className = 'ui-dialog-label';
    span.textContent = labelText;
    field.appendChild(span);
  }
  const input = document.createElement('input');
  input.className = 'ui-dialog-input';
  input.type = type || 'text';
  input.value = value || '';
  if (placeholder) input.placeholder = placeholder;
  field.appendChild(input);
  return { field, input };
}

// Core builder. `render(ctx)` may add fields to ctx.body and return a map of
// elements; `buttons[].onClick(ctx, fields)` returns the resolve value, or
// `undefined` to keep the dialog open (e.g. after ctx.setError on a bad input).
function buildUiDialog({ title, render, buttons, initialFocus }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'ui-dialog-overlay';
    const modal = document.createElement('div');
    modal.className = 'ui-dialog';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    if (title) {
      const h = document.createElement('h2');
      h.className = 'ui-dialog-title';
      h.textContent = title;
      modal.appendChild(h);
    }
    const body = document.createElement('div');
    body.className = 'ui-dialog-body';
    modal.appendChild(body);

    const errEl = document.createElement('p');
    errEl.className = 'ui-dialog-error';
    errEl.hidden = true;
    modal.appendChild(errEl);

    const actions = document.createElement('div');
    actions.className = 'ui-dialog-actions';
    modal.appendChild(actions);

    let done = false;
    function finish(value) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      modal.remove();
      // Keep the body locked if another dialog or modal is still open underneath.
      if (!document.querySelector('.ui-dialog, .class-modal.open')) document.body.classList.remove('scroll-locked');
      resolve(value);
    }
    const ctx = { body, setError: m => { errEl.textContent = m || ''; errEl.hidden = !m; }, finish };
    const fields = render ? (render(ctx) || {}) : {};

    let primaryBtn = null;
    buttons.forEach(spec => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (spec.className || 'btn-ghost');
      b.textContent = spec.label;
      b.addEventListener('click', () => {
        const r = spec.onClick ? spec.onClick(ctx, fields) : spec.value;
        if (r === undefined) return;   // validation kept it open
        finish(r);
      });
      actions.appendChild(b);
      if (spec.primary) primaryBtn = b;
    });

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); return; }
      if (e.key === 'Enter') {
        const t = e.target;
        const multiline = t && (t.tagName === 'TEXTAREA' || t.isContentEditable);
        if (!multiline && primaryBtn) { e.preventDefault(); primaryBtn.click(); }
      }
    }

    overlay.addEventListener('click', () => finish(null));
    document.body.appendChild(overlay);
    document.body.appendChild(modal);
    document.body.classList.add('scroll-locked');
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => {
      const el = (initialFocus && modal.querySelector(initialFocus)) || primaryBtn;
      if (el) el.focus();
    }, 30);
  });
}

function uiAlert(message, opts = {}) {
  return buildUiDialog({
    title: opts.title || 'Melding',
    render: ctx => { const p = document.createElement('p'); p.className = 'ui-dialog-message'; p.textContent = message; ctx.body.appendChild(p); },
    buttons: [{ label: opts.okText || 'OK', className: 'btn-primary', primary: true, value: true }],
  });
}

function uiConfirm(message, opts = {}) {
  return buildUiDialog({
    title: opts.title || 'Bekreft',
    render: ctx => { const p = document.createElement('p'); p.className = 'ui-dialog-message'; p.textContent = message; ctx.body.appendChild(p); },
    buttons: [
      { label: opts.cancelText || 'Avbryt', className: 'btn-ghost', value: false },
      { label: opts.okText || 'OK', className: opts.danger ? 'btn-danger' : 'btn-primary', primary: true, value: true },
    ],
  }).then(v => v === true);
}

function uiPrompt(message, opts = {}) {
  return buildUiDialog({
    title: opts.title || 'Skriv inn',
    initialFocus: '.ui-dialog-input',
    render: ctx => {
      if (message) { const p = document.createElement('p'); p.className = 'ui-dialog-message'; p.textContent = message; ctx.body.appendChild(p); }
      const f = _uiLabelledInput(opts.label || '', opts.value || '', opts.placeholder || '', opts.password ? 'password' : 'text');
      ctx.body.appendChild(f.field);
      return { input: f.input };
    },
    buttons: [
      { label: opts.cancelText || 'Avbryt', className: 'btn-ghost', value: null },
      { label: opts.okText || 'OK', className: 'btn-primary', primary: true, onClick: (ctx, f) => f.input.value },
    ],
  }).then(v => (v == null ? null : v));
}

// URL + optional display text in one modal. Resolves { url, text } or null.
function uiLinkDialog(opts = {}) {
  return buildUiDialog({
    title: 'Sett inn lenke',
    initialFocus: '.ui-dialog-input',
    render: ctx => {
      const u = _uiLabelledInput('Lenke-URL', opts.url || '', 'https://… eller mailto:…');
      const t = _uiLabelledInput('Visningstekst (valgfritt)', opts.text || '', 'Teksten som vises');
      ctx.body.appendChild(u.field);
      ctx.body.appendChild(t.field);
      return { url: u.input, text: t.input };
    },
    buttons: [
      { label: 'Avbryt', className: 'btn-ghost', value: null },
      { label: 'Sett inn', className: 'btn-primary', primary: true, onClick: (ctx, f) => {
        let url = f.url.value.trim();
        if (!url) { ctx.setError('Skriv inn en URL.'); return undefined; }
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;   // assume https:// if no scheme
        if (!/^(https?:|mailto:)/i.test(url)) { ctx.setError('Bruk en URL som starter med https:// eller mailto:'); return undefined; }
        return { url, text: f.text.value.trim() };
      } },
    ],
  });
}

// Week picker: pick from a dropdown OR type a week number. `weeks` is an array
// of { value, weekNo, label } (value = Monday ISO). Resolves the chosen value
// (Monday ISO) or null.
function uiWeekPicker(opts = {}) {
  const weeks = opts.weeks || [];
  const current = opts.current || (weeks[0] && weeks[0].value) || '';
  return buildUiDialog({
    title: opts.title || 'Gå til uke',
    initialFocus: '.ui-week-num',
    render: ctx => {
      const numField = _uiLabelledInput('Skriv ukenummer', '', 'f.eks. 39', 'number');
      numField.input.classList.add('ui-week-num');
      numField.input.min = '1'; numField.input.max = '53';
      ctx.body.appendChild(numField.field);

      const selField = document.createElement('label');
      selField.className = 'ui-dialog-field';
      const span = document.createElement('span');
      span.className = 'ui-dialog-label';
      span.textContent = 'eller velg fra lista';
      selField.appendChild(span);
      const sel = document.createElement('select');
      sel.className = 'ui-dialog-input ui-week-sel';
      weeks.forEach(w => {
        const o = document.createElement('option');
        o.value = w.value; o.textContent = w.label;
        if (w.value === current) o.selected = true;
        sel.appendChild(o);
      });
      selField.appendChild(sel);
      ctx.body.appendChild(selField);

      // Typing a week number jumps the dropdown to the matching week.
      numField.input.addEventListener('input', () => {
        const n = parseInt(numField.input.value, 10);
        const match = weeks.find(w => w.weekNo === n);
        if (match) { sel.value = match.value; ctx.setError(''); }
      });
      sel.addEventListener('change', () => { numField.input.value = ''; ctx.setError(''); });
      return { num: numField.input, sel };
    },
    buttons: [
      { label: 'Avbryt', className: 'btn-ghost', value: null },
      { label: 'Gå til uke', className: 'btn-primary', primary: true, onClick: (ctx, f) => {
        if (f.num.value !== '') {
          const n = parseInt(f.num.value, 10);
          const match = weeks.find(w => w.weekNo === n);
          if (!match) { ctx.setError('Fant ikke uke ' + f.num.value + ' i skoleåret.'); return undefined; }
          return match.value;
        }
        return f.sel.value || null;
      } },
    ],
  });
}

// ─── Floating toolbar ─────────────────────────────────────────

let _richToolbar = null;
let _activeRichField = null;   // the rich field the toolbar currently acts on

function ensureRichToolbar() {
  if (_richToolbar) return _richToolbar;
  const bar = document.createElement('div');
  bar.className = 'rich-toolbar';
  const mkBtn = (html, title, cmd) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rich-btn';
    b.title = title;
    b.innerHTML = html;
    b.addEventListener('mousedown', e => e.preventDefault()); // keep the editor's selection
    b.addEventListener('click', e => { e.preventDefault(); cmd(); });
    return b;
  };
  bar.appendChild(mkBtn('<b>F</b>', 'Fet (Ctrl+B)', () => document.execCommand('bold')));
  bar.appendChild(mkBtn('<u>U</u>', 'Understrek (Ctrl+U)', () => document.execCommand('underline')));
  bar.appendChild(mkBtn('🔗', 'Lenke', addLinkCmd));
  bar.appendChild(mkBtn('⌫', 'Fjern formatering', () => { document.execCommand('removeFormat'); document.execCommand('unlink'); }));
  document.body.appendChild(bar);
  _richToolbar = bar;
  return bar;
}

// Insert a link via an in-app modal that also takes the display text. The
// editor's selection is captured first and restored after the modal closes
// (the blur-driven reset is suppressed via ed._linking so the saved Range
// stays valid).
async function addLinkCmd() {
  const ed = _activeRichField;
  if (!ed) return;
  const sel = window.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const selectedText = sel ? sel.toString() : '';

  ed._linking = true;
  hideRichToolbar();
  const result = await uiLinkDialog({ url: '', text: selectedText });

  ed.focus();
  if (range) { sel.removeAllRanges(); sel.addRange(range); }
  if (result) {
    const { url, text } = result;
    if (text && text !== selectedText) {
      document.execCommand('insertHTML', false, '<a href="' + escapeAttr(url) + '">' + escapeHtml(text) + '</a>');
    } else if (selectedText) {
      document.execCommand('createLink', false, url);
    } else {
      document.execCommand('insertHTML', false, '<a href="' + escapeAttr(url) + '">' + escapeHtml(url) + '</a>');
    }
  }
  ed._linking = false;
}

function positionRichToolbar(editor) {
  _activeRichField = editor;
  const bar = ensureRichToolbar();
  bar.style.display = 'flex';
  const r    = editor.getBoundingClientRect();
  const barH = bar.offsetHeight || 36;
  const barW = bar.offsetWidth  || 140;
  const vw   = document.documentElement.clientWidth;
  // Above the field by default; drop below when there isn't room near the top.
  let top = (r.top - barH - 6 < 4) ? (window.scrollY + r.bottom + 6)
                                   : (window.scrollY + r.top - barH - 6);
  // Keep it inside the viewport horizontally.
  let left = window.scrollX + r.left;
  const maxLeft = window.scrollX + vw - barW - 6;
  if (left > maxLeft) left = maxLeft;
  if (left < window.scrollX + 6) left = window.scrollX + 6;
  bar.style.top  = top + 'px';
  bar.style.left = left + 'px';
}
function hideRichToolbar() { if (_richToolbar) _richToolbar.style.display = 'none'; }

// ─── Editable rich field ──────────────────────────────────────
// Returns a contenteditable element. `onCommit(cleanHtml, el)` fires
// on blur only when the sanitized content actually changed.

function createRichField(opts) {
  const ed = document.createElement('div');
  ed.className = 'rich-field' + (opts.className ? ' ' + opts.className : '');
  ed.contentEditable = 'true';
  ed.setAttribute('role', 'textbox');
  ed.setAttribute('aria-multiline', 'true');
  if (opts.placeholder) ed.dataset.placeholder = opts.placeholder;
  ed.innerHTML = sanitizeHtml(opts.value || '');
  ed._original = ed.innerHTML;

  ed.addEventListener('focus', () => positionRichToolbar(ed));
  ed.addEventListener('input', () => positionRichToolbar(ed));
  ed.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ed.blur(); }
  });
  ed.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement === ed) return; // toolbar click kept focus
      if (ed._linking) return;                   // link dialog is managing focus
      hideRichToolbar();
      const clean = sanitizeHtml(ed.innerHTML);
      if (clean !== ed._original) {
        ed._original = clean;
        ed.innerHTML = clean;
        opts.onCommit(clean, ed);
      } else {
        ed.innerHTML = clean;
      }
    }, 60);
  });
  return ed;
}

// ─── Theme preference (shared: student + teacher) ──────────────
// pref ∈ {'auto','light','dark'}. 'auto' follows the OS (prefers-color-scheme);
// 'light'/'dark' set data-theme on <html> to override. The pre-paint script in
// each page's <head> applies a saved override early; this is the runtime API.
(function () {
  const THEME_KEY = 'up_theme';
  function get() {
    try { const t = localStorage.getItem(THEME_KEY); return (t === 'light' || t === 'dark') ? t : 'auto'; }
    catch (e) { return 'auto'; }
  }
  function set(pref) {
    const root = document.documentElement;
    if (pref === 'light' || pref === 'dark') root.setAttribute('data-theme', pref);
    else { root.removeAttribute('data-theme'); pref = 'auto'; }
    try { if (pref === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, pref); }
    catch (e) { /* private mode – runtime still works via data-theme */ }
    document.dispatchEvent(new CustomEvent('up-themechange', { detail: { pref } }));
    return pref;
  }
  function effective() {
    const p = get();
    if (p !== 'auto') return p;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function cycle() {
    const order = ['auto', 'light', 'dark'];
    return set(order[(order.indexOf(get()) + 1) % order.length]);
  }
  window.UPTheme = { get, set, effective, cycle };
})();

// ─── UPJourney: the onboarding "journey" progress bar ──────────────────────────
// A self-contained isometric SVG progress bar (zig-zag coin nodes with a raised
// underside, a flagged destination node, and a gliding map-pin marker with a
// victory hop). Shared by the teacher + student onboarding wizards; driven purely
// by a node set + a (filled, pointer) pair, no page-specific coupling.
//   build(container, nodes)   nodes = an [[x,y],…] array OR an integer node count
//                             (evenly-spaced zig-zag is computed). Stashes the
//                             coords on the container for update().
//   update(container, filled, pointer)   1-based: colour up to `filled`, park the
//                             pin above node `pointer`.
//   victory(container)        replay the pin's little hop (on the final step).
(function () {
  function computeNodes(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = n <= 1 ? 160 : Math.round((18 + i * (280 / (n - 1))) * 10) / 10;
      out.push([x, i % 2 ? 16 : 32]);
    }
    return out;
  }
  function build(container, nodesOrCount) {
    if (!container) return;
    const nodes = Array.isArray(nodesOrCount) ? nodesOrCount : computeNodes(nodesOrCount);
    container._journeyNodes = nodes;
    container.hidden = false;
    let segs = '', ns = '';
    for (let j = 0; j < nodes.length - 1; j++) {
      const [ax, ay] = nodes[j], [bx, by] = nodes[j + 1];
      segs += `<g class="oseg" data-j="${j}">`
        + `<line class="oseg-base" x1="${ax}" y1="${ay + 3}" x2="${bx}" y2="${by + 3}"/>`
        + `<line class="oseg-face" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/></g>`;
    }
    nodes.forEach(([x, y], i) => {
      const goal = i === nodes.length - 1;
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
      ns += g + '</g>';
    });
    const pin = '<g class="opointer"><g class="opointer-bob">'
      + '<path class="opointer-body" d="M0 0 C -3 -5 -6 -7.5 -6 -11 A 6 6 0 1 1 6 -11 C 6 -7.5 3 -5 0 0 Z"/>'
      + '<circle class="opointer-hole" cx="0" cy="-11" r="2.4"/></g></g>';
    container.innerHTML = `<svg class="onboard-journey" viewBox="0 -14 320 58" role="img" aria-label="Fremdrift i oppsett">${segs}${ns}${pin}</svg>`;
  }
  function update(container, filled, pointerNode) {
    if (!container) return;
    const nodes = container._journeyNodes || [];
    container.querySelectorAll('.onode').forEach(c => {
      const n = +c.dataset.i + 1;
      c.classList.toggle('done', n <= filled);
      c.classList.toggle('current', n === pointerNode && n > filled);
    });
    // Colour a segment when both ends are done, or when it's the leg into the pin.
    container.querySelectorAll('.oseg').forEach(s => {
      const far = +s.dataset.j + 2;
      s.classList.toggle('done', far <= filled || far === pointerNode);
    });
    const p = container.querySelector('.opointer');
    const node = nodes[pointerNode - 1];
    if (p && node) p.style.transform = `translate(${node[0]}px, ${node[1] - 10}px)`;
  }
  function victory(container) {
    const bob = container && container.querySelector('.opointer-bob');
    if (!bob) return;
    bob.classList.remove('opointer-victory');
    void bob.offsetWidth;
    bob.classList.add('opointer-victory');
    bob.addEventListener('animationend', () => bob.classList.remove('opointer-victory'), { once: true });
  }
  window.UPJourney = { build, update, victory };
})();

// =============================================================
// Service worker registration + auto-update (shared by both pages)
//
// The SW serves the app shell network-first, so fresh HTML/JS/CSS arrive on the
// next load. This makes a DEPLOY apply without a manual hard refresh: when a new
// SW version activates (it skipWaiting()s and claims clients), every open page
// reloads itself once. `updateViaCache:'none'` keeps the browser from serving a
// stale sw.js from HTTP cache, and we re-check for a new SW whenever the tab
// regains focus so a page left open picks up a deploy on its own.
// =============================================================
(function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Whether this page was already controlled at load. If not (first-ever visit),
  // the SW's initial clients.claim() fires controllerchange once – we must NOT
  // reload then (the page already loaded fresh from the network).
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  // Don't yank the page out from under someone who's mid-edit – wait until the
  // focused field is blurred (inline edits auto-save on blur), then reload.
  const isEditing = () => {
    const a = document.activeElement;
    return !!(a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'));
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;   // skip the first-install claim
    reloading = true;
    const go = () => (isEditing() ? setTimeout(go, 1500) : window.location.reload());
    go();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
})();
