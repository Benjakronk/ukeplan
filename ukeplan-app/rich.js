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

// ─── Floating toolbar ─────────────────────────────────────────

let _richToolbar = null;

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

function addLinkCmd() {
  const url = prompt('Lenke-URL (https://…):');
  if (!url) return;
  if (!/^(https?:|mailto:)/i.test(url)) { alert('Bruk en URL som starter med https:// eller mailto:'); return; }
  document.execCommand('createLink', false, url);
}

function positionRichToolbar(editor) {
  const bar = ensureRichToolbar();
  bar.style.display = 'flex';
  const r = editor.getBoundingClientRect();
  bar.style.top  = (window.scrollY + r.top - bar.offsetHeight - 6) + 'px';
  bar.style.left = (window.scrollX + r.left) + 'px';
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
