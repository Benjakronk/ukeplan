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

function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  return serializeClean(tpl.content).replace(/(<br>\s*)+$/i, '').trim();
}

function serializeClean(parent) {
  let out = '';
  parent.childNodes.forEach(node => {
    if (node.nodeType === 3) { out += escapeHtml(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'BR') { out += '<br>'; return; }
    if (tag === 'A') {
      const href = node.getAttribute('href') || '';
      if (/^(https?:|mailto:)/i.test(href)) {
        out += '<a href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer">' + serializeClean(node) + '</a>';
      } else {
        out += serializeClean(node); // drop unsafe link, keep its text
      }
      return;
    }
    if (tag === 'B' || tag === 'STRONG') { out += '<strong>' + serializeClean(node) + '</strong>'; return; }
    if (tag === 'I' || tag === 'EM')     { out += '<em>' + serializeClean(node) + '</em>'; return; }
    if (tag === 'U')                     { out += '<u>' + serializeClean(node) + '</u>'; return; }
    if (tag === 'DIV' || tag === 'P')    { out += serializeClean(node) + '<br>'; return; } // block → line break
    out += serializeClean(node); // unknown tag: keep contents only
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
