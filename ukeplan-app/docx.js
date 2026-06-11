'use strict';

// =============================================================
// Minimal, dependency-free .docx generator.
//
// Builds a valid OOXML (.docx) package = a ZIP archive with
// [Content_Types].xml, _rels/.rels and word/document.xml. The ZIP
// is written with the STORE method (no compression) so we only
// need a CRC-32; no external library required.
//
// Loaded after rich.js (uses sanitizeHtml for the HTML→text step).
// =============================================================

// ─── CRC-32 ───────────────────────────────────────────────────
var _crcTable = (function () {
  var t = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < u8.length; i++) c = _crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ─── ZIP (store method) ───────────────────────────────────────
function makeZip(entries) {
  var enc = function (s) { return new TextEncoder().encode(s); };
  var parts = [], central = [], offset = 0;

  entries.forEach(function (e) {
    var nameU8 = enc(e.name);
    var data   = e.data;
    var crc    = crc32(data);

    var lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0, true);
    lh.setUint16(8, 0, true);          // store
    lh.setUint16(10, 0, true);         // time
    lh.setUint16(12, 0x21, true);      // date (fixed: 1980-01-01)
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameU8.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), nameU8, data);

    var cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameU8.length, true);
    cd.setUint16(30, 0, true);
    cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true);
    cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameU8);

    offset += 30 + nameU8.length + data.length;
  });

  var centralSize = central.reduce(function (n, c) { return n + c.length; }, 0);
  var eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);

  return new Blob(parts.concat(central, [new Uint8Array(eocd.buffer)]),
    { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

// ─── WordprocessingML helpers ─────────────────────────────────
function _xmlEsc(s) {
  return String(s).replace(/[&<>'"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[c];
  });
}

// Stored HTML → plain text, preserving line breaks.
function htmlToPlain(html) {
  var tmp = document.createElement('div');
  tmp.innerHTML = (typeof sanitizeHtml === 'function' ? sanitizeHtml(html) : (html || '')).replace(/<br\s*\/?>/gi, '\n');
  return (tmp.textContent || '').trim();
}

function docRun(text, opts) {
  opts = opts || {};
  var rpr = '';
  if (opts.bold) rpr += '<w:b/>';
  if (opts.size) rpr += '<w:sz w:val="' + opts.size + '"/>';
  if (opts.color) rpr += '<w:color w:val="' + opts.color + '"/>';
  rpr = rpr ? '<w:rPr>' + rpr + '</w:rPr>' : '';
  var lines = _xmlEsc(text).split('\n');
  var body = lines.map(function (ln, i) {
    return (i ? '<w:br/>' : '') + '<w:t xml:space="preserve">' + ln + '</w:t>';
  }).join('');
  return '<w:r>' + rpr + body + '</w:r>';
}

function docPara(runsXml, opts) {
  opts = opts || {};
  var ppr = '';
  if (opts.spacingBefore) ppr += '<w:spacing w:before="' + opts.spacingBefore + '"/>';
  ppr = ppr ? '<w:pPr>' + ppr + '</w:pPr>' : '';
  return '<w:p>' + ppr + (runsXml || '') + '</w:p>';
}

// weeks: [{ heading, fields: [{label, text}] }]  (fields with empty text are skipped)
function buildDocx(title, subtitle, weeks) {
  var paras = [];
  paras.push(docPara(docRun(title, { bold: true, size: 36 })));
  if (subtitle) paras.push(docPara(docRun(subtitle, { size: 24, color: '666666' })));

  weeks.forEach(function (wk) {
    paras.push(docPara(docRun(wk.heading, { bold: true, size: 28 }), { spacingBefore: 280 }));
    (wk.fields || []).forEach(function (f) {
      if (!f.text) return;
      paras.push(docPara(docRun(f.label + ': ', { bold: true }) + docRun(f.text), { spacingBefore: 60 }));
    });
  });

  var documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + paras.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>' +
    '</w:body></w:document>';

  var contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  var rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  var enc = function (s) { return new TextEncoder().encode(s); };
  return makeZip([
    { name: '[Content_Types].xml', data: enc(contentTypes) },
    { name: '_rels/.rels',         data: enc(rels) },
    { name: 'word/document.xml',   data: enc(documentXml) },
  ]);
}

function saveBlob(blob, filename) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}
