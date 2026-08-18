/* Klassekart 2.0 — Copyright Benjamin Ensrud, 2026
 * Vanilla JS, no build step. State persists to localStorage.
 *   Phase 1: paste → chart → touch-first drag/drop.
 *   Phase 2: smart auto-arrange rules engine.
 *   Phase 3: multi-class management + history.
 *   Phase 4: present mode + export (PDF / PNG / print).
 *
 * Ukeportalen build (step 1): runs as a subpage of the teacher page, gated by
 * the same `up_session` cookie. Still localStorage-only — no server sync yet.
 * Pupil names never leave the browser; the server holds none of this.
 * See ukeplan-server/docs/klassekart-integration.md.
 */
(function () {
'use strict';

/* ---------------------------------------------------------------- constants */
const SEAT_W = 116, SEAT_H = 78; // must match CSS --seat-w / --seat-h
const GIN = 10;   // gap between desks inside a group (pair / pod)
const GBET = 46;  // horizontal gap between groups
const RGAP = 58;  // vertical gap between rows
const STORAGE_KEY = 'klassekart_v3';
const OLD_KEY = 'klassekart_v2';
/* Ukeportalen API + the school-config cache teacher.js already maintains. We
 * only ever READ the config here (class codes), never write it. */
const SCRIPT_URL = 'https://api.ukeportalen.no';
const CONFIG_KEY = 'up_school_config';
const DRAG_THRESHOLD = 6;
// Edge-to-edge gap limits deciding "sitting next to each other". tight = within a
// group (≈GIN); loose = one normal desk/row gap (≈GBET/RGAP). Midpoints separate
// the two cleanly (a pair-gap of 10 vs an aisle of 46; a pod-stack 10 vs a row 58).
const ADJ_TIGHT_H = (GIN + GBET) / 2, ADJ_LOOSE_H = GBET + GIN;
const ADJ_TIGHT_V = (GIN + RGAP) / 2, ADJ_LOOSE_V = RGAP + GIN;
const GRID_X = SEAT_W + GBET, GRID_Y = SEAT_H + RGAP; // snap step for manual desk editing
const PAIR_DX = SEAT_W + GIN;   // tight horizontal "pair" spacing (desks close together)
const SEP_DX = SEAT_W + GBET;   // separated horizontal spacing (normal gap between desks/pairs)
const PAIR_DY = SEAT_H + GIN;   // tight vertical pairing (stacked desks, e.g. 2×2 pods)
const SEP_DY = SEAT_H + RGAP;   // separated vertical spacing (normal gap between rows)
const PAIR_SNAP = 46;           // how close (board px) before snapping to a neighbour offset

/* ------------------------------------------------------------------- state  */
let store = null;          // { activeClassId, classes: { id: classObj } }
let state = null;          // active class (reference into store.classes)
let boardW = 0, boardH = 0;
let selected = null;       // studentId selected via tap
let drag = null;           // active pointer drag
let suppressClick = false; // ignore the click synthesized after a real drag
let presentMode = false;
let editMode = false;      // manual desk-editing mode
let deskDrag = null;       // active desk move/add in edit mode
let boardScale = 1;        // current CSS scale of the board (set by fitBoard)
let zoom = null;           // null = auto-fit; otherwise an explicit scale factor

let _seq = 0;
function uid() { return 's' + Date.now().toString(36) + (_seq++).toString(36); }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const $ = (id) => document.getElementById(id);
const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/* ======================================================== envelope crypto ====
 * Step 2 of ukeplan-server/docs/klassekart-integration.md. The server stores
 * ciphertext and lifecycle metadata; it never holds a key that opens it, which
 * is what lets Klassekart sync at all while server-plan.md §0 ("no pupil names")
 * stays literally true.
 *
 * Two levels, deliberately:
 *
 *   recovery secret ──PBKDF2(salt, 600k)──► personal key
 *                                              │ AES-GCM
 *                                              ▼
 *                                        wrapped CEK ──► CEK (random, per group)
 *                                                          │ AES-GCM, fresh iv
 *                                                          ▼
 *                                                    chart payload
 *
 * The indirection looks redundant while a group has one member. It is what makes
 * sharing cheap later: inviting a colleague re-wraps one small key for them,
 * instead of re-encrypting every chart in the school. Getting this wrong now is
 * expensive to undo, so it lands before anything is stored.
 *
 * Nothing here is wired to the UI yet — see the tests before trusting it. */

const KK_KDF_ITERS = 600000;   // OWASP guidance for PBKDF2-HMAC-SHA256, 2023
const KK_ENV_V = 1;            // envelope format version, travels with the blob

/* bytes ⇄ base64 (same approach as the removed rel store, which worked) */
function kkB64(bytes) { let s = ''; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s); }
function kkUnb64(str) { const s = atob(str), a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }

/* ---- recovery secret -------------------------------------------------------
 * The FORMAT is isolated to these three functions on purpose — generate,
 * display, accept — because it is still an open decision (words vs code). Swap
 * them and nothing downstream changes: everything below consumes bytes.
 *
 * Current placeholder: Crockford base32, 16 chars = 80 bits. Crockford drops
 * I, L, O and U, so there is nothing to misread when a teacher copies it onto
 * paper, and decoding folds the mistakes people still make (I/l→1, O→0). */
const KK_B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function kkGenerateSecret() {
    const bytes = crypto.getRandomValues(new Uint8Array(10));   // 80 bits
    let bits = 0, acc = 0, out = '';
    for (const b of bytes) {
        acc = (acc << 8) | b; bits += 8;
        while (bits >= 5) { out += KK_B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    }
    return out.match(/.{1,4}/g).join('-');   // K7X9-M2PQ-4TRV-8WNZ
}
/* Forgiving on entry: case, spacing, dashes, and the classic misreads. */
function kkNormalizeSecret(input) {
    return String(input || '').toUpperCase()
        .replace(/[IL]/g, '1').replace(/O/g, '0')
        .replace(/[^0-9A-Z]/g, '')
        .split('').filter(c => KK_B32.includes(c)).join('');
}
function kkSecretIsWellFormed(input) { return kkNormalizeSecret(input).length === 16; }

/* ---- key derivation ------------------------------------------------------- */
/* Personal key: one PBKDF2 run per device per session, then every group's CEK
 * unwraps from it. Hence a per-teacher salt rather than per-group — six groups
 * must not mean six 600k-iteration runs on an iPad. */
async function kkPersonalKey(secret, salt) {
    const norm = kkNormalizeSecret(secret);
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(norm), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: KK_KDF_ITERS, hash: 'SHA-256' },
        km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function kkNewSalt() { return crypto.getRandomValues(new Uint8Array(16)); }

/* ---- the group key (CEK) -------------------------------------------------- */
/* Extractable on purpose: wrapping means exporting the raw bytes and encrypting
 * them under the personal key. That is also how it gets wrapped for a colleague
 * later, so the property is required, not sloppiness. */
async function kkNewCek() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function kkWrapCek(cek, wrappingKey) {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', cek));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw);
    return { v: KK_ENV_V, iv: kkB64(iv), ct: kkB64(new Uint8Array(ct)) };
}
async function kkUnwrapCek(blob, wrappingKey) {
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kkUnb64(blob.iv) }, wrappingKey, kkUnb64(blob.ct));
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

/* ---- sharing: ECDH identity keys ------------------------------------------
 * Wrapping a group key for a colleague needs a shared secret with them, and the
 * only way to get one without either party revealing a password is key agreement.
 * Each teacher therefore has a P-256 keypair: the public half sits on the server
 * in the clear, the private half wrapped under their own recovery-code key.
 *
 * Static-static ECDH, so no forward secrecy. Accepted: the inviter already knows
 * the group key, so being able to re-derive the wrapping key grants them nothing
 * they did not already have. */
async function kkNewIdentityKeys() {
    return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}
async function kkExportPub(pub) {
    return kkB64(new Uint8Array(await crypto.subtle.exportKey('spki', pub)));
}
async function kkImportPub(b64) {
    return crypto.subtle.importKey('spki', kkUnb64(b64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}
async function kkWrapPriv(priv, personalKey) {
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', priv));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, personalKey, pkcs8);
    return { v: KK_ENV_V, iv: kkB64(iv), ct: kkB64(new Uint8Array(ct)) };
}
async function kkUnwrapPriv(blob, personalKey) {
    const pkcs8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kkUnb64(blob.iv) }, personalKey, kkUnb64(blob.ct));
    return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}
/* The wrapping key for one (colleague, group, epoch). Binding the group and epoch
 * into the HKDF info means a wrap captured for one group cannot be replayed as the
 * wrap for another, and a rotated epoch produces a different key even between the
 * same two people. ECDH is symmetric, so both sides derive this identically. */
async function kkShareKey(myPriv, theirPub, groupId, epoch) {
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirPub }, myPriv, 256);
    const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({
        name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0),
        info: new TextEncoder().encode('klassekart|' + groupId + '|' + epoch),
    }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/* ---- the chart payload ---------------------------------------------------- */
/* `version` is carried INSIDE the ciphertext as well as in a plaintext column,
 * so a server that serves an older blob than it claims is detectable — AES-GCM
 * stops tampering, not rollback. */
async function kkEncryptChart(obj, cek, version) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const body = new TextEncoder().encode(JSON.stringify({ v: KK_ENV_V, version, data: obj }));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cek, body);
    return { v: KK_ENV_V, iv: kkB64(iv), ct: kkB64(new Uint8Array(ct)) };
}
async function kkDecryptChart(blob, cek, expectVersion) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kkUnb64(blob.iv) }, cek, kkUnb64(blob.ct));
    const inner = JSON.parse(new TextDecoder().decode(pt));
    if (expectVersion != null && inner.version !== expectVersion) {
        throw new Error(`kk: version mismatch (blob ${inner.version}, server ${expectVersion}) — possible rollback`);
    }
    return inner.data;
}

/* ============================================================== sync engine ==
 * Opt-in. With sync off, Klassekartografen behaves exactly as before and never
 * talks to the server about charts — which is deliberate: the recovery-code
 * ceremony must be the price of sync, never a toll on people happy as they are.
 *
 * The local store stays the working copy. `cls.sv` records the server version
 * the local copy corresponds to (0 = never synced), which is what makes
 * compare-and-set possible and conflicts detectable.
 *
 * Everything here fails soft: a network error, an expired session or a locked
 * key leaves the local chart untouched and working. Sync is a backup and a way
 * to collaborate, not a dependency. */

const SYNC_ON_KEY = 'kk_sync_on';

let kkPersonal = null;   // CryptoKey from the recovery code — memory only, this session
let kkSalt = null;       // Uint8Array, from the server (never changes once set)
let kkCeks = {};         // groupId → CryptoKey
let kkServer = {};       // groupId → { version, label, wrappedCek, method, epoch, updatedBy }
let kkConflicts = {};    // groupId → server version that refused our write
let kkPriv = null;       // my ECDH private key (unwrapped, memory only)
let kkPubs = {};         // teacherId → imported public CryptoKey
let kkDir = null;        // cached staff list from kk_teachers
let pushTimer = null;

function syncOn() { try { return localStorage.getItem(SYNC_ON_KEY) === '1'; } catch (e) { return false; } }
function syncUnlocked() { return !!kkPersonal; }

/* Persist without marking the chart dirty. Every save() inside the sync layer
 * must use this: a pull that dirties what it just fetched would push it straight
 * back, and two synced devices would then bounce versions off each other for
 * ever. */
function saveQuiet() { savingFromSync = true; try { save(); } finally { savingFromSync = false; } }

async function kkPost(action, params) {
    const res = await fetch(SCRIPT_URL, { method: 'POST', credentials: 'include',
        body: new URLSearchParams(Object.assign({ action }, params || {})) });
    const d = await res.json();
    if (d && d.error) throw new Error(d.error);
    return d;
}
async function kkGet(action, params) {
    const q = new URLSearchParams(Object.assign({ action }, params || {}));
    const res = await fetch(`${SCRIPT_URL}?${q}`, { credentials: 'include' });
    const d = await res.json();
    if (d && d.error) throw new Error(d.error);
    return d;
}

/* The payload is the class object minus local-only bookkeeping. `sv` must not
 * travel: it describes this device's relationship to the server, and including
 * it would make every push differ from the last for no reason. */
function chartPayload(cls) {
    const out = {};
    for (const k in cls) if (k !== 'sv' && k !== 'dirty') out[k] = cls[k];
    return out;
}

/* ---- identity -------------------------------------------------------------- */
/* kk_identity is insert-if-absent, so it doubles as "fetch mine": a candidate
 * salt is offered and the server returns whichever one is authoritative. */
async function kkFetchSalt() {
    const r = await kkPost('kk_identity', { salt: kkB64(kkNewSalt()) });
    return { salt: kkUnb64(r.salt), created: !!r.created, publicKey: r.publicKey || '', encPrivate: r.encPrivate || '' };
}

/* Make sure this teacher has an ECDH keypair and that we hold the private half.
 * Teachers who turned sync on before sharing existed have a salt but no keys, so
 * this doubles as their migration: generated on the next unlock and wrapped under
 * the key they already have. */
async function ensureIdentityKeys(personalKey, existing) {
    if (existing && existing.encPrivate) {
        kkPriv = await kkUnwrapPriv(JSON.parse(existing.encPrivate), personalKey);
        return { created: false };
    }
    const kp = await kkNewIdentityKeys();
    const pub = await kkExportPub(kp.publicKey);
    const enc = JSON.stringify(await kkWrapPriv(kp.privateKey, personalKey));
    const r = await kkPost('kk_identity', { salt: kkB64(kkNewSalt()), publicKey: pub, encPrivate: enc });
    // Another device may have registered a keypair first. The server sets it once,
    // so adopt whatever it reports rather than assuming ours won the race.
    if (r.encPrivate && r.encPrivate !== enc) {
        kkPriv = await kkUnwrapPriv(JSON.parse(r.encPrivate), personalKey);
        return { created: false, raced: true };
    }
    kkPriv = kp.privateKey;
    return { created: true };
}
async function staffList(force) {
    if (!kkDir || force) kkDir = (await kkGet('kk_teachers')).teachers || [];
    return kkDir;
}
async function pubKeyOf(id, b64) {
    if (kkPubs[id]) return kkPubs[id];
    if (!b64) throw new Error('Mangler offentlig nokkel for laereren');
    kkPubs[id] = await kkImportPub(b64);
    return kkPubs[id];
}

/* Turning sync on for the first time. If the server already holds an identity,
 * this teacher set sync up elsewhere — a freshly generated code would be wrong,
 * because the existing salt belongs to the old one. Say so rather than issuing a
 * code that cannot open anything. */
async function syncBegin() {
    const info = await kkFetchSalt();
    if (!info.created) return { alreadySetUp: true };
    const secret = kkGenerateSecret();
    kkSalt = info.salt;
    kkPersonal = await kkPersonalKey(secret, info.salt);
    await ensureIdentityKeys(kkPersonal, info);
    try { localStorage.setItem(SYNC_ON_KEY, '1'); } catch (e) {}
    return { secret };
}

/* Unlocking on a later device or a new session. Verification is by trying to
 * unwrap a real group key: a wrong code fails every unwrap. With no groups yet
 * there is nothing the code could be wrong about, so it is accepted — the first
 * group created then establishes it. */
async function syncUnlock(input) {
    if (!kkSecretIsWellFormed(input)) return { error: 'Koden ser ikke riktig ut. Den er 16 tegn.' };
    const info = await kkFetchSalt();
    const key = await kkPersonalKey(input, info.salt);
    const { groups } = await kkGet('kk_groups');
    const mine = groups.filter(g => g.method === 'self');
    if (mine.length) {
        let anyOpened = false;
        for (const g of mine) {
            try { await kkUnwrapCek(JSON.parse(g.wrappedCek), key); anyOpened = true; break; }
            catch (e) { /* try the next */ }
        }
        if (!anyOpened) return { error: 'Feil kode — fikk ikke opp noen av gruppene dine.' };
    } else if (info.encPrivate) {
        // No self-wrapped group to test against, but the wrapped private key does
        // the same job: a wrong code cannot unwrap it.
        try { await kkUnwrapPriv(JSON.parse(info.encPrivate), key); }
        catch (e) { return { error: 'Feil kode.' }; }
    }
    kkSalt = info.salt; kkPersonal = key;
    try { await ensureIdentityKeys(key, info); }
    catch (e) { return { error: 'Kunne ikke hente nokkelparet ditt: ' + e.message }; }
    try { localStorage.setItem(SYNC_ON_KEY, '1'); } catch (e) {}
    return { ok: true, groups: groups.length };
}
function syncLock() { kkPersonal = null; kkCeks = {}; kkSalt = null; kkPriv = null; kkPubs = {}; kkDir = null; }

/* ---- group keys ----------------------------------------------------------- */
/* A group's CEK, creating and registering it the first time. Note the group row
 * and its key row are created together server-side: a group nobody holds a key
 * for would be unopenable, including by whoever just made it. */
/* Unwrap whichever way this key was wrapped for me. 'self' is under my own
 * recovery-code key; 'ecdh' means a colleague agreed a key with my public half, so
 * I need their public key and the epoch their wrap was made at. */
async function unwrapFor(groupId, g) {
    if (g.method !== 'ecdh') return kkUnwrapCek(JSON.parse(g.wrappedCek), kkPersonal);
    if (!kkPriv) throw new Error('Mangler nokkelparet ditt - las opp pa nytt');
    const dir = await staffList();
    const inviter = dir.find(t => t.id === g.wrappedBy);
    if (!inviter || !inviter.publicKey) throw new Error('Fant ikke laereren som delte gruppa');
    const theirPub = await pubKeyOf(inviter.id, inviter.publicKey);
    const wk = await kkShareKey(kkPriv, theirPub, groupId, g.epoch || 1);
    return kkUnwrapCek(JSON.parse(g.wrappedCek), wk);
}

async function ensureCek(cls) {
    if (kkCeks[cls.id]) return kkCeks[cls.id];
    const known = kkServer[cls.id];
    if (known && known.wrappedCek) {
        const cek = await unwrapFor(cls.id, known);
        kkCeks[cls.id] = cek;
        return cek;
    }
    const cek = await kkNewCek();
    const wrapped = await kkWrapCek(cek, kkPersonal);
    await kkPost('kk_group_create', {
        id: cls.id, label: cls.name, kind: cls.kind || 'klasse',
        class: cls.class || '', wrappedCek: JSON.stringify(wrapped),
    });
    kkServer[cls.id] = { version: 0, label: cls.name, wrappedCek: JSON.stringify(wrapped), method: 'self', epoch: 1 };
    kkCeks[cls.id] = cek;
    return cek;
}

/* ---- push ---------------------------------------------------------------- */
async function syncPush(cls) {
    if (!syncOn() || !syncUnlocked() || !cls) return { skipped: true };
    const cek = await ensureCek(cls);
    const prev = Number(cls.sv || 0);
    const payload = await kkEncryptChart(chartPayload(cls), cek, prev + 1);
    const r = await kkPost('kk_save', {
        group: cls.id, payload: JSON.stringify(payload), prevVersion: String(prev),
    });
    if (r.conflict) {
        // Someone else advanced this chart. Never resolve it silently — a seating
        // chart cannot be merged meaningfully, and guessing would quietly discard
        // somebody's afternoon.
        kkConflicts[cls.id] = r.version;
        return { conflict: true, version: r.version };
    }
    cls.sv = r.version;
    cls.dirty = false;
    kkServer[cls.id] = Object.assign(kkServer[cls.id] || {}, { version: r.version });
    delete kkConflicts[cls.id];
    saveQuiet();
    return { ok: true, version: r.version };
}

/* Pushing when the tab is hidden as well as on the debounce. Otherwise a teacher
 * who closes the lid within the debounce window leaves that change unsynced until
 * next time — harmless, since the local copy is authoritative, but it looks like
 * data loss to whoever opens the other device. visibilitychange is used rather
 * than beforeunload because async work there is not reliably allowed to finish. */
function flushPush() {
    if (!syncOn() || !syncUnlocked() || !state || !state.dirty) return;
    clearTimeout(pushTimer);
    syncPush(state).then(r => { if (r && r.conflict) updateSyncBadge(); }).catch(() => {});
}

/* Saves are frequent (every drag), pushes should not be. */
function schedulePush(cls) {
    if (!syncOn() || !syncUnlocked()) return;
    const target = cls || state;
    if (!target) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        syncPush(target).then(r => {
            if (r && r.conflict) {
                toast(`«${target.name}» er endret et annet sted – åpne Synk for å velge`, 'err');
                updateSyncBadge();
            } else if (r && r.ok) updateSyncBadge();
        }).catch(e => { /* offline or session gone; local copy is intact */ });
    }, 2500);
}

/* ---- pull ---------------------------------------------------------------- */
/* Server wins only where it is genuinely ahead of what this device last synced.
 * A group the server has never seen is pushed instead, which is what makes
 * turning sync on migrate the existing local charts. */
function ensureStore() {
    if (!store) store = { activeClassId: null, classes: {}, roomTemplates: [] };
    store.classes = store.classes || {};
    store.roomTemplates = store.roomTemplates || [];
    return store;
}
async function syncPullAll() {
    if (!syncOn() || !syncUnlocked()) return { skipped: true };
    ensureStore();
    const { groups } = await kkGet('kk_groups');
    let pulled = 0, pushed = 0, conflicts = 0;
    for (const g of groups) {
        kkServer[g.id] = g;
        const local = store.classes[g.id];
        if (local && Number(local.sv || 0) >= g.version) continue;   // we are current or ahead
        if (g.version === 0) continue;                               // nothing stored yet
        try {
            const cek = kkCeks[g.id] || await unwrapFor(g.id, g);
            kkCeks[g.id] = cek;
            const c = await kkGet('kk_chart', { group: g.id });
            if (!c.payload) continue;
            const data = await kkDecryptChart(JSON.parse(c.payload), cek, c.version);
            if (local && Number(local.sv || 0) < g.version && localAheadOf(local)) {
                kkConflicts[g.id] = g.version; conflicts++; continue;
            }
            store.classes[g.id] = normClass(Object.assign({}, data, { id: g.id }));
            store.classes[g.id].sv = c.version;
            pulled++;
        } catch (e) { console.warn('kk: could not pull', g.id, e.message); }
    }
    // local groups the server has never heard of
    for (const id in store.classes) {
        if (kkServer[id]) continue;
        try { await syncPush(store.classes[id]); pushed++; } catch (e) { /* leave it local */ }
    }
    if (!store.classes[store.activeClassId]) store.activeClassId = Object.keys(store.classes)[0] || null;
    saveQuiet();
    const completed = await resolvePending();
    return { pulled, pushed, conflicts, completed };
}
/* Has this device changed the chart since its last successful push? Anything
 * saved locally after a push bumps nothing we track, so treat "we hold edits the
 * server has not seen" conservatively: only true when sv is behind AND we have a
 * dirty marker. Kept simple on purpose — a false positive costs a prompt, a
 * false negative costs someone's work. */
function localAheadOf(cls) { return !!cls.dirty; }

/* ---- sharing -------------------------------------------------------------- */
/* Invite a colleague. If they have a public key we can wrap the group key for
 * them right now; if they have never opened Klassekartografen they have none, so
 * the invite parks server-side and is completed later by resolvePending(). */
async function inviteTeacher(groupId, teacherId) {
    const cls = store.classes[groupId];
    if (!cls) return { error: 'Ukjent gruppe' };
    const dir = await staffList(true);
    const t = dir.find(x => x.id === teacherId);
    if (!t) return { error: 'Ukjent lærer' };
    if (!t.hasKeypair) {
        const r = await kkPost('kk_invite', { group: groupId, teacherId });
        return r.pending ? { pending: true, name: t.name } : r;
    }
    const cek = await ensureCek(cls);
    const epoch = (kkServer[groupId] && kkServer[groupId].epoch) || 1;
    const wk = await kkShareKey(kkPriv, await pubKeyOf(t.id, t.publicKey), groupId, epoch);
    const wrapped = await kkWrapCek(cek, wk);
    await kkPost('kk_invite', { group: groupId, teacherId, wrappedCek: JSON.stringify(wrapped) });
    return { ok: true, name: t.name };
}

/* Finish invites that were parked because the invitee had no key yet. Runs on
 * every pull, so it happens without anyone being told to do anything — the
 * invitee just gains access the next time a member opens the app. */
async function resolvePending() {
    if (!syncUnlocked() || !kkPriv) return 0;
    let done = 0;
    try {
        const { toComplete } = await kkGet('kk_pending');
        for (const inv of toComplete || []) {
            const cls = store.classes[inv.group];
            if (!cls) continue;
            try {
                const cek = await ensureCek(cls);
                const epoch = (kkServer[inv.group] && kkServer[inv.group].epoch) || 1;
                const wk = await kkShareKey(kkPriv, await pubKeyOf(inv.inviteeId, inv.publicKey), inv.group, epoch);
                const wrapped = await kkWrapCek(cek, wk);
                await kkPost('kk_invite', { group: inv.group, teacherId: inv.inviteeId, wrappedCek: JSON.stringify(wrapped) });
                done++;
            } catch (e) { console.warn('kk: could not complete invite', inv.group, e.message); }
        }
    } catch (e) { /* not fatal */ }
    return done;
}

/* Removing someone. Dropping their key row is what stops them: every kk_ action
 * checks for one. Rotation additionally re-keys the group, which only matters
 * against someone who kept the wrapped key material — but neither is retroactive,
 * and the UI says so rather than implying otherwise. */
async function revokeTeacher(groupId, teacherId, rotate) {
    await kkPost('kk_revoke', { group: groupId, teacherId });
    if (!rotate) return { ok: true };
    const cls = store.classes[groupId];
    const m = await kkGet('kk_members', { group: groupId });
    const dir = await staffList(true);
    const cek2 = await kkNewCek();
    const nextEpoch = ((kkServer[groupId] && kkServer[groupId].epoch) || 1) + 1;
    const keys = [];
    for (const mem of m.members || []) {
        if (mem.id === teacherId) continue;
        if (mem.method === 'self') {
            keys.push({ teacherId: mem.id, wrappedCek: JSON.stringify(await kkWrapCek(cek2, kkPersonal)) });
        } else {
            const t = dir.find(x => x.id === mem.id);
            if (!t || !t.publicKey) return { error: 'Mangler nøkkel for ' + mem.name + ' – roterte ikke' };
            const wk = await kkShareKey(kkPriv, await pubKeyOf(t.id, t.publicKey), groupId, nextEpoch);
            keys.push({ teacherId: mem.id, wrappedCek: JSON.stringify(await kkWrapCek(cek2, wk)) });
        }
    }
    const payload = await kkEncryptChart(chartPayload(cls), cek2, Number(cls.sv || 0) + 1);
    const r = await kkPost('kk_rotate', { group: groupId, payload: JSON.stringify(payload), keys: JSON.stringify(keys) });
    if (r.error) return r;
    kkCeks[groupId] = cek2;
    cls.sv = r.version; cls.dirty = false;
    kkServer[groupId] = Object.assign(kkServer[groupId] || {}, { epoch: r.epoch, version: r.version });
    saveQuiet();
    return { ok: true, rotated: true };
}

/* ---- conflict resolution ------------------------------------------------- */
/* Both directions are destructive, so both are the teacher's explicit choice. */
async function syncTakeServer(id) {
    const g = kkServer[id]; if (!g) return { error: 'Ukjent gruppe' };
    ensureStore();
    const cek = kkCeks[id] || await unwrapFor(id, g);
    const c = await kkGet('kk_chart', { group: id });
    const data = await kkDecryptChart(JSON.parse(c.payload), cek, c.version);
    store.classes[id] = normClass(Object.assign({}, data, { id }));
    store.classes[id].sv = c.version;
    store.classes[id].dirty = false;
    delete kkConflicts[id];
    saveQuiet();
    if (store.activeClassId === id) { state = store.classes[id]; render(); }
    return { ok: true };
}
async function syncKeepMine(id) {
    const cls = store.classes[id]; if (!cls) return { error: 'Ukjent gruppe' };
    const c = await kkGet('kk_chart', { group: id });   // adopt the server's version number
    cls.sv = Number(c.version || 0);
    cls.dirty = true;
    const r = await syncPush(cls);
    return r.conflict ? { error: 'Endret igjen i mellomtiden – prøv på nytt' } : r;
}

/* ---- sync UI -------------------------------------------------------------- */
/* One dialog, four states: off, needs-unlock, unlocked, and showing a freshly
 * generated code. The code is shown exactly once — there is no recovery path by
 * design, so the copy says so plainly rather than implying we could help. */
let syncNewSecret = null;   // held only while the "write this down" step is open
let syncHasIdentity = null; // server says an identity exists (null = not asked yet)
let syncShareGroup = null;  // group whose sharing panel is open
let syncShareData = null;   // { members, pending } for that group

/* The local `kk_sync_on` flag says nothing about a device that has never been used
 * before — which is exactly the case a teacher hits when they open Klassekartografen
 * on a new machine. Ask the server (read-only) whether they already have an
 * identity, so they are prompted for their code instead of being offered a fresh
 * setup that would then tell them they already have one. */
/* Read-only: does the server already know this teacher? Used both to pick the
 * right dialog state and to decide whether the setup screen leads with "fetch my
 * charts" or with creating one. Safe to call before sync is on — it creates
 * nothing. */
function probeIdentity() {
    if (syncHasIdentity !== null) return Promise.resolve(syncHasIdentity);
    return kkGet('kk_identity').then(r => {
        syncHasIdentity = !!r.exists;
        if (syncHasIdentity && !syncOn()) { try { localStorage.setItem(SYNC_ON_KEY, '1'); } catch (e) {} }
        return syncHasIdentity;
    }).catch(() => { syncHasIdentity = false; return false; });
}

/* Lead the setup screen with whichever action this teacher actually came for. */
function updateSetupFetch() {
    const box = $('setupFetch'), or = $('setupOr');
    if (!box) return;
    const show = !!syncHasIdentity && !syncUnlocked();
    box.classList.toggle('hidden', !show);
    if (or) or.classList.toggle('hidden', !show);
}

function openSyncModal() {
    // Always open on the overview: a share panel left over from last time is
    // stale and confusing.
    syncShareGroup = null; syncShareData = null;
    renderSyncBody(); openModal('syncModal');
    probeIdentity().then(() => { renderSyncBody(); updateSetupFetch(); });
}

/* After a pull, make sure the app is actually showing something. On a device that
 * started empty this is the moment the teacher's charts appear; on one that was
 * already working it just re-points `state` at the refreshed object. */
function enterPulledCharts() {
    if (!store || !Object.keys(store.classes || {}).length) return;
    if (!store.activeClassId || !store.classes[store.activeClassId]) {
        store.activeClassId = Object.keys(store.classes)[0];
    }
    state = store.classes[store.activeClassId];
    saveQuiet();
    if ($('app').classList.contains('hidden')) showApp();
    render();
}

function renderSyncBody() {
    const box = $('syncBody');
    if (!box) return;

    if (syncShareGroup) { renderSyncShare(box); return; }

    if (syncNewSecret) {
        box.innerHTML = `
            <p class="modal-hint">Skriv ned koden, eller lagre den i passordbehandleren din.
            <strong>Den vises bare nå.</strong> Uten den får du ikke tilgang til kartene dine fra en annen enhet,
            og ingen — heller ikke skolen — kan hente den fram igjen.</p>
            <div class="sync-code">${escapeHtml(syncNewSecret)}</div>
            <div class="sync-actions">
                <button class="btn" data-syncact="copy" type="button">📋 Kopier</button>
                <button class="btn btn-primary" data-syncact="savedIt" type="button">Jeg har lagret den</button>
            </div>`;
        return;
    }

    if (syncHasIdentity === null && !syncOn()) {
        box.innerHTML = '<p class="modal-hint">Sjekker…</p>';
        return;
    }

    if (!syncOn() && !syncHasIdentity) {
        box.innerHTML = `
            <p class="modal-hint">Uten synkronisering ligger kartene bare i denne nettleseren.
            Blir den tømt, eller får du ny maskin, er de borte.</p>
            <p class="modal-hint">Slår du det på, lagres kartene på skolens server —
            <strong>kryptert</strong>. Serveren kan ikke lese elevnavn eller noe annet i kartene;
            bare du med koden din kan åpne dem.</p>
            <div class="sync-actions">
                <button class="btn btn-primary" data-syncact="begin" type="button">Slå på synkronisering</button>
            </div>`;
        return;
    }

    if (!syncUnlocked()) {
        // The identity probe can land while someone is already typing, and this
        // body is re-rendered when it does. Carry the field's contents across so
        // a slow network never eats a half-entered code.
        const typed = $('syncCodeInput') ? $('syncCodeInput').value : '';
        box.innerHTML = `
            <p class="modal-hint">Skriv inn gjenopprettingskoden din for å hente og lagre kart.
            ${syncHasIdentity && !Object.keys((store && store.classes) || {}).length
                ? 'Kartene dine hentes ned så snart du er låst opp.' : ''}</p>
            <input type="text" id="syncCodeInput" class="sync-input" placeholder="XXXX-XXXX-XXXX-XXXX"
                   autocomplete="off" autocapitalize="characters" spellcheck="false">
            <p class="modal-hint" id="syncErr" hidden></p>
            <div class="sync-actions">
                <button class="btn" data-syncact="off" type="button">Slå av synkronisering</button>
                <button class="btn btn-primary" data-syncact="unlock" type="button">Lås opp</button>
            </div>`;
        if (typed) $('syncCodeInput').value = typed;
        setTimeout(() => { const i = $('syncCodeInput'); if (i) i.focus(); }, 60);
        return;
    }

    const classes = (store && store.classes) || {};
    const rows = Object.keys(classes).map(id => {
        const c = classes[id];
        const conflict = kkConflicts[id];
        const status = conflict
            ? `<span class="sync-bad">endret et annet sted</span>
               <button class="btn btn-sm" data-syncact="takeServer" data-id="${id}" type="button">Hent deres</button>
               <button class="btn btn-sm" data-syncact="keepMine" data-id="${id}" type="button">Behold mitt</button>`
            : c.dirty ? '<span class="sync-wait">ikke lagret ennå</span>'
            : c.sv ? `<span class="sync-ok">lagret (v${c.sv})</span>`
            : '<span class="sync-wait">ikke sendt opp</span>';
        const share = c.sv ? `<button class="btn btn-sm" data-syncact="share" data-id="${id}" type="button">👥 Del</button>` : '';
        return `<div class="sync-row"><span class="sync-name">${escapeHtml(c.name)}</span>${status}${share}</div>`;
    }).join('') || '<div class="empty-line">Ingen grupper her enda. Trykk «Synk nå» for å hente.</div>';

    box.innerHTML = `
        <p class="modal-hint">Kartene lagres kryptert på skolens server. Serveren kan ikke lese dem.</p>
        <div class="sync-list">${rows}</div>
        <div class="sync-actions">
            <button class="btn" data-syncact="lock" type="button">🔒 Lås</button>
            <button class="btn btn-primary" data-syncact="now" type="button">↻ Synk nå</button>
        </div>`;
}

/* Who this group is shared with, and how to change that. */
function renderSyncShare(box) {
    const cls = store.classes[syncShareGroup];
    const d = syncShareData;
    if (!cls) { syncShareGroup = null; renderSyncBody(); return; }
    if (!d) { box.innerHTML = '<p class="modal-hint">Henter…</p>'; return; }

    const members = d.members.map(m => {
        const isMe = m.method === 'self' && m.wrappedBy === m.id;
        const rm = (d.members.length > 1 && !isMe)
            ? `<button class="btn btn-sm" data-syncact="revoke" data-id="${m.id}" type="button">Fjern</button>` : '';
        return `<div class="sync-row"><span class="sync-name">${escapeHtml(m.name)}</span>
                <span class="sync-wait">${isMe ? 'deg' : 'har tilgang'}</span>${rm}</div>`;
    }).join('');
    const pending = d.pending.map(pp => `<div class="sync-row"><span class="sync-name">${escapeHtml(pp.name)}</span>
        <span class="sync-wait">venter på nøkkel</span></div>`).join('');
    const have = new Set(d.members.map(m => m.id).concat(d.pending.map(x => x.id)));
    const opts = (kkDir || []).filter(t => !have.has(t.id))
        .map(t => `<option value="${t.id}">${escapeHtml(t.name)}${t.hasKeypair ? '' : ' (ikke i gang enda)'}</option>`).join('');

    box.innerHTML = `
        <p class="modal-hint"><strong>${escapeHtml(cls.name)}</strong> — hvem har tilgang.
        Alle med tilgang kan redigere kartet og invitere flere.</p>
        <div class="sync-list">${members}${pending}</div>
        ${opts ? `<div class="setup-field">
            <label for="syncInvitee">Inviter en kollega</label>
            <select id="syncInvitee">${opts}</select>
        </div>` : '<p class="modal-hint">Alle andre lærere er alt invitert.</p>'}
        <p class="modal-hint">Å fjerne noen stopper videre tilgang. Det de alt har åpnet,
        har de fortsatt — det kan ingen ta tilbake.</p>
        <div class="sync-actions">
            <button class="btn" data-syncact="shareBack" type="button">← Tilbake</button>
            ${opts ? '<button class="btn btn-primary" data-syncact="invite" type="button">Inviter</button>' : ''}
        </div>`;
}

/* A quiet marker on the Mer button, so an unresolved conflict is visible without
 * opening anything. */
function updateSyncBadge() {
    const btn = $('menuBtn');
    if (!btn) return;
    const n = Object.keys(kkConflicts).length;
    btn.classList.toggle('has-conflict', n > 0);
    btn.title = n ? `${n} gruppe(r) endret et annet sted` : 'Mer';
}

async function syncAction(act, el) {
    const id = el && el.dataset ? el.dataset.id : null;
    try {
        if (act === 'begin') {
            const r = await syncBegin();
            if (r.alreadySetUp) {
                toast('Synk er alt satt opp — skriv inn koden din', 'err');
                try { localStorage.setItem(SYNC_ON_KEY, '1'); } catch (e) {}
            } else { syncNewSecret = r.secret; }
            renderSyncBody(); return;
        }
        if (act === 'copy') {
            try { await navigator.clipboard.writeText(syncNewSecret); toast('Kopiert', 'ok'); }
            catch (e) { toast('Kunne ikke kopiere – skriv den ned', 'err'); }
            return;
        }
        if (act === 'savedIt') {
            syncNewSecret = null;
            const r = await syncPullAll();
            toast(`Synk slått på — ${r.pushed || 0} gruppe(r) lastet opp`, 'ok');
            renderSyncBody(); updateSyncBadge(); return;
        }
        if (act === 'unlock') {
            const r = await syncUnlock($('syncCodeInput').value);
            if (r.error) { const e = $('syncErr'); e.hidden = false; e.textContent = r.error; e.className = 'modal-hint sync-bad'; return; }
            const p = await syncPullAll();
            toast(`Låst opp — ${p.pulled || 0} hentet, ${p.pushed || 0} lastet opp`, 'ok');
            enterPulledCharts();
            renderSyncBody(); updateSyncBadge(); return;
        }
        if (act === 'share') {
            syncShareGroup = id; syncShareData = null; renderSyncBody();
            await staffList(true);
            syncShareData = await kkGet('kk_members', { group: id });
            renderSyncBody(); return;
        }
        if (act === 'shareBack') { syncShareGroup = null; syncShareData = null; renderSyncBody(); return; }
        if (act === 'invite') {
            const who = $('syncInvitee').value;
            const r = await inviteTeacher(syncShareGroup, who);
            if (r.error) { toast(r.error, 'err'); return; }
            toast(r.pending ? `${r.name} får tilgang når en av oss åpner gruppa neste gang`
                            : `${r.name} har nå tilgang`, 'ok');
            syncShareData = await kkGet('kk_members', { group: syncShareGroup });
            renderSyncBody(); return;
        }
        if (act === 'revoke') {
            const who = (syncShareData.members.find(m => m.id === id) || {}).name || 'læreren';
            if (!confirm(`Fjerne ${who} fra «${store.classes[syncShareGroup].name}»?\n\nDe mister videre tilgang, men beholder det de alt har åpnet.`)) return;
            const rot = confirm('Bytte gruppenøkkel samtidig? Tar litt lenger tid, og er bare nødvendig hvis du tror de har tatt vare på nøkkelen.');
            const r = await revokeTeacher(syncShareGroup, id, rot);
            if (r.error) { toast(r.error, 'err'); return; }
            toast(r.rotated ? 'Fjernet og ny nøkkel laget' : 'Fjernet', 'ok');
            syncShareData = await kkGet('kk_members', { group: syncShareGroup });
            renderSyncBody(); return;
        }
        if (act === 'lock') { syncShareGroup = null; syncLock(); renderSyncBody(); return; }
        if (act === 'off') {
            // Local charts are untouched; the server copy stays until it is
            // reset or purged, which is the lifecycle step's job, not this one.
            try { localStorage.removeItem(SYNC_ON_KEY); } catch (e) {}
            syncHasIdentity = false;   // otherwise the dialog re-enables itself on the next open
            syncLock(); renderSyncBody(); toast('Synkronisering av', 'ok'); return;
        }
        if (act === 'now') {
            const r = await syncPullAll();
            enterPulledCharts();
            toast(`${r.pulled || 0} hentet · ${r.pushed || 0} sendt${r.completed ? ` · ${r.completed} invitasjon fullført` : ''}${r.conflicts ? ` · ${r.conflicts} kollisjon` : ''}`, r.conflicts ? 'err' : 'ok');
            renderSyncBody(); updateSyncBadge(); return;
        }
        if (act === 'takeServer') { await syncTakeServer(id); toast('Hentet serverversjonen', 'ok'); renderSyncBody(); updateSyncBadge(); return; }
        if (act === 'keepMine') {
            const r = await syncKeepMine(id);
            toast(r.error || 'Din versjon er lagret', r.error ? 'err' : 'ok');
            renderSyncBody(); updateSyncBadge(); return;
        }
    } catch (e) {
        toast(e.message === 'Unauthorized' ? 'Økten er utløpt – logg inn på nytt' : 'Synk feilet: ' + e.message, 'err');
    }
}

/* ----------------------------------------------------------- persistence    */
let savingFromSync = false;
function save() {
    if (!store) return;
    if (!savingFromSync && state) { state.dirty = true; schedulePush(state); }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }
    catch (e) { console.error('save failed', e); }
}

/* ----------------------------------------------------------- undo / redo    */
/* Snapshots the desk arrangement + placement of the active class. Per-class,
 * session-only (reset when switching class / opening a class). */
let undoStack = [], redoStack = [];
const UNDO_LIMIT = 60;
function snapshot() {
    return JSON.stringify({
        seats: state.seats, assign: state.assign, locked: state.locked,
        room: state.room, roomMode: state.roomMode, roomParams: state.roomParams
    });
}
function pushUndo(snap) {
    if (!state) return;
    clearSmartResult();
    undoStack.push(snap || snapshot());
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
}
function resetUndo() { undoStack = []; redoStack = []; updateUndoButtons(); }
function restoreSnapshot(snap) {
    const s = JSON.parse(snap);
    state.seats = s.seats; state.assign = s.assign; state.locked = s.locked;
    state.room = s.room; state.roomMode = s.roomMode; state.roomParams = s.roomParams;
    pruneInvalid();
}
function undo() {
    if (!undoStack.length) { toast('Ingenting å angre', 'err'); return; }
    redoStack.push(snapshot());
    restoreSnapshot(undoStack.pop());
    save(); render(); updateUndoButtons();
    toast('Angret ↩', 'ok');
}
function redo() {
    if (!redoStack.length) { toast('Ingenting å gjenta', 'err'); return; }
    undoStack.push(snapshot());
    restoreSnapshot(redoStack.pop());
    save(); render(); updateUndoButtons();
    toast('Gjentok ↪', 'ok');
}
function updateUndoButtons() {
    const u = $('undoBtn'), r = $('redoBtn');
    if (u) u.disabled = !undoStack.length;
    if (r) r.disabled = !redoStack.length;
}

function normStrength(v) { return v === 'must' || v === 'should' ? v : null; }
/* A rule is { type:'apart'|'together', a, members:[...], strength }. apart = a
 * away from EVERY member; together = a next to AT LEAST ONE member. Migrates the
 * old pairwise { a, b } and the interim 'together-any' type into this shape. */
function normRule(r) {
    const members = (r.members && r.members.length) ? r.members.slice() : (r.b != null ? [r.b] : []);
    return {
        id: r.id || uid(),
        type: r.type === 'apart' ? 'apart' : 'together',
        a: r.a,
        members: members.filter(id => id !== r.a),
        strength: normStrength(r.strength) || 'must'
    };
}
function normStudent(s) {
    // front/back are null | 'should' | 'must'; migrate the old boolean needsFront → soft front
    const front = normStrength(s.front) || (s.needsFront ? 'should' : null);
    const back = normStrength(s.back);
    return {
        id: s.id || uid(), name: s.name, gender: s.gender || null, front, back: front ? null : back,
        quiet: !!s.quiet,
        wishWith: (s.wishWith || []).slice(), wishAvoid: (s.wishAvoid || []).slice(),
        tags: s.tags || []
    };
}
/* A "group" is a klasse (9B) or a faggruppe (valgfag, K&H — pupils from several
 * classes). Introduced in step 1 so the shape is settled before server sync
 * keys envelopes on it. Older objects migrate silently to kind:'klasse'. */
function normKind(k) { return k === 'fag' || k === 'annet' ? k : 'klasse'; }
function normClass(c) {
    const name = c.name || 'Klasse';
    const kind = normKind(c.kind);
    return {
        id: c.id || uid(),
        name,
        kind,
        // `class` is the school_config code, and only meaningful for a klasse.
        // A faggruppe has no code — it is free text the teacher typed.
        class: kind === 'klasse' ? (c.class || (/^[0-9A-ZÆØÅ]{1,12}$/.test(name) ? name : null)) : null,
        room: c.room || 'pairs',
        roomMode: c.roomMode === 'custom' ? 'custom' : 'auto',
        roomParams: Object.assign({ rows: null, perRow: null, gapX: null, gapY: null }, c.roomParams || {}),
        students: (c.students || []).map(normStudent),
        seats: c.seats || [],
        assign: c.assign || {},
        locked: c.locked || [],
        rules: (c.rules || []).map(normRule),
        prefs: Object.assign({ balanceGender: false, avoidRepeat: false, avoidAllRepeat: false, balanceTags: false }, c.prefs || {}),
        history: c.history || [],
        // sync bookkeeping: server version this copy matches, and whether we hold
        // edits it has not seen. Local-only — stripped from the payload.
        sv: Number(c.sv) || 0,
        dirty: !!c.dirty
    };
}

function loadStore() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const s = JSON.parse(raw);
            if (s && s.classes) {
                store = s;
                for (const id in store.classes) store.classes[id] = normClass(store.classes[id]);
                if (!store.activeClassId || !store.classes[store.activeClassId]) {
                    store.activeClassId = Object.keys(store.classes)[0] || null;
                }
                store.roomTemplates = store.roomTemplates || [];
                return !!store.activeClassId;
            }
        }
        // migrate a Phase-1 single-class state if present
        const old = localStorage.getItem(OLD_KEY);
        if (old) {
            const c = normClass(JSON.parse(old));
            store = { activeClassId: c.id, classes: { [c.id]: c }, roomTemplates: [] };
            save();
            localStorage.removeItem(OLD_KEY);
            return true;
        }
    } catch (e) { console.error('load failed', e); }
    return false;
}

function setActiveClass(id) {
    if (!store.classes[id]) return;
    if (editMode) exitEditMode();
    zoom = null;
    resetUndo();
    store.activeClassId = id;
    state = store.classes[id];
    selected = null;
    save();
    $('classMenuLabel').textContent = state.name;
    render();
}

/* -------------------------------------------------------- seat generators   */
/* opts may carry explicit overrides from a custom arrangement:
 *   cols / perRow  – force the grid width (desks-per-row or groups-per-row)
 *   gapX / gapY    – desk and row spacing (fall back to GBET / RGAP)         */
function genRows(n, opts) {
    opts = opts || {};
    const cols = opts.cols ? clamp(opts.cols, 1, 20) : clamp(Math.round(Math.sqrt(n * 1.7)), 1, 9);
    const gapX = opts.gapX != null ? opts.gapX : GBET;
    const gapY = opts.gapY != null ? opts.gapY : RGAP;
    const pitchX = SEAT_W + gapX, pitchY = SEAT_H + gapY;
    const fullW = cols * SEAT_W + (cols - 1) * gapX;
    const seats = [];
    const rowsN = Math.ceil(n / cols);
    for (let r = 0; r < rowsN; r++) {
        const inRow = Math.min(cols, n - r * cols);
        const rowW = inRow * SEAT_W + (inRow - 1) * gapX;
        const x0 = (fullW - rowW) / 2;
        for (let c = 0; c < inRow; c++) seats.push({ x: x0 + c * pitchX, y: r * pitchY });
    }
    return seats;
}
function genGroups(n, perGroup, gridCols, gridRows, opts) {
    opts = opts || {};
    const gapX = opts.gapX != null ? opts.gapX : GBET;
    const gapY = opts.gapY != null ? opts.gapY : RGAP;
    const groupW = gridCols * SEAT_W + (gridCols - 1) * GIN;
    const groupH = gridRows * SEAT_H + (gridRows - 1) * GIN;
    const groups = Math.ceil(n / perGroup);
    const perRow = opts.perRow ? clamp(opts.perRow, 1, 20)
        : clamp(Math.round(Math.sqrt(groups * (gridRows > 1 ? 1 : 1.3))), 1, gridRows > 1 ? 3 : 4);
    const pitchGroupX = groupW + gapX, pitchGroupY = groupH + gapY;
    const fullW = perRow * groupW + (perRow - 1) * gapX;
    const seats = [];
    let placed = 0;
    const groupRows = Math.ceil(groups / perRow);
    for (let gr = 0; gr < groupRows; gr++) {
        const groupsInRow = Math.min(perRow, groups - gr * perRow);
        const rowW = groupsInRow * groupW + (groupsInRow - 1) * gapX;
        const x0 = (fullW - rowW) / 2;
        for (let gc = 0; gc < groupsInRow; gc++) {
            const gx = x0 + gc * pitchGroupX, gy = gr * pitchGroupY;
            for (let sy = 0; sy < gridRows; sy++)
                for (let sx = 0; sx < gridCols; sx++) {
                    if (placed >= n) continue;
                    seats.push({ x: gx + sx * (SEAT_W + GIN), y: gy + sy * (SEAT_H + GIN) });
                    placed++;
                }
        }
    }
    return seats;
}
function genU(n) {
    const cols = clamp(Math.round(Math.sqrt(n)) + 1, 3, 9);
    const h = Math.max(1, Math.ceil((n - cols) / 2));
    const pitchX = SEAT_W + GBET, pitchY = SEAT_H + RGAP;
    const seats = [];
    for (let r = 0; r < h; r++) seats.push({ x: 0, y: r * pitchY });
    for (let c = 0; c < cols; c++) seats.push({ x: c * pitchX, y: h * pitchY });
    for (let r = h - 1; r >= 0; r--) seats.push({ x: (cols - 1) * pitchX, y: r * pitchY });
    return seats;
}
/* how many desks an explicit rows×perRow grid yields for a preset (unit size:
 * rows = 1 desk/unit, pairs = 2, pods = 4) */
function deskCountFor(preset, rows, perRow) {
    const unit = preset === 'pairs' ? 2 : preset === 'pods' ? 4 : 1;
    return clamp(rows | 0, 1, 20) * clamp(perRow | 0, 1, 20) * unit;
}
function generateSeats(preset, n, params) {
    n = Math.max(0, n | 0);
    params = params || {};
    const gaps = { gapX: params.gapX, gapY: params.gapY };
    // Width per row. If only the row count was given, derive it from how many
    // units this roster needs, so "3 rader" means three rows rather than being
    // quietly ignored. Derived here rather than stored, so it keeps following the
    // roster as pupils come and go.
    let cols = params.perRow || null;
    if (!cols && params.rows) {
        const unit = preset === 'pairs' ? 2 : preset === 'pods' ? 4 : 1;
        cols = Math.max(1, Math.ceil(Math.ceil(n / unit) / clamp(params.rows, 1, 20)));
    }
    let seats;
    if (n === 0) seats = [];
    else if (preset === 'rows') seats = genRows(n, Object.assign({ cols }, gaps));
    else if (preset === 'pairs') seats = genGroups(n, 2, 2, 1, Object.assign({ perRow: cols }, gaps));
    else if (preset === 'pods') seats = genGroups(n, 4, 2, 2, Object.assign({ perRow: cols }, gaps));
    else if (preset === 'u') seats = genU(n);
    else seats = genGroups(n, 2, 2, 1, gaps);
    if (seats.length) {
        const minX = Math.min(...seats.map(s => s.x));
        const minY = Math.min(...seats.map(s => s.y));
        seats.forEach(s => { s.x -= minX; s.y -= minY; });
    }
    return seats.map((s, i) => ({ id: 'seat' + i, x: s.x, y: s.y }));
}

/* -------------------------------------------------------- assignment model  */
function seatOfStudent(sid) {
    for (const seatId in state.assign) if (state.assign[seatId] === sid) return seatId;
    return null;
}
function studentById(sid) { return state.students.find(s => s.id === sid); }
function isLocked(sid) { return state.locked.indexOf(sid) !== -1; }

function placeStudent(sid, seatId) {
    if (isLocked(sid)) { toast('Eleven er låst – lås opp først', 'err'); return; }
    const cur = seatOfStudent(sid);
    const occ = state.assign[seatId] || null;
    if (occ && isLocked(occ)) { toast('Plassen er låst', 'err'); return; }
    if (cur === seatId) return; // no-op
    pushUndo();
    if (cur) delete state.assign[cur];
    if (occ && cur) state.assign[cur] = occ; // swap; otherwise occupant returns to pool
    state.assign[seatId] = sid;
    save(); render();
}
function unseat(sid) {
    if (isLocked(sid)) { toast('Eleven er låst – lås opp først', 'err'); return; }
    const cur = seatOfStudent(sid);
    if (!cur) return;
    pushUndo();
    delete state.assign[cur];
    save(); render();
}
function toggleLock(sid) {
    const i = state.locked.indexOf(sid);
    if (i === -1 && !seatOfStudent(sid)) { toast('Plasser eleven før du låser', 'err'); return; }
    pushUndo();
    if (i === -1) state.locked.push(sid); else state.locked.splice(i, 1);
    save(); render();
}

function fillSeats(orderedIds) {
    // keep locked students where they are; fill the rest into remaining seats
    const fixed = {};
    state.locked.forEach(id => { const se = seatOfStudent(id); if (se) fixed[se] = id; });
    state.assign = Object.assign({}, fixed);
    const fixedStudents = new Set(Object.values(fixed));
    const freeSeats = state.seats.filter(s => !(s.id in fixed));
    const queue = orderedIds.filter(id => !fixedStudents.has(id));
    for (let i = 0; i < queue.length && i < freeSeats.length; i++) state.assign[freeSeats[i].id] = queue[i];
}

function shuffleSeating(silent) {
    pushUndo();
    const ids = state.students.map(s => s.id);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    fillSeats(ids);
    save(); render();
    if (!silent) toast(state.seats.length < ids.length ? 'Blandet – for få plasser til alle' : 'Blandet! 🎲', 'ok');
}

/* ---------------------------------------------------- room / roster changes */
function regenSeatsPreserve() {
    const seated = [...state.seats].filter(s => state.assign[s.id])
        .sort((a, b) => a.y - b.y || a.x - b.x).map(s => state.assign[s.id]);
    state.seats = generateSeats(state.room, state.students.length, state.roomParams);
    state.assign = {};
    seated.forEach((sid, i) => { if (state.seats[i]) state.assign[state.seats[i].id] = sid; });
}
/* params: { rows, perRow, gapX, gapY } — rows+perRow present ⇒ custom (fixed
 * desk count, decoupled from roster); otherwise auto (desk count = #students). */
function applyRoom(preset, keepSeats, params) {
    params = params || {};
    pushUndo();
    let seated = [];
    if (keepSeats) seated = [...state.seats].filter(s => state.assign[s.id])
        .sort((a, b) => a.y - b.y || a.x - b.x).map(s => state.assign[s.id]);
    // Each field means something on its own. Both together fix the desk COUNT
    // (rows x perRow x unit, empty desks allowed); either alone only shapes the
    // layout while the count keeps tracking the roster. Previously one without
    // the other was discarded, so setting just "par per rad" did nothing.
    const isU = preset === 'u';
    const rows = (!isU && params.rows) ? clamp(params.rows, 1, 20) : null;
    const perRow = (!isU && params.perRow) ? clamp(params.perRow, 1, 20) : null;
    const custom = !!(rows && perRow);
    state.room = preset;
    state.roomMode = custom ? 'custom' : 'auto';
    state.roomParams = {
        rows, perRow,
        gapX: params.gapX != null ? params.gapX : null,
        gapY: params.gapY != null ? params.gapY : null
    };
    const n = custom ? deskCountFor(preset, state.roomParams.rows, state.roomParams.perRow)
                     : state.students.length;
    state.seats = generateSeats(preset, n, state.roomParams);
    state.assign = {};
    if (keepSeats) seated.forEach((sid, i) => { if (state.seats[i]) state.assign[state.seats[i].id] = sid; });
    save(); render();
}

function pruneInvalid() {
    const ids = new Set(state.students.map(s => s.id));
    for (const seatId in state.assign) if (!ids.has(state.assign[seatId])) delete state.assign[seatId];
    state.locked = state.locked.filter(id => ids.has(id));
    state.rules = state.rules.filter(r => {
        if (!ids.has(r.a)) return false;
        r.members = (r.members || []).filter(id => ids.has(id) && id !== r.a);
        return r.members.length > 0;
    });
    state.students.forEach(s => {
        s.wishWith = (s.wishWith || []).filter(id => id !== s.id && ids.has(id));
        s.wishAvoid = (s.wishAvoid || []).filter(id => id !== s.id && ids.has(id));
    });
}

/* ----------------------------------------------------------- adjacency      */
/* "Next to each other" is derived from the geometry, so it follows whatever the
 * desks actually look like after manual edits — no reliance on the preset.
 *   Pass 1 – tight clusters: orthogonal desks with a small (within-group) edge
 *            gap. These are pairs/pods or any hand-made cluster; a desk in a
 *            cluster is "grouped" and counts adjacent only to its cluster-mates.
 *   Pass 2 – loose neighbours: a normal one-desk gap links same-row desks (and,
 *            in a U layout, same-column desks too) — but only for desks that
 *            aren't already locked into a cluster, so an aisle between two pairs
 *            never joins them.
 * Result: pairs→pair-mates, pods→orthogonal pod-mates, rows→same-row neighbours,
 * front/back rows and across-the-aisle excluded, and custom clusters respected. */
function computeAdjacency(seats, room) {
    const useU = (room == null ? state.room : room) === 'u';
    const n = seats.length;
    const adj = {}; const edges = [];
    seats.forEach(s => { adj[s.id] = []; });
    const addEdge = (a, b) => { adj[a].push(b); adj[b].push(a); edges.push([a, b]); };
    // pass 1: tight clusters
    const clustered = new Set();
    const tightPairs = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = seats[i], b = seats[j];
        const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
        const horiz = dy <= SEAT_H * 0.5 && dx > SEAT_W * 0.5 && dx - SEAT_W <= ADJ_TIGHT_H;
        const vert  = dx <= SEAT_W * 0.5 && dy > SEAT_H * 0.5 && dy - SEAT_H <= ADJ_TIGHT_V;
        if (horiz || vert) { tightPairs.push([a.id, b.id]); clustered.add(a.id); clustered.add(b.id); }
    }
    tightPairs.forEach(([a, b]) => addEdge(a, b));
    // pass 2: loose neighbours between desks not both locked into a cluster
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = seats[i], b = seats[j];
        if (clustered.has(a.id) && clustered.has(b.id)) continue;
        const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
        const horiz = dy <= SEAT_H * 0.5 && dx > SEAT_W * 0.5 && dx - SEAT_W <= ADJ_LOOSE_H;
        const vert  = useU && dx <= SEAT_W * 0.5 && dy > SEAT_H * 0.5 && dy - SEAT_H <= ADJ_LOOSE_V;
        if (horiz || vert) addEdge(a.id, b.id);
    }
    return { adj, edges };
}

/* -------------------------------------------------- smart arrange (Phase 2) */
function buildContext() {
    const { adj, edges } = computeAdjacency(state.seats);
    const ys = state.seats.map(s => s.y);
    const minY = ys.length ? Math.min(...ys) : 0;
    const maxY = ys.length ? Math.max(...ys) : 0;
    const seatById = {}; state.seats.forEach(s => seatById[s.id] = s);
    // apart: pairKey -> strongest strength ('must' wins) for every (a, member) pair.
    // together: {a, members:Set, strength} — a next to AT LEAST ONE of members.
    const apart = new Map(), together = [];
    state.rules.forEach(r => {
        const st = normStrength(r.strength) || 'must'; // old rules had no strength = hard
        const members = (r.members || []).filter(id => id !== r.a);
        if (!members.length) return;
        if (r.type === 'apart') {
            members.forEach(m => {
                const k = pairKey(r.a, m);
                apart.set(k, apart.get(k) === 'must' || st === 'must' ? 'must' : 'should');
            });
        } else { // together
            together.push({ a: r.a, members: new Set(members), strength: st });
        }
    });
    const genderOf = {}; const placeWants = []; // {id, side:'front'|'back', strength}
    // student preferences (teacher-entered): soft signals, weaker than explicit rules
    const wishWith = [], wishAvoid = [], quiet = new Set();
    state.students.forEach(s => {
        genderOf[s.id] = s.gender;
        if (s.front) placeWants.push({ id: s.id, side: 'front', strength: s.front });
        if (s.back) placeWants.push({ id: s.id, side: 'back', strength: s.back });
        if (s.quiet) quiet.add(s.id);
        (s.wishWith || []).forEach(w => wishWith.push({ a: s.id, b: w }));
        (s.wishAvoid || []).forEach(w => wishAvoid.push({ a: s.id, b: w }));
    });
    let prevPairs = new Set();
    if (state.prefs.avoidRepeat && state.history.length) {
        const snap = state.history[0];
        const seatsP = snap.seats || state.seats;
        const { edges: pe } = computeAdjacency(seatsP, snap.room);
        pe.forEach(([s1, s2]) => {
            const a = snap.assign[s1], b = snap.assign[s2];
            if (a && b) prevPairs.add(pairKey(a, b));
        });
    }
    // avoid ALL past neighbours: count how many saved charts each pair sat together,
    // so repeat offenders are penalised more and the optimiser favours new pairings.
    let pastPairs = null;
    if (state.prefs.avoidAllRepeat && state.history.length) {
        pastPairs = new Map();
        state.history.forEach(snap => {
            const seatsP = snap.seats || []; if (!seatsP.length) return;
            const { edges: pe } = computeAdjacency(seatsP, snap.room);
            pe.forEach(([s1, s2]) => {
                const a = (snap.assign || {})[s1], b = (snap.assign || {})[s2];
                if (a && b) { const k = pairKey(a, b); pastPairs.set(k, (pastPairs.get(k) || 0) + 1); }
            });
        });
    }
    // tag balancing: spread same-tag students across co-groups (heterogeneous grouping)
    const tagBalance = !!state.prefs.balanceTags;
    const tagsOf = {}; state.students.forEach(s => { tagsOf[s.id] = s.tags || []; });
    const clusters = tagBalance ? clustersOf(state.seats) : [];
    return { adj, edges, minY, maxY, seatById, apart, together, genderOf, placeWants, wishWith, wishAvoid, quiet, tagBalance, tagsOf, clusters, prevPairs, pastPairs, prefs: state.prefs };
}

function scoreAssign(assign, ctx) {
    let score = 0;
    const seatOf = {};
    for (const seatId in assign) seatOf[assign[seatId]] = seatId;
    // adjacency-driven costs
    for (const [s1, s2] of ctx.edges) {
        const a = assign[s1], b = assign[s2];
        if (!a || !b) continue;
        const k = pairKey(a, b);
        const apartSt = ctx.apart.get(k);
        if (apartSt) score += apartSt === 'must' ? 1000 : 30;
        if (ctx.prefs.balanceGender && ctx.genderOf[a] && ctx.genderOf[b] && ctx.genderOf[a] === ctx.genderOf[b]) score += 4;
        if (ctx.prefs.avoidRepeat && ctx.prevPairs.has(k)) score += 10;
        if (ctx.pastPairs) { const c = ctx.pastPairs.get(k); if (c) score += c * 10; } // more shared charts = stronger nudge to a new partner
    }
    // together: satisfied if a neighbours at least one member of the set
    for (const t of ctx.together) {
        const sa = seatOf[t.a];
        const ok = sa && ctx.adj[sa].some(nb => t.members.has(assign[nb]));
        if (!ok) score += t.strength === 'must' ? 200 : 30;
    }
    // near-front / near-back wishes (distance from the wished edge, weighted by strength)
    for (const w of ctx.placeWants) {
        const se = seatOf[w.id];
        if (!se) { score += w.strength === 'must' ? 200 : 60; continue; }
        const y = ctx.seatById[se].y;
        const dist = w.side === 'front' ? (y - ctx.minY) : (ctx.maxY - y);
        score += dist * (w.strength === 'must' ? 1.0 : 0.25);
    }
    // student preferences — soft (kept below «Bør»-rule weight so explicit rules win)
    for (const w of ctx.wishWith) {
        const sa = seatOf[w.a], sb = seatOf[w.b];
        if (!(sa && sb && ctx.adj[sa].indexOf(sb) !== -1)) score += 15;
    }
    for (const w of ctx.wishAvoid) {
        const sa = seatOf[w.a], sb = seatOf[w.b];
        if (sa && sb && ctx.adj[sa].indexOf(sb) !== -1) score += 15;
    }
    if (ctx.quiet.size) for (const id of ctx.quiet) {
        const se = seatOf[id];
        if (se) { let nb = 0; ctx.adj[se].forEach(s => { if (assign[s]) nb++; }); score += nb * 6; }
    }
    // tag balance: penalise the same tag clumping inside one co-group
    if (ctx.tagBalance) for (const cl of ctx.clusters) {
        const counts = {};
        for (const seatId of cl) { const sid = assign[seatId]; if (!sid) continue; for (const t of (ctx.tagsOf[sid] || [])) counts[t] = (counts[t] || 0) + 1; }
        for (const t in counts) if (counts[t] > 1) score += (counts[t] - 1) * 8;
    }
    return score;
}

/* Swap the occupants of seats p and q (an empty seat == an absent key).
 * Each seat's value comes from the OTHER seat, so a swap can never drop a
 * student — the guard tests the value being moved IN, not the old one. */
function swapSeats(assign, p, q) {
    const av = assign[p], bv = assign[q];
    if (av === undefined) delete assign[q]; else assign[q] = av;
    if (bv === undefined) delete assign[p]; else assign[p] = bv;
}

function smartArrange(silent) {
    if (!state.seats.length || !state.students.length) { toast('Ingen elever å plassere', 'err'); return; }
    pushUndo();
    const ctx = buildContext();
    const fixed = {};
    state.locked.forEach(id => { const se = seatOfStudent(id); if (se) fixed[se] = id; });
    const fixedStudents = new Set(Object.values(fixed));
    const freeSeatIds = state.seats.filter(s => !(s.id in fixed)).map(s => s.id);
    const freeStudents = state.students.map(s => s.id).filter(id => !fixedStudents.has(id));

    const RESTARTS = 9, ITERS = 1400;
    let best = null, bestScore = Infinity;

    for (let r = 0; r < RESTARTS; r++) {
        const assign = Object.assign({}, fixed);
        const pool = freeStudents.slice();
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        for (let i = 0; i < freeSeatIds.length; i++) if (i < pool.length) assign[freeSeatIds[i]] = pool[i];
        let curScore = scoreAssign(assign, ctx);
        let T = 6;
        for (let it = 0; it < ITERS; it++) {
            if (freeSeatIds.length < 2) break;
            const p = freeSeatIds[Math.floor(Math.random() * freeSeatIds.length)];
            const q = freeSeatIds[Math.floor(Math.random() * freeSeatIds.length)];
            if (p === q) continue;
            if (assign[p] === undefined && assign[q] === undefined) continue;
            swapSeats(assign, p, q);
            const sc = scoreAssign(assign, ctx);
            if (sc <= curScore || Math.random() < Math.exp((curScore - sc) / T)) {
                curScore = sc;
            } else { // revert — swapping back restores the original placement
                swapSeats(assign, p, q);
            }
            T *= 0.997;
        }
        if (curScore < bestScore) { bestScore = curScore; best = Object.assign({}, assign); }
    }
    state.assign = best;
    // invariant: annealing must place as many students as a plain fill would.
    // If a future swap regression drops students, fail loud and degrade to shuffle.
    const placed = new Set(Object.values(state.assign).filter(v => v !== undefined));
    const expected = Math.min(state.students.length, state.seats.length);
    if (placed.size !== expected) {
        console.error(`smartArrange dropped students: placed ${placed.size}/${expected}`);
        fillSeats(state.students.map(s => s.id));
    }
    save(); render();
    if (!silent) explainResult(ctx);
}

function explainResult(ctx) {
    const assign = state.assign;
    const seatOf = {}; for (const seatId in assign) seatOf[assign[seatId]] = seatId;
    const adjacentNow = new Set();
    for (const [s1, s2] of ctx.edges) { const a = assign[s1], b = assign[s2]; if (a && b) adjacentNow.add(pairKey(a, b)); }
    const lines = [];
    let problems = 0;

    // "problems" counts only hard (Må) violations — those decide the headline / modal.
    if (ctx.apart.size) {
        let total = 0, satisfied = 0, mustViol = 0;
        ctx.apart.forEach((st, k) => { total++; if (!adjacentNow.has(k)) satisfied++; else if (st === 'must') mustViol++; });
        problems += mustViol;
        lines.push(rowLine(mustViol === 0, `${satisfied}/${total} «hold fra hverandre» oppfylt`));
    }
    if (ctx.together.length) {
        let ok = 0, mustViol = 0;
        ctx.together.forEach(t => {
            const sa = seatOf[t.a];
            const good = sa && ctx.adj[sa].some(nb => t.members.has(assign[nb]));
            if (good) ok++; else if (t.strength === 'must') mustViol++;
        });
        problems += mustViol;
        lines.push(rowLine(mustViol === 0, `${ok}/${ctx.together.length} «ved siden av» oppfylt`));
    }
    if (ctx.placeWants.length) {
        const band = (SEAT_H + RGAP) * 1.2;
        let ok = 0, mustViol = 0;
        ctx.placeWants.forEach(w => {
            const se = seatOf[w.id]; let good = false;
            if (se) { const y = ctx.seatById[se].y; good = w.side === 'front' ? (y <= ctx.minY + band) : (y >= ctx.maxY - band); }
            if (good) ok++; else if (w.strength === 'must') mustViol++;
        });
        problems += mustViol;
        lines.push(rowLine(mustViol === 0, `${ok}/${ctx.placeWants.length} «foran/bak» oppfylt`));
    }
    if (ctx.prefs.balanceGender) {
        let same = 0, tot = 0;
        for (const [s1, s2] of ctx.edges) { const a = assign[s1], b = assign[s2]; if (a && b && ctx.genderOf[a] && ctx.genderOf[b]) { tot++; if (ctx.genderOf[a] === ctx.genderOf[b]) same++; } }
        lines.push(rowLine(same === 0, `Kjønnsbalanse: ${tot - same}/${tot} naborelasjoner blandet`));
    }
    if (ctx.prefs.avoidRepeat && ctx.prevPairs.size) {
        let rep = 0; adjacentNow.forEach(k => { if (ctx.prevPairs.has(k)) rep++; });
        lines.push(rowLine(rep === 0, `${rep} gjentatte naboer fra forrige kart`));
    }
    if (!lines.length) lines.push(rowLine(true, 'Plasserte elevene tilfeldig (ingen regler satt enda)'));

    const headline = problems === 0 ? 'Alt gikk opp! 🎯' : 'Beste mulige plassering — noe kolliderte:';
    $('resultsBody').innerHTML = `<p class="results-head">${headline}</p>` + lines.join('');

    // Report under the button rather than in a dialog. Smart plassering is the
    // tool's most distinctive move, so its outcome should be the most visible
    // thing on the page — not something you dismiss to get back to the board.
    // The full breakdown stays one click away for when a rule actually fails.
    const el = $('smartResult');
    el.className = 'kk-result ' + (problems === 0 ? 'is-ok' : 'is-warn');
    el.innerHTML = (problems === 0
        ? 'Alt gikk opp 🎯'
        : `${problems} «må»-regel${problems > 1 ? 'er' : ''} kolliderte`)
        + ' <button type="button" class="link-btn" id="smartDetailsBtn">Se detaljer</button>';
    el.hidden = false;
    $('smartDetailsBtn').addEventListener('click', () => openModal('resultsModal'));
}
/* The summary describes one specific arrangement, so it stops being true the
 * moment the seating changes. pushUndo() runs before every mutating op, which
 * makes it the one reliable place to retire it. */
function clearSmartResult() {
    const el = $('smartResult');
    if (el && !el.hidden) { el.hidden = true; el.innerHTML = ''; }
}
function rowLine(ok, txt) {
    return `<div class="result-line ${ok ? 'ok' : 'warn'}"><span class="ri">${ok ? '✓' : '⚠'}</span>${escapeHtml(txt)}</div>`;
}

/* ----------------------------------------------------------------- render   */
/* Which edge each desk's chair pokes out of (= where the student sits, opposite
 * the way they face). A 2-D tight cluster (pod, horseshoe) → face the cluster
 * centre, so chairs point outward; a 1-D run (a side-by-side pair, a column) and
 * lone desks → face the board, so chairs point to the back. */
const CHAIR_D = 52, CHAIR_POKE = 18;
function seatChairDirs() {
    const byId = {}; state.seats.forEach(s => byId[s.id] = s);
    const dirOf = {};
    clustersOf(state.seats).forEach(cl => {
        const xs = new Set(), ys = new Set();
        cl.forEach(id => { xs.add(Math.round(byId[id].x / 4)); ys.add(Math.round(byId[id].y / 4)); });
        if (!(xs.size > 1 && ys.size > 1)) { cl.forEach(id => dirOf[id] = 'down'); return; } // 1-D run faces board
        let cx = 0, cy = 0;
        cl.forEach(id => { cx += byId[id].x + SEAT_W / 2; cy += byId[id].y + SEAT_H / 2; });
        cx /= cl.length; cy /= cl.length;
        cl.forEach(id => {
            const dx = (byId[id].x + SEAT_W / 2) - cx, dy = (byId[id].y + SEAT_H / 2) - cy;
            dirOf[id] = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
        });
    });
    state.seats.forEach(s => { if (!(s.id in dirOf)) dirOf[s.id] = 'down'; }); // lone desk → face board
    // manual override wins, but only if that edge is still free (not jammed against a desk)
    state.seats.forEach(s => { if (s.chair && chairAllowedEdges(s).indexOf(s.chair) !== -1) dirOf[s.id] = s.chair; });
    return dirOf;
}
/* Edges where a chair fits — i.e. no desk pushed tightly against that side.
 * Aisle/row gaps leave room to sit; within-cluster (tight) gaps do not. */
function chairAllowedEdges(seat) {
    const out = [];
    const blocked = dir => state.seats.some(b => {
        if (b.id === seat.id) return false;
        const sameRow = Math.abs(b.y - seat.y) <= SEAT_H * 0.5, sameCol = Math.abs(b.x - seat.x) <= SEAT_W * 0.5;
        if (dir === 'right') return sameRow && b.x > seat.x && b.x - seat.x - SEAT_W <= ADJ_TIGHT_H;
        if (dir === 'left') return sameRow && b.x < seat.x && seat.x - b.x - SEAT_W <= ADJ_TIGHT_H;
        if (dir === 'down') return sameCol && b.y > seat.y && b.y - seat.y - SEAT_H <= ADJ_TIGHT_V;
        return sameCol && b.y < seat.y && seat.y - b.y - SEAT_H <= ADJ_TIGHT_V; // up
    });
    ['up', 'right', 'down', 'left'].forEach(d => { if (!blocked(d)) out.push(d); });
    return out;
}
/* Rotate a desk's chair to the next free edge (edit mode). */
function rotateChair(seatId) {
    const seat = state.seats.find(s => s.id === seatId);
    if (!seat) return;
    const allowed = chairAllowedEdges(seat);
    if (allowed.length < 2) { toast('Ingen ledige kanter å snu stolen til', 'err'); return; }
    const shown = (seat.chair && allowed.indexOf(seat.chair) !== -1) ? seat.chair : seatChairDirs()[seatId];
    const next = allowed[(allowed.indexOf(shown) + 1) % allowed.length];
    pushUndo();
    seat.chair = next;
    state.roomMode = 'custom';
    save(); render();
}
/* top-left of the chair circle (board coords) for a given desk + direction */
function chairXY(seat, dir) {
    const cxL = seat.x + (SEAT_W - CHAIR_D) / 2, cyT = seat.y + (SEAT_H - CHAIR_D) / 2;
    if (dir === 'up') return [cxL, seat.y - CHAIR_POKE];
    if (dir === 'left') return [seat.x - CHAIR_POKE, cyT];
    if (dir === 'right') return [seat.x + SEAT_W - CHAIR_D + CHAIR_POKE, cyT];
    return [cxL, seat.y + SEAT_H - CHAIR_D + CHAIR_POKE]; // down
}

function render() {
    renderBoard();
    renderPool();
    applySelection();
    updateSelBar();
}
function renderBoard() {
    const board = $('board');
    board.innerHTML = '';
    if (state.seats.length) {
        boardW = Math.max(...state.seats.map(s => s.x + SEAT_W));
        boardH = Math.max(...state.seats.map(s => s.y + SEAT_H));
    } else { boardW = SEAT_W; boardH = SEAT_H; }
    board.style.width = boardW + 'px';
    board.style.height = boardH + 'px';
    const chairDirs = seatChairDirs();
    for (const seat of state.seats) {
        {
            const [cl, ct] = chairXY(seat, chairDirs[seat.id]);
            const chair = document.createElement('div');
            chair.className = 'chair' + (editMode ? ' chair-edit' : '');
            if (editMode) { chair.dataset.seatId = seat.id; chair.title = 'Klikk for å snu stolen til neste ledige kant'; }
            chair.style.left = cl + 'px'; chair.style.top = ct + 'px';
            board.appendChild(chair);
        }
        const seatEl = document.createElement('div');
        seatEl.className = 'seat';
        seatEl.style.left = seat.x + 'px';
        seatEl.style.top = seat.y + 'px';
        seatEl.dataset.seatId = seat.id;
        const sid = state.assign[seat.id];
        if (sid) {
            const stu = studentById(sid);
            if (stu) {
                seatEl.classList.add('occupied');
                if (stu.gender === 'G') seatEl.classList.add('g-boy');
                else if (stu.gender === 'J') seatEl.classList.add('g-girl');
                const tok = document.createElement('div');
                tok.className = 'token';
                tok.dataset.studentId = sid;
                const nm = document.createElement('span');
                nm.className = 'tok-name';
                nm.textContent = stu.name;
                tok.appendChild(nm);
                if (stu.front) tok.appendChild(badge('front' + (stu.front === 'must' ? ' must' : ''), '⬆'));
                if (stu.back) tok.appendChild(badge('back' + (stu.back === 'must' ? ' must' : ''), '⬇'));
                if (isLocked(sid)) tok.appendChild(badge('lock', '🔒'));
                seatEl.appendChild(tok);
            }
        }
        if (editMode) {
            const del = document.createElement('button');
            del.className = 'seat-del'; del.type = 'button'; del.title = 'Fjern pult';
            del.textContent = '✕';
            seatEl.appendChild(del);
        }
        board.appendChild(seatEl);
    }
    fitBoard();
}
function badge(cls, txt) {
    const b = document.createElement('span');
    b.className = 'tok-badge ' + cls;
    b.textContent = txt;
    return b;
}
function renderPool() {
    const list = $('poolList');
    list.innerHTML = '';
    const seated = new Set(Object.values(state.assign));
    const unseated = state.students.filter(s => !seated.has(s.id));
    for (const stu of unseated) {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.dataset.studentId = stu.id;
        if (stu.gender === 'G') chip.classList.add('g-boy');
        else if (stu.gender === 'J') chip.classList.add('g-girl');
        chip.textContent = stu.name;
        if (stu.front) chip.appendChild(badge('front', '⬆'));
        if (stu.back) chip.appendChild(badge('back', '⬇'));
        list.appendChild(chip);
    }
    $('poolCount').textContent = unseated.length;
    $('pool').classList.toggle('is-empty', unseated.length === 0);
}
const ZOOM_MIN = 0.2, ZOOM_MAX = 3;
function fitBoard() {
    const stage = $('stage');
    const front = $('boardFront');
    const barPad = editMode ? 104 : 0; // keep the edit toolbar from covering the bottom row
    const availW = stage.clientWidth - 36;
    const availH = stage.clientHeight - front.offsetHeight - 52 - barPad;
    const maxScale = presentMode ? 3 : 1.5;
    let autoScale = Math.min(availW / boardW, availH / boardH, maxScale);
    if (!isFinite(autoScale) || autoScale <= 0) autoScale = 1;
    autoScale = Math.max(autoScale, ZOOM_MIN);
    const scale = zoom != null ? clamp(zoom, ZOOM_MIN, ZOOM_MAX) : autoScale;
    boardScale = scale;
    const board = $('board'), wrap = $('boardWrap');
    board.style.transformOrigin = 'top left';
    board.style.transform = 'scale(' + scale + ')';
    wrap.style.width = (boardW * scale) + 'px';
    wrap.style.height = (boardH * scale) + 'px';
    // scroll slack so a zoomed-in last row can be brought above the edit bar
    wrap.style.marginBottom = editMode ? '108px' : '';
    updateZoomLabel();
}
function setZoom(z) {
    zoom = z == null ? null : clamp(z, ZOOM_MIN, ZOOM_MAX);
    fitBoard();
}
function zoomBy(factor) { setZoom(clamp((boardScale || 1) * factor, ZOOM_MIN, ZOOM_MAX)); }
function updateZoomLabel() {
    const el = $('zoomLabel');
    if (el) el.textContent = Math.round((boardScale || 1) * 100) + '%';
}
function applySelection() {
    document.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    if (!selected) return;
    document.querySelectorAll('[data-student-id]').forEach(el => { if (el.dataset.studentId === selected) el.classList.add('selected'); });
}
function setSelected(sid) { selected = sid; applySelection(); updateSelBar(); }
function updateSelBar() {
    const bar = $('selBar');
    if (!selected || presentMode) { bar.classList.add('hidden'); return; }
    const stu = studentById(selected);
    if (!stu) { bar.classList.add('hidden'); return; }
    $('selName').textContent = stu.name;
    const seated = !!seatOfStudent(selected);
    $('selLockBtn').textContent = isLocked(selected) ? '🔓 Lås opp' : '🔒 Lås plass';
    $('selLockBtn').style.display = seated ? '' : 'none';
    $('selPoolBtn').style.display = seated ? '' : 'none';
    bar.classList.remove('hidden');
}

/* ------------------------------------------------------- drag & drop (ptr)  */
function onPointerDown(e) {
    suppressClick = false;
    if (e.button && e.button !== 0) return;
    if (editMode) { onEditPointerDown(e); return; }
    const el = e.target.closest('.token, .chip');
    if (!el) return;
    drag = { sid: el.dataset.studentId, el, startX: e.clientX, startY: e.clientY, moved: false, ghost: null };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
}
function onPointerMove(e) {
    if (!drag) return;
    if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
        if (isLocked(drag.sid)) { drag = null; cleanupDragListeners(); return; }
        drag.moved = true;
        const stu = studentById(drag.sid);
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.textContent = stu ? stu.name : '';
        document.body.appendChild(ghost);
        drag.ghost = ghost;
        drag.el.style.opacity = '0.3';
    }
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
    highlightDrop(e.clientX, e.clientY);
}
function onPointerUp(e) {
    cleanupDragListeners();
    if (!drag) return;
    if (drag.moved) {
        const target = dropTargetAt(e.clientX, e.clientY);
        clearDropHighlight();
        if (drag.ghost) drag.ghost.remove();
        const sid = drag.sid; drag = null; suppressClick = true;
        if (target && target.type === 'seat') placeStudent(sid, target.seatId);
        else if (target && target.type === 'pool') unseat(sid);
        else render();
    } else { drag = null; }
}
function cleanupDragListeners() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
}
function dropTargetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const seat = el.closest('.seat');
    if (seat) return { type: 'seat', seatId: seat.dataset.seatId };
    if (el.closest('#pool')) return { type: 'pool' };
    return null;
}
function highlightDrop(x, y) {
    clearDropHighlight();
    const t = dropTargetAt(x, y);
    if (!t) return;
    if (t.type === 'seat') { const s = document.querySelector('.seat[data-seat-id="' + t.seatId + '"]'); if (s) s.classList.add('drop-hover'); }
    else if (t.type === 'pool') $('pool').classList.add('drop-hover');
}
function clearDropHighlight() { document.querySelectorAll('.drop-hover').forEach(el => el.classList.remove('drop-hover')); }

/* --------------------------------------------------- manual desk editing    */
function newSeatId() { return 'seat_' + uid(); }
function clientToBoard(cx, cy) {
    const rect = $('board').getBoundingClientRect();
    const s = boardScale || 1;
    return { x: (cx - rect.left) / s, y: (cy - rect.top) / s };
}
function snap(v, step) { return Math.round(v / step) * step; }
/* Grow the room on the left/top: if any desk has been dragged into negative
 * space, shift every desk back by whole grid steps so the minimum is ≥ 0. Whole
 * steps keep the lattice (and existing pair offsets) aligned. Returns the shift. */
function growToFit() {
    if (!state.seats.length) return { ox: 0, oy: 0 };
    const minX = Math.min(...state.seats.map(s => s.x)), minY = Math.min(...state.seats.map(s => s.y));
    const ox = minX < 0 ? Math.ceil(-minX / GRID_X) * GRID_X : 0;
    const oy = minY < 0 ? Math.ceil(-minY / GRID_Y) * GRID_Y : 0;
    if (ox || oy) state.seats.forEach(s => { s.x += ox; s.y += oy; });
    return { ox, oy };
}
/* per-axis snap: lands on the lattice, but if the desk is dragged close to a
 * neighbour in the same row/column it clicks into a tidy pair gap or separation
 * gap — this is how you build "pairs with a gap between" in either direction.
 *   raw      – the raw board coordinate on this axis
 *   crossVal – the (already snapped) coordinate on the other axis
 *   axis     – 'x' or 'y'                                                      */
function snapEditAxis(raw, crossVal, axis, selfId) {
    const horiz = axis === 'x';
    const step = horiz ? GRID_X : GRID_Y;
    const crossStep = horiz ? GRID_Y : GRID_X;
    const pair = horiz ? PAIR_DX : PAIR_DY;
    const sep = horiz ? SEP_DX : SEP_DY;
    let n = snap(raw, step);
    let best = Math.abs(n - raw);
    const consider = cand => { const d = Math.abs(cand - raw); if (d <= PAIR_SNAP && d < best) { best = d; n = cand; } };
    const sameBand = [], adjBand = [];
    for (const s of state.seats) {
        if (s.id === selfId) continue;
        const cd = Math.abs((horiz ? s.y : s.x) - crossVal), sMain = horiz ? s.x : s.y;
        if (cd <= crossStep * 0.5) sameBand.push(sMain);          // same row (x) / column (y)
        else if (cd <= crossStep * 1.5) adjBand.push(sMain);      // one row / column away
    }
    // same band: click into a tidy pair or separation gap on either side
    sameBand.forEach(m => { consider(m + pair); consider(m - pair); consider(m + sep); consider(m - sep); });
    // adjacent band: line up directly (column under a desk) or centre between two
    // nearby desks — the half-step that makes a group of three (pyramid) snap.
    adjBand.forEach(consider);
    for (let i = 0; i < adjBand.length; i++) for (let j = i + 1; j < adjBand.length; j++)
        if (Math.abs(adjBand[i] - adjBand[j]) <= 2 * step) consider((adjBand[i] + adjBand[j]) / 2);
    return n;
}

function enterEditMode() {
    if (!editMode) {
        editMode = true;
        setSelected(null);
        document.body.classList.add('editing');
        $('editBar').classList.remove('hidden');
        render();
        toast('Rediger pulter – dra, trykk for ny, ✕ for å fjerne', 'ok');
    }
}
function exitEditMode() {
    if (editMode) {
        editMode = false;
        document.body.classList.remove('editing');
        $('editBar').classList.add('hidden');
        render();
    }
}

function onEditPointerDown(e) {
    const chairEl = e.target.closest('.chair');
    if (chairEl) { suppressClick = true; rotateChair(chairEl.dataset.seatId); e.preventDefault(); return; } // rotate, don't drag/add
    if (e.target.closest('.seat-del')) return; // deletion handled on click
    const seatEl = e.target.closest('.seat');
    const start = { x: e.clientX, y: e.clientY };
    if (seatEl) {
        const seat = state.seats.find(s => s.id === seatEl.dataset.seatId);
        if (!seat) return;
        deskDrag = { type: 'move', seat, el: seatEl, start, originX: seat.x, originY: seat.y, moved: false, before: snapshot() };
    } else if (e.target.closest('#board') || e.target.closest('.stage')) {
        deskDrag = { type: 'add', start, moved: false };
    } else return;
    window.addEventListener('pointermove', onEditMove);
    window.addEventListener('pointerup', onEditUp);
    window.addEventListener('pointercancel', onEditUp);
    e.preventDefault();
}
function onEditMove(e) {
    if (!deskDrag) return;
    const dx = e.clientX - deskDrag.start.x, dy = e.clientY - deskDrag.start.y;
    if (!deskDrag.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        deskDrag.moved = true;
    }
    if (deskDrag.type !== 'move') return; // dragging empty space does nothing
    const s = boardScale || 1;
    const bdx = dx / s, bdy = dy / s;
    const rx = deskDrag.originX + bdx, ry = deskDrag.originY + bdy;
    let nx, ny;
    if (e.altKey) { nx = rx; ny = ry; }                              // free nudge
    else {                                                            // lattice + pair snapping (both axes)
        const gx = snap(rx, GRID_X), gy = snap(ry, GRID_Y);
        nx = snapEditAxis(rx, gy, 'x', deskDrag.seat.id);
        ny = snapEditAxis(ry, gx, 'y', deskDrag.seat.id);
    }
    deskDrag.seat.x = nx; deskDrag.seat.y = ny;
    // No origin clamp: dragging left/up past 0 grows the room on that side. When
    // that happens we re-base everyone and re-render, then re-grab the dragged el.
    const { ox, oy } = growToFit();
    if (ox || oy) {
        deskDrag.originX += ox; deskDrag.originY += oy;
        render();
        deskDrag.el = $('board').querySelector('.seat[data-seat-id="' + deskDrag.seat.id + '"]');
    } else if (deskDrag.el) {
        deskDrag.el.style.left = deskDrag.seat.x + 'px'; deskDrag.el.style.top = deskDrag.seat.y + 'px';
    }
}
function onEditUp(e) {
    window.removeEventListener('pointermove', onEditMove);
    window.removeEventListener('pointerup', onEditUp);
    window.removeEventListener('pointercancel', onEditUp);
    if (!deskDrag) return;
    const d = deskDrag; deskDrag = null;
    if (d.type === 'move' && d.moved) { suppressClick = true; pushUndo(d.before); state.roomMode = 'custom'; save(); render(); }
    else if (d.type === 'add' && !d.moved) { suppressClick = true; addSeatAt(e.clientX, e.clientY); }
}
function addSeatAt(cx, cy) {
    pushUndo();
    const p = clientToBoard(cx, cy);
    let x = snap(p.x - SEAT_W / 2, GRID_X);
    let y = snap(p.y - SEAT_H / 2, GRID_Y);
    while (state.seats.some(s => Math.abs(s.x - x) < 4 && Math.abs(s.y - y) < 4)) x += GRID_X; // avoid stacking
    state.seats.push({ id: newSeatId(), x, y });
    growToFit(); // a click in the left/top margin lands at negative coords — grow instead of clamp
    state.roomMode = 'custom';
    save(); render();
}
function deleteSeat(seatId) {
    pushUndo();
    state.seats = state.seats.filter(s => s.id !== seatId);
    delete state.assign[seatId]; // any occupant falls back to the pool
    state.roomMode = 'custom';
    save(); render();
}
function alignAllDesks() {
    if (!state.seats.length) return;
    pushUndo();
    const taken = new Set();
    state.seats.forEach(s => {
        let x = Math.max(0, snap(s.x, GRID_X)), y = Math.max(0, snap(s.y, GRID_Y));
        while (taken.has(x + ',' + y)) x += GRID_X; // never stack two desks on one cell
        taken.add(x + ',' + y);
        s.x = x; s.y = y;
    });
    state.roomMode = 'custom';
    save(); render();
    toast('Pultene er justert til rutenettet', 'ok');
}

/* ------------------------------------------------------------- tap to swap  */
function onClick(e) {
    if (suppressClick) { suppressClick = false; return; }
    if (editMode) {
        const del = e.target.closest('.seat-del');
        if (del) { const seatEl = del.closest('.seat'); if (seatEl) deleteSeat(seatEl.dataset.seatId); }
        return;
    }
    const tokenEl = e.target.closest('.token, .chip');
    const seatEl = e.target.closest('.seat');
    const poolEl = e.target.closest('#pool');
    if (tokenEl) {
        const sid = tokenEl.dataset.studentId;
        if (selected === sid) { setSelected(null); return; }
        if (selected) {
            const seatId = tokenEl.closest('.seat') ? tokenEl.closest('.seat').dataset.seatId : null;
            if (seatId) { placeStudent(selected, seatId); setSelected(null); }
            else setSelected(sid);
            return;
        }
        setSelected(sid); return;
    }
    if (seatEl) { if (selected) { placeStudent(selected, seatEl.dataset.seatId); setSelected(null); } return; }
    if (poolEl) { if (selected) { unseat(selected); setSelected(null); } return; }
    if (selected) setSelected(null);
}

/* ------------------------------------------------------------------ toast   */
let toastTimer = null;
function toast(msg, type) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 2200);
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ----------------------------------------------------------- screen control */
function showApp() {
    zoom = null;
    resetUndo();
    $('setup').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('classMenuLabel').textContent = state.name;
    clearSmartResult();
    setTab('kart');
    requestAnimationFrame(fitBoard);
}
function showSetup() {
    if (editMode) exitEditMode();
    $('app').classList.add('hidden');
    $('setup').classList.remove('hidden');
    // Coming back from the board is a normal way to reach this screen, so the
    // fetch panel has to be decided here too — not only on first load.
    probeIdentity().then(updateSetupFetch);
}

/* -------------------------------------------- class codes (school config)   */
/* Replaces the old `Klasser/` folder of committed name lists. The config holds
 * class CODES only ("9B") — never pupils. Rosters come from a Vigilo CSV that
 * is read in the browser and never uploaded. */
let classCodes = [];                  // ['8A','8B',…] flattened across grades

function readCachedConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null'); }
    catch (e) { return null; }
}
function applyConfig(cfg) {
    if (!cfg || !Array.isArray(cfg.grades)) return false;
    classCodes = cfg.grades.flatMap(g => Array.isArray(g.classes) ? g.classes : []);
    return true;
}
/* Cache first so the picker is populated instantly, then refresh in the
 * background. Mirrors refreshSchoolConfig() in teacher.js. */
async function loadClassCodes() {
    applyConfig(readCachedConfig());
    populateClassSelect();
    try {
        const res = await fetch(`${SCRIPT_URL}?action=config`, { credentials: 'include' });
        const cfg = await res.json();
        if (cfg && !cfg.error && applyConfig(cfg)) {
            try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) {}
            populateClassSelect();
        }
    } catch (e) { /* offline – the cached list stands */ }
}
function populateClassSelect() {
    const sel = $('setupClassSelect');
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = '<option value="">Velg klasse…</option>';
    classCodes.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
    if (keep && classCodes.includes(keep)) sel.value = keep;
}

/* --------------------------------------------------------- CSV roster import */
/* Reads a Vigilo export (klasse or faggruppe) in the browser. Nothing is
 * uploaded. A names-only export imports straight through; anything with more
 * columns gets a mapping step, and every unmapped column is DISCARDED here —
 * never stored. Extra columns would otherwise ride along into the JSON backup
 * and the PDF export, quietly turning a seating tool into a second store of
 * administrative pupil data. */
let csvRows = null;      // string[][] held only while the mapping modal is open
let csvNameCol = 0;

/* Norwegian exports are semicolon-delimited more often than comma. A character
 * only counts as the delimiter if it splits EVERY line into the same number of
 * fields (≥2). Anything looser misreads punctuation inside a value — a
 * names-only export of "Berg, Ailo" would otherwise look like two columns, and
 * the surname would be imported as the pupil's name. Falling back to
 * single-column is the safe wrong answer; splitting on a comma is not. */
function csvSniffDelim(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 20);
    if (!lines.length) return ';';
    let best = null, bestCols = 1;
    for (const d of [';', '\t', ',']) {
        const counts = lines.map(l => l.split(d).length);
        if (Math.min(...counts) < 2) continue;      // a line without the delimiter rules it out
        const freq = {};
        counts.forEach(n => { freq[n] = (freq[n] || 0) + 1; });
        const modal = Number(Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0]);
        // Tolerate the odd ragged line (a stray trailing delimiter), not a
        // fundamentally different shape.
        if (modal < 2 || freq[modal] / counts.length < 0.8) continue;
        if (modal > bestCols) { best = d; bestCols = modal; }
    }
    return best || ';';
}
/* Vigilo/Windows tooling still emits Windows-1252. Decode as UTF-8 first; if
 * the result carries the U+FFFD replacement char, the bytes weren't UTF-8, so
 * fall back. Teachers must never have to think about encodings. */
function csvDecode(buf) {
    const utf8 = new TextDecoder('utf-8').decode(buf);
    if (!utf8.includes('�')) return utf8;
    try { return new TextDecoder('windows-1252').decode(buf); }
    catch (e) { return utf8; }
}
/* "Nordmann, Ola" → "Ola Nordmann". Only when the cell itself holds the comma;
 * a comma-delimited file has already been split by then. */
function csvFixName(s) {
    const t = s.trim().replace(/^"|"$/g, '').trim();
    const m = t.match(/^([^,]+),\s*(.+)$/);
    return m ? `${m[2].trim()} ${m[1].trim()}` : t;
}
function csvParse(text) {
    const d = csvSniffDelim(text);
    return text.split(/\r?\n/).filter(l => l.trim())
        .map(l => l.split(d).map(c => c.trim().replace(/^"|"$/g, '')));
}
/* A header row is one whose cells look like field names rather than a person. */
function csvLooksLikeHeader(row) {
    return row.some(c => /^(navn|elev|fornavn|etternavn|name|klasse|gruppe|f[øo]dselsdato|id)$/i.test(c.trim()));
}
function csvHandleFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
        const rows = csvParse(csvDecode(reader.result));
        if (!rows.length) { toast('Fila er tom', 'err'); return; }
        const cols = Math.max(...rows.map(r => r.length));
        if (cols === 1) { csvApply(rows, 0); return; }   // names-only: straight through
        csvRows = rows; csvNameCol = csvGuessNameCol(rows);
        renderCsvMap();
        openModal('csvModal');
    };
    reader.onerror = () => toast('Kunne ikke lese fila', 'err');
    reader.readAsArrayBuffer(file);
}
/* Prefer a column whose header names it; otherwise the one with the most
 * space-separated, non-numeric values. */
function csvGuessNameCol(rows) {
    const head = csvLooksLikeHeader(rows[0]) ? rows[0] : null;
    if (head) {
        const i = head.findIndex(c => /^(navn|elev(navn)?|name|fornavn)$/i.test(c.trim()));
        if (i >= 0) return i;
    }
    const body = head ? rows.slice(1) : rows;
    const cols = Math.max(...rows.map(r => r.length));
    let best = 0, bestScore = -1;
    for (let c = 0; c < cols; c++) {
        const vals = body.map(r => (r[c] || '').trim()).filter(Boolean);
        if (!vals.length) continue;
        const score = vals.filter(v => /[a-zæøåA-ZÆØÅ]/.test(v) && !/^\d+$/.test(v)).length
            + vals.filter(v => /\s|,/.test(v)).length;
        if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
}
function renderCsvMap() {
    const head = csvLooksLikeHeader(csvRows[0]) ? csvRows[0] : null;
    const body = head ? csvRows.slice(1) : csvRows;
    const cols = Math.max(...csvRows.map(r => r.length));
    let html = '';
    for (let c = 0; c < cols; c++) {
        const sample = body.slice(0, 3).map(r => escapeHtml((r[c] || '').trim())).filter(Boolean).join(' · ') || '–';
        const label = head ? escapeHtml((head[c] || '').trim() || `Kolonne ${c + 1}`) : `Kolonne ${c + 1}`;
        html += `<label class="csv-col ${c === csvNameCol ? 'is-name' : ''}">
            <input type="radio" name="csvcol" value="${c}" ${c === csvNameCol ? 'checked' : ''}>
            <span class="csv-col-name">${label}</span>
            <span class="csv-col-sample">${sample}</span>
            <span class="csv-col-tag">${c === csvNameCol ? 'navn' : 'forkastes'}</span>
        </label>`;
    }
    $('csvMap').innerHTML = html;
    $('csvSummary').textContent = `${body.length} rader · 1 kolonne beholdes, ${cols - 1} forkastes.`;
    $('csvMap').querySelectorAll('input[name="csvcol"]').forEach(r =>
        r.addEventListener('change', () => { csvNameCol = parseInt(r.value, 10); renderCsvMap(); }));
}
function csvApply(rows, col) {
    const head = csvLooksLikeHeader(rows[0]) ? rows[0] : null;
    const body = head ? rows.slice(1) : rows;
    const names = body.map(r => csvFixName(r[col] || '')).filter(Boolean);
    if (!names.length) { toast('Fant ingen navn i den kolonnen', 'err'); return; }
    $('setupNames').value = names.join('\n');
    $('setupNames').dispatchEvent(new Event('input'));
    csvRows = null;                       // drop the parsed file; nothing else is kept
    closeModal('csvModal');
    toast(`Hentet ${names.length} elever`, 'ok');
}

/* --------------------------------------------------------------- setup flow */
function parseNames(text) { return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean); }

function startNewClass(names, preset, className, kind) {
    const c = normClass({ name: (className && className.trim()) || 'Klasse', kind, room: preset,
        students: names.map(n => ({ name: n })) });
    c.seats = generateSeats(preset, c.students.length);
    store = store || { activeClassId: null, classes: {}, roomTemplates: [] };
    store.roomTemplates = store.roomTemplates || [];
    store.classes[c.id] = c;
    store.activeClassId = c.id;
    state = c;
    fillSeats(state.students.map(s => s.id));
    save(); showApp(); render();
}

/* ----------------------------------------------------------------- tabs     */
/* The five layers. Room, pupils and seating change on different rhythms, so the
 * tab rail is the structure rather than a flat pile of buttons behind a ⋯.
 *
 * Elever/Regler/Rom/Innsikt used to be modals. Their markup is unchanged — it
 * just lives inside the app now — so instead of rewriting every call site,
 * openModal()/closeModal() below route those ids to a tab switch. Any modal not
 * in this map (per-student prefs, CSV mapping, smart-placement details) still
 * behaves as a real dialog, which is right: those are interruptions by nature. */
const VIEW_OF_MODAL = {
    studentsModal: 'elever', rulesModal: 'regler', roomModal: 'rom',
    historyModal: 'innsikt', statsModal: 'innsikt',
};
const SUB_OF_MODAL = { historyModal: 'historikk', statsModal: 'statistikk' };
let activeTab = 'kart';

function setTab(name, sub) {
    if (editMode && name !== 'kart') exitEditMode();
    activeTab = name;
    document.querySelectorAll('#kkTabs .kk-tab').forEach(t => {
        const on = t.dataset.tab === name;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('view-kart').classList.toggle('hidden', name !== 'kart');
    $('view-innsikt').classList.toggle('hidden', name !== 'innsikt');
    ['studentsModal', 'rulesModal', 'roomModal'].forEach(id =>
        $(id).classList.toggle('hidden', VIEW_OF_MODAL[id] !== name));
    closeAllDropdowns();
    // Populate on reveal. These call back into openModal(), which is idempotent
    // once activeTab already matches — see the note there.
    if (name === 'elever') openStudentsModal();
    else if (name === 'regler') openRulesModal();
    else if (name === 'rom') openRoomModal();
    else if (name === 'innsikt') setInnsiktSub(sub || innsiktSub);
    else if (name === 'kart') requestAnimationFrame(fitBoard);
}
let innsiktSub = 'historikk';
function setInnsiktSub(sub) {
    innsiktSub = sub;
    document.querySelectorAll('#innsiktSeg button').forEach(b => b.classList.toggle('on', b.dataset.sub === sub));
    ['historyModal', 'statsModal'].forEach(id =>
        $(id).classList.toggle('hidden', SUB_OF_MODAL[id] !== sub));
    if (sub === 'historikk') renderHistory();
    else if (sub === 'statistikk') openStatsModal();
}

/* --------------------------------------------------------------- modals     */
function openModal(id) {
    const view = VIEW_OF_MODAL[id];
    if (view) {
        // Idempotent on purpose: setInnsiktSub() calls the open*Modal()
        // populators, which call back in here. Already being on the right
        // tab must be a no-op, or that round-trips forever.
        const sub = SUB_OF_MODAL[id];
        if (activeTab !== view || (sub && innsiktSub !== sub)) setTab(view, sub);
        return;
    }
    $(id).classList.add('show');
}
function closeModal(id) {
    if (VIEW_OF_MODAL[id]) { setTab('kart'); return; }
    $(id).classList.remove('show');
}
function closeAllDropdowns() { document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open')); }

/* -- rules modal -- */
let editingRuleId = null;
function openRulesModal() {
    $('prefBalanceGender').checked = !!state.prefs.balanceGender;
    $('prefAvoidRepeat').checked = !!state.prefs.avoidRepeat;
    $('prefAvoidAll').checked = !!state.prefs.avoidAllRepeat;
    $('prefBalanceTags').checked = !!state.prefs.balanceTags;
    fillStudentSelect($('ruleA'));
    fillMemberPicker();
    setRuleEditMode(null);
    renderRulesList();
    openModal('rulesModal');
}
/* Load a rule into the add-form for editing (rule = null clears the form). */
function setRuleEditMode(rule) {
    const boxes = $('ruleMembers').querySelectorAll('input');
    if (rule) {
        editingRuleId = rule.id;
        $('ruleStrength').value = rule.strength;
        $('ruleType').value = rule.type;
        $('ruleA').value = rule.a;
        const members = new Set(rule.members || []);
        boxes.forEach(cb => cb.checked = members.has(cb.value));
        $('ruleAddBtn').textContent = 'Oppdater regel';
        $('ruleCancelBtn').classList.remove('hidden');
    } else {
        editingRuleId = null;
        boxes.forEach(cb => cb.checked = false);
        $('ruleAddBtn').textContent = 'Legg til';
        $('ruleCancelBtn').classList.add('hidden');
    }
    updateRuleTypeUI();
}
function startEditRule(id) {
    const rule = state.rules.find(r => r.id === id);
    if (!rule) return;
    setRuleEditMode(rule);
    renderRulesList();
    $('ruleMembers').scrollIntoView({ block: 'nearest' });
}
function fillStudentSelect(sel) {
    sel.innerHTML = '';
    state.students.forEach(s => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name; sel.appendChild(o); });
}
function fillMemberPicker() {
    const box = $('ruleMembers');
    box.innerHTML = '';
    state.students.forEach(s => {
        const lbl = document.createElement('label');
        lbl.className = 'member-chip';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = s.id;
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(' ' + s.name));
        box.appendChild(lbl);
    });
}
/* the hint adapts to the rule type — apart = away from all, together = next to one */
function updateRuleTypeUI() {
    const apart = $('ruleType').value === 'apart';
    $('ruleAnyHint').innerHTML = apart
        ? 'Velg en elev og kryss av hvem den skal sitte <strong>unna</strong> (alle avkryssede).'
        : 'Velg en elev og kryss av mulige naboer. Flere avkryssede = ved siden av <strong>én av</strong> dem.';
}
function renderRulesList() {
    const list = $('rulesList');
    list.innerHTML = '';
    if (!state.rules.length) { list.innerHTML = '<div class="empty-line">Ingen regler enda.</div>'; return; }
    // hard (Må) rules first so the important ones read at the top
    const ordered = state.rules.map((r, i) => ({ r, i }))
        .sort((x, y) => (((normStrength(y.r.strength) || 'must') === 'must') - ((normStrength(x.r.strength) || 'must') === 'must')));
    ordered.forEach(({ r, i }) => {
        const a = studentById(r.a);
        if (!a) return;
        const names = (r.members || []).map(id => studentById(id)).filter(Boolean).map(s => `<strong>${escapeHtml(s.name)}</strong>`);
        if (!names.length) return;
        const st = normStrength(r.strength) || 'must';
        const chip = `<span class="rule-chip ${st}">${st === 'must' ? 'Må' : 'Bør'}</span>`;
        const icon = r.type === 'apart' ? '🚫' : '🤝';
        // together with several members = "next to one of"; apart = away from all
        const phrase = r.type === 'apart' ? 'ikke ved siden av'
            : (names.length > 1 ? 'ved siden av én av' : 'ved siden av');
        const text = `${chip} ${icon} <strong>${escapeHtml(a.name)}</strong> – ${phrase}: ${names.join(', ')}`;
        const row = document.createElement('div');
        row.className = 'rule-row' + (r.id === editingRuleId ? ' editing' : '');
        row.innerHTML = `<span class="rule-text">${text}</span>`;
        const actions = document.createElement('div');
        actions.className = 'rule-actions';
        const edit = document.createElement('button');
        edit.className = 'rule-edit'; edit.textContent = '✎'; edit.title = 'Rediger regel';
        edit.addEventListener('click', () => startEditRule(r.id));
        const del = document.createElement('button');
        del.className = 'rule-del'; del.textContent = '✕'; del.title = 'Slett regel';
        del.addEventListener('click', () => {
            if (r.id === editingRuleId) setRuleEditMode(null);
            state.rules.splice(i, 1); save(); renderRulesList();
        });
        actions.appendChild(edit); actions.appendChild(del);
        row.appendChild(actions);
        list.appendChild(row);
    });
}

/* -- roster modal -- */
let rosterWork = null;
function openStudentsModal() {
    rosterWork = state.students.map(s => ({ id: s.id, name: s.name, gender: s.gender, front: s.front, back: s.back, quiet: !!s.quiet, wishWith: (s.wishWith || []).slice(), wishAvoid: (s.wishAvoid || []).slice(), tags: s.tags.slice() }));
    renderRoster();
    $('rosterAdd').value = '';
    openModal('studentsModal');
}
function renderRoster() {
    const box = $('roster');
    box.innerHTML = '';
    rosterWork.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'roster-row';
        row.innerHTML = `
            <input class="r-name" type="text" value="${escapeHtml(s.name)}">
            <div class="r-gender" role="group">
                <button type="button" data-g="G" class="${s.gender === 'G' ? 'on' : ''}">G</button>
                <button type="button" data-g="J" class="${s.gender === 'J' ? 'on' : ''}">J</button>
                <button type="button" data-g="" class="${!s.gender ? 'on' : ''}">–</button>
            </div>
            <select class="r-place" title="Plassering i rommet">
                <option value="">Fri plass</option>
                <option value="front-should" ${s.front === 'should' ? 'selected' : ''}>Bør foran</option>
                <option value="front-must" ${s.front === 'must' ? 'selected' : ''}>Må foran</option>
                <option value="back-should" ${s.back === 'should' ? 'selected' : ''}>Bør bak</option>
                <option value="back-must" ${s.back === 'must' ? 'selected' : ''}>Må bak</option>
            </select>
            <button type="button" class="r-pref" title="Elevpreferanser">⚙︎${prefSummary(s) ? `<span class="r-pref-badge">${prefSummary(s)}</span>` : ''}</button>
            <button type="button" class="r-del">✕</button>`;
        row.querySelector('.r-pref').addEventListener('click', () => openStudentPref(i));
        row.querySelector('.r-name').addEventListener('input', e => s.name = e.target.value);
        row.querySelectorAll('.r-gender button').forEach(btn => btn.addEventListener('click', () => {
            s.gender = btn.dataset.g || null;
            row.querySelectorAll('.r-gender button').forEach(b => b.classList.remove('on'));
            btn.classList.add('on');
        }));
        row.querySelector('.r-place').addEventListener('change', e => {
            const v = e.target.value; // '' | 'front-should' | 'front-must' | 'back-should' | 'back-must'
            s.front = v.startsWith('front-') ? v.slice(6) : null;
            s.back = v.startsWith('back-') ? v.slice(5) : null;
        });
        row.querySelector('.r-del').addEventListener('click', () => { rosterWork.splice(i, 1); renderRoster(); });
        box.appendChild(row);
    });
}
function saveRoster() {
    const names = rosterWork.map(s => (s.name || '').trim()).filter(Boolean);
    if (!names.length) { toast('Listen kan ikke være tom', 'err'); return; }
    // commit working copy back to real students, preserving ids
    state.students = rosterWork.filter(s => (s.name || '').trim()).map(s => normStudent({ id: s.id, name: s.name.trim(), gender: s.gender, front: s.front, back: s.back, quiet: s.quiet, wishWith: s.wishWith, wishAvoid: s.wishAvoid, tags: s.tags }));
    pruneInvalid();
    // auto mode keeps desks == roster; custom mode leaves the fixed arrangement
    // untouched (surplus students fall back to the pool, empty desks remain).
    if (state.roomMode !== 'custom' && state.seats.length !== state.students.length) regenSeatsPreserve();
    save(); render();
    closeModal('studentsModal');
    toast('Elevliste oppdatert', 'ok');
}

/* -- per-student preferences (edits the rosterWork copy; committed by saveRoster) -- */
let prefEditIndex = -1;
function prefSummary(s) {
    const n = (s.wishWith || []).length + (s.wishAvoid || []).length + (s.quiet ? 1 : 0);
    return n || 0;
}
function fillPrefPicker(box, arr, selfId) {
    box.innerHTML = '';
    rosterWork.forEach(o => {
        if (o.id === selfId || !(o.name || '').trim()) return;
        const lbl = document.createElement('label'); lbl.className = 'member-chip';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = arr.indexOf(o.id) !== -1;
        cb.addEventListener('change', () => {
            const i = arr.indexOf(o.id);
            if (cb.checked && i === -1) arr.push(o.id);
            else if (!cb.checked && i !== -1) arr.splice(i, 1);
        });
        lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' ' + o.name));
        box.appendChild(lbl);
    });
    if (!box.children.length) box.innerHTML = '<p class="modal-hint">Legg til flere elever først.</p>';
}
function renderPrefTags(s) {
    const box = $('prefTags'); box.innerHTML = '';
    (s.tags || []).forEach((t, i) => {
        const chip = document.createElement('span'); chip.className = 'tag-chip';
        chip.appendChild(document.createTextNode(t));
        const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕';
        x.addEventListener('click', () => { s.tags.splice(i, 1); renderPrefTags(s); });
        chip.appendChild(x); box.appendChild(chip);
    });
    if (!(s.tags || []).length) box.innerHTML = '<span class="modal-hint">Ingen merkelapper.</span>';
}
function addPrefTag() {
    if (prefEditIndex < 0) return;
    const s = rosterWork[prefEditIndex]; s.tags = s.tags || [];
    const v = $('prefTagInput').value.trim();
    if (v && s.tags.indexOf(v) === -1) s.tags.push(v);
    $('prefTagInput').value = '';
    renderPrefTags(s);
}
function openStudentPref(i) {
    prefEditIndex = i;
    const s = rosterWork[i];
    s.wishWith = s.wishWith || []; s.wishAvoid = s.wishAvoid || []; s.tags = s.tags || [];
    $('prefTitle').textContent = 'Preferanser – ' + (s.name || 'elev');
    $('prefQuiet').checked = !!s.quiet;
    $('prefTagInput').value = '';
    fillPrefPicker($('prefWith'), s.wishWith, s.id);
    fillPrefPicker($('prefAvoid'), s.wishAvoid, s.id);
    renderPrefTags(s);
    openModal('studentPrefModal');
}
function closeStudentPref() {
    if (prefEditIndex >= 0) { const s = rosterWork[prefEditIndex]; if (s) s.quiet = $('prefQuiet').checked; }
    closeModal('studentPrefModal');
    renderRoster();
    prefEditIndex = -1;
}

/* -- room modal -- */
let roomChoice = null;
function openRoomModal() {
    roomChoice = state.room;
    document.querySelectorAll('#roomPresetList .preset').forEach(p => p.classList.toggle('is-active', p.dataset.preset === state.room));
    $('roomKeepSeats').checked = false;
    const p = state.roomParams || {};
    const custom = state.roomMode === 'custom';
    $('roomRows').value = custom && p.rows ? p.rows : '';
    $('roomPerRow').value = custom && p.perRow ? p.perRow : '';
    $('roomGapY').value = p.gapY != null ? p.gapY : '';
    $('roomGapX').value = p.gapX != null ? p.gapX : '';
    updateRoomConfigUI();
    renderRoomTemplates();
    openModal('roomModal');
}
function updateRoomConfigUI() {
    const isU = roomChoice === 'u';
    const lbl = roomChoice === 'pairs' ? 'Par per rad'
        : roomChoice === 'pods' ? 'Grupper per rad' : 'Pulter per rad';
    $('roomPerRowLabel').textContent = lbl;
    $('roomConfig').classList.toggle('is-disabled', isU);
    $('roomUHint').classList.toggle('hidden', !isU);
    if (isU) { $('roomRows').value = ''; $('roomPerRow').value = ''; }
}

/* ---- saved room arrangements (shared across classes, stored on the store) -- */
function ensureTemplates() { if (store && !store.roomTemplates) store.roomTemplates = []; }
function normalizeSeatList(seats) {
    const out = seats.map(s => s.chair ? { x: s.x, y: s.y, chair: s.chair } : { x: s.x, y: s.y });
    if (out.length) {
        const mnX = Math.min(...out.map(s => s.x)), mnY = Math.min(...out.map(s => s.y));
        out.forEach(s => { s.x -= mnX; s.y -= mnY; });
    }
    return out;
}
function saveRoomTemplate() {
    if (!state.seats.length) { toast('Ingen pulter å lagre', 'err'); return; }
    const name = (prompt('Navn på oppsettet:', state.name + ' – ' + state.seats.length + ' pulter') || '').trim();
    if (!name) return;
    ensureTemplates();
    store.roomTemplates.push({ id: uid(), name, count: state.seats.length, seats: normalizeSeatList(state.seats) });
    save();
    renderRoomTemplates();
    toast(`Oppsett «${name}» lagret`, 'ok');
}
function applyRoomTemplate(id) {
    ensureTemplates();
    const t = store.roomTemplates.find(x => x.id === id);
    if (!t) return;
    pushUndo();
    const order = state.students.map(s => s.id);
    state.seats = (t.seats || []).map((s, i) => s.chair ? { id: 'seat' + i, x: s.x, y: s.y, chair: s.chair } : { id: 'seat' + i, x: s.x, y: s.y });
    state.roomMode = 'custom';
    state.assign = {};
    state.locked = [];
    fillSeats(order);
    save(); render();
    toast(`Oppsett «${t.name}» tatt i bruk`, 'ok');
}
function deleteRoomTemplate(id) {
    ensureTemplates();
    const t = store.roomTemplates.find(x => x.id === id);
    if (t && !confirm(`Slette oppsettet «${t.name}»?`)) return;
    store.roomTemplates = store.roomTemplates.filter(x => x.id !== id);
    save(); renderRoomTemplates();
}
function renderRoomTemplates() {
    ensureTemplates();
    const box = $('roomTplList');
    if (!box) return;
    box.innerHTML = '';
    if (!store.roomTemplates.length) { box.innerHTML = '<div class="empty-line">Ingen lagrede oppsett enda.</div>'; return; }
    store.roomTemplates.forEach(t => {
        const row = document.createElement('div');
        row.className = 'rt-row';
        const n = t.count != null ? t.count : (t.seats ? t.seats.length : 0);
        row.innerHTML = `<span><strong>${escapeHtml(t.name)}</strong> <span class="h-meta">${n} pulter</span></span>`;
        const actions = document.createElement('div');
        actions.className = 'rt-actions';
        const use = document.createElement('button'); use.className = 'btn'; use.textContent = 'Bruk';
        use.addEventListener('click', () => { applyRoomTemplate(t.id); closeModal('roomModal'); });
        const del = document.createElement('button'); del.className = 'rule-del'; del.textContent = '✕';
        del.addEventListener('click', () => deleteRoomTemplate(t.id));
        actions.appendChild(use); actions.appendChild(del);
        row.appendChild(actions);
        box.appendChild(row);
    });
}

/* -- history modal -- */
function openHistoryModal() { renderHistory(); openModal('historyModal'); }
/* 1–5 rating control; clicking the current value clears it */
function ratingDots(h, key, cls) {
    const wrap = document.createElement('div');
    wrap.className = 'rate' + (cls ? ' ' + cls : '');
    const cur = (h.rating && h.rating[key]) || 0;
    for (let v = 1; v <= 5; v++) {
        const b = document.createElement('button'); b.type = 'button';
        b.className = v <= cur ? 'on' : ''; b.title = v + '/5';
        b.addEventListener('click', () => {
            h.rating = h.rating || {};
            h.rating[key] = h.rating[key] === v ? null : v;
            save(); renderHistory();
        });
        wrap.appendChild(b);
    }
    return wrap;
}
function renderHistory() {
    const box = $('historyList');
    box.innerHTML = '';
    if (!state.history.length) { box.innerHTML = '<div class="empty-line">Ingen lagrede kart enda.</div>'; return; }
    state.history.forEach((h, i) => {
        const row = document.createElement('div');
        row.className = 'history-row hist-card';
        const placed = Object.keys(h.assign || {}).length;
        const top = document.createElement('div');
        top.className = 'hist-top';
        top.innerHTML = `<span><strong>${escapeHtml(h.label || ('Kart ' + (i + 1)))}</strong><br><span class="h-meta">${escapeHtml(h.dateStr || '')} · ${placed} plassert</span></span>`;
        const actions = document.createElement('div');
        actions.className = 'history-actions';
        const restore = document.createElement('button'); restore.className = 'btn'; restore.textContent = 'Gjenopprett';
        restore.addEventListener('click', () => { restoreHistory(i); closeModal('historyModal'); });
        const del = document.createElement('button'); del.className = 'rule-del'; del.textContent = '✕';
        del.addEventListener('click', () => { state.history.splice(i, 1); save(); renderHistory(); });
        actions.appendChild(restore); actions.appendChild(del);
        top.appendChild(actions);
        row.appendChild(top);

        const rm = document.createElement('div'); rm.className = 'rating-row';
        rm.innerHTML = '<span class="rr-label">🌱 Miljø</span>'; rm.appendChild(ratingDots(h, 'climate'));
        const rw = document.createElement('div'); rw.className = 'rating-row';
        rw.innerHTML = '<span class="rr-label">🎯 Arbeid</span>'; rw.appendChild(ratingDots(h, 'work', 'work'));
        row.appendChild(rm); row.appendChild(rw);

        const note = document.createElement('input');
        note.type = 'text'; note.className = 'h-note';
        note.placeholder = 'Notat (valgfritt) – hvordan fungerte dette kartet?';
        note.value = (h.rating && h.rating.note) || '';
        note.addEventListener('change', () => { h.rating = h.rating || {}; h.rating.note = note.value.trim(); save(); });
        row.appendChild(note);

        box.appendChild(row);
    });
}
function saveHistory() {
    const dateStr = new Date().toLocaleString('no-NO', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    state.history.unshift({
        id: uid(),
        ts: Date.now(),
        label: 'Lagret ' + new Date().toLocaleDateString('no-NO', { day: 'numeric', month: 'short' }),
        dateStr,
        room: state.room,
        seats: state.seats.map(s => ({ id: s.id, x: s.x, y: s.y })),
        assign: Object.assign({}, state.assign)
    });
    if (state.history.length > 30) state.history.length = 30;
    save(); renderHistory();
    toast('Kart lagret i historikk', 'ok');
}
function restoreHistory(i) {
    const h = state.history[i];
    if (!h) return;
    state.room = h.room || state.room;
    state.seats = (h.seats || []).map(s => ({ id: s.id, x: s.x, y: s.y }));
    state.assign = Object.assign({}, h.assign);
    pruneInvalid();
    save(); render();
    toast('Kart gjenopprettet', 'ok');
}

/* ----------------------------------------------------------- statistics     */
/* Phase 1: derived from saved history only (saving is required). Adjacency
 * (deskmates) and co-group (same cluster) are tallied separately. Display is
 * restricted to the current roster. Research basis: docs/research.md. */
let statsData = null, statsMatrixMode = 'adj', statsAimId = null;

const STAT_PALETTE = [
    { bg: '#4f46e5', fg: '#fff' }, { bg: '#0ea5e9', fg: '#fff' }, { bg: '#16a34a', fg: '#fff' },
    { bg: '#f59e0b', fg: '#3b2600' }, { bg: '#e11d48', fg: '#fff' }, { bg: '#7c3aed', fg: '#fff' },
    { bg: '#0d9488', fg: '#fff' }, { bg: '#db2777', fg: '#fff' }
];
function hashCode(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; } return Math.abs(h); }
function avatarColor(id) { return STAT_PALETTE[hashCode(String(id)) % STAT_PALETTE.length]; }
function avatarHtml(stu) {
    const c = avatarColor(stu.id), init = (stu.name.trim()[0] || '?').toUpperCase();
    return `<span class="avatar" style="background:${c.bg};color:${c.fg}">${escapeHtml(init)}</span>`;
}
function genderById(id) { const s = studentById(id); return s ? s.gender : null; }

/* connected components over tight (within-group) orthogonal edges */
function clustersOf(seats) {
    const n = seats.length, parent = seats.map((_, i) => i);
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = seats[i], b = seats[j], dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
        const h = dy <= SEAT_H * 0.5 && dx > SEAT_W * 0.5 && dx - SEAT_W <= ADJ_TIGHT_H;
        const v = dx <= SEAT_W * 0.5 && dy > SEAT_H * 0.5 && dy - SEAT_H <= ADJ_TIGHT_V;
        if (h || v) parent[find(i)] = find(j);
    }
    const groups = {}; seats.forEach((s, i) => { const r = find(i); (groups[r] || (groups[r] = [])).push(s.id); });
    return Object.values(groups).filter(g => g.length > 1);
}

function computeStats() {
    const students = state.students, n = students.length;
    const idset = new Set(students.map(s => s.id));
    const charts = [...state.history].reverse(); // oldest -> newest
    const adjCount = new Map(), coCount = new Map();
    const adjReach = {}, coReach = {}, frontCount = {}, backCount = {};
    students.forEach(s => { adjReach[s.id] = new Set(); coReach[s.id] = new Set(); frontCount[s.id] = 0; backCount[s.id] = 0; });
    let mixedAdj = 0, sameAdj = 0;
    const coverageSeries = [], seenAdj = new Set();
    let sumC = 0, nC = 0, sumW = 0, nW = 0; const cSeries = [], wSeries = [];
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    charts.forEach(h => {
        const r = h.rating;
        if (r) {
            if (r.climate) { sumC += r.climate; nC++; cSeries.push(r.climate); }
            if (r.work) { sumW += r.work; nW++; wSeries.push(r.work); }
        }
        const seats = h.seats || [], assign = h.assign || {};
        if (!seats.length) return;
        computeAdjacency(seats, h.room).edges.forEach(([s1, s2]) => {
            const a = assign[s1], b = assign[s2]; if (!a || !b) return;
            const k = pairKey(a, b); bump(adjCount, k);
            if (adjReach[a]) adjReach[a].add(b); if (adjReach[b]) adjReach[b].add(a);
            const ga = genderById(a), gb = genderById(b); if (ga && gb) { ga === gb ? sameAdj++ : mixedAdj++; }
            if (idset.has(a) && idset.has(b)) seenAdj.add(k);
        });
        clustersOf(seats).forEach(cl => {
            const ids = cl.map(sid => assign[sid]).filter(Boolean);
            for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
                bump(coCount, pairKey(ids[i], ids[j]));
                if (coReach[ids[i]]) coReach[ids[i]].add(ids[j]); if (coReach[ids[j]]) coReach[ids[j]].add(ids[i]);
            }
        });
        const ys = seats.map(s => s.y), minY = Math.min(...ys), maxY = Math.max(...ys), band = (SEAT_H + RGAP) * 1.2;
        seats.forEach(s => { const sid = assign[s.id]; if (sid === undefined || frontCount[sid] === undefined) return; if (s.y <= minY + band) frontCount[sid]++; if (s.y >= maxY - band) backCount[sid]++; });
        coverageSeries.push(seenAdj.size);
    });
    return {
        n, charts: charts.length, students, idset, adjCount, coCount, adjReach, coReach,
        frontCount, backCount, mixedAdj, sameAdj, coverageSeries,
        possible: n > 1 ? n * (n - 1) / 2 : 0, distinctAdj: seenAdj.size,
        avgClimate: nC ? sumC / nC : null, climateN: nC, avgWork: nW ? sumW / nW : null, workN: nW,
        cSeries, wSeries
    };
}

/* small derived queries */
function combinedCount(st, k) { return (st.adjCount.get(k) || 0) + (st.coCount.get(k) || 0); }
function reachOf(st, id) { return st.adjReach[id] ? st.adjReach[id].size : 0; }
function isolatesOf(st) {
    const thr = Math.max(1, Math.round((st.n - 1) * 0.25));
    return st.students.map(s => ({ s, r: reachOf(st, s.id) })).filter(x => x.r < thr).sort((a, b) => a.r - b.r);
}
function neverTogetherOf(st) {
    const out = []; const ss = st.students;
    for (let i = 0; i < ss.length; i++) for (let j = i + 1; j < ss.length; j++)
        if (combinedCount(st, pairKey(ss[i].id, ss[j].id)) === 0) out.push([ss[i], ss[j]]);
    return out;
}
function mostPairedOf(st) {
    let best = null, bc = 0;
    const ss = st.students;
    for (let i = 0; i < ss.length; i++) for (let j = i + 1; j < ss.length; j++) {
        const c = combinedCount(st, pairKey(ss[i].id, ss[j].id)); if (c > bc) { bc = c; best = [ss[i], ss[j]]; }
    }
    return best ? { pair: best, count: bc } : null;
}
function neverFrontOf(st) { return st.students.filter(s => st.frontCount[s.id] === 0); }
function tagSpreadNow() {
    if (!state.students.some(s => (s.tags || []).length)) return null;
    let excess = 0;
    clustersOf(state.seats).forEach(cl => {
        const counts = {};
        cl.forEach(seatId => { const sid = state.assign[seatId]; if (!sid) return; ((studentById(sid) || {}).tags || []).forEach(t => counts[t] = (counts[t] || 0) + 1); });
        for (const t in counts) if (counts[t] > 1) excess += counts[t] - 1;
    });
    return { excess };
}
function wishesHonoredNow() {
    const pairs = []; state.students.forEach(s => (s.wishWith || []).forEach(w => pairs.push(pairKey(s.id, w))));
    if (!pairs.length) return { ok: 0, total: 0 };
    const adjset = new Set();
    computeAdjacency(state.seats).edges.forEach(([s1, s2]) => { const a = state.assign[s1], b = state.assign[s2]; if (a && b) adjset.add(pairKey(a, b)); });
    let ok = 0; pairs.forEach(k => { if (adjset.has(k)) ok++; });
    return { ok, total: pairs.length };
}
function currentRuleAdherence() {
    if (!state.rules.length) return { ok: 0, total: 0 };
    const ctx = buildContext();
    const seatOf = {}; for (const seatId in state.assign) seatOf[state.assign[seatId]] = seatId;
    const adjacentNow = new Set();
    ctx.edges.forEach(([s1, s2]) => { const a = state.assign[s1], b = state.assign[s2]; if (a && b) adjacentNow.add(pairKey(a, b)); });
    let ok = 0, total = 0;
    ctx.apart.forEach((st, k) => { total++; if (!adjacentNow.has(k)) ok++; });
    ctx.together.forEach(t => { total++; const sa = seatOf[t.a]; if (sa && ctx.adj[sa].some(nb => t.members.has(state.assign[nb]))) ok++; });
    return { ok, total };
}

/* ---- render helpers ---- */
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
function clampPct(x) { return Math.max(0, Math.min(100, x)); }
function ratingCls(v) { return v == null ? '' : v >= 4 ? 'good' : v >= 2.5 ? 'warn' : 'bad'; }
function dualSparkHtml(a, b, max) {
    const W = 600, H = 60;
    const path = (series, color) => {
        if (series.length < 2) return '';
        const pts = series.map((v, i) => [i / (series.length - 1) * W, H - (v / max) * (H - 8) - 4]);
        const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5"></path>` +
            pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="${color}"></circle>`).join('');
    };
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${path(a, 'var(--ok)')}${path(b, '#0ea5e9')}</svg>`;
}
function meterHtml(p, cls) { return `<div class="meter"><div class="meter-fill ${cls || ''}" style="width:${clampPct(p)}%"></div></div>`; }
function indHtml(o) {
    const vcls = o.valCls ? ' ' + o.valCls : '';
    return `<div class="ind"><div class="ind-top"><span class="ind-label">${o.label}</span>` +
        (o.future ? `<span class="pill-future">${o.future}</span>` : `<span class="ind-val${vcls}">${o.val}</span>`) +
        `</div>${o.pct != null ? meterHtml(o.pct, o.meterCls) : ''}` +
        (o.note ? `<p class="ind-note">${o.note}</p>` : '') + `</div>`;
}

/* ---- panes ---- */
function openStatsModal() {
    statsData = computeStats();
    statsMatrixMode = 'adj';
    statsAimId = STAT_AIMS[0].id;
    renderStatsOverview(statsData);
    renderStatsPatterns(statsData);
    renderStatsAims(statsData);
    setStatsTab('overview');
    openModal('statsModal');
}
function setStatsTab(name) {
    document.querySelectorAll('#statsTabs .stats-tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === name));
    const map = { overview: 'statsOverview', patterns: 'statsPatterns', aims: 'statsAims' };
    for (const key in map) {
        const el = $(map[key]), on = key === name;
        el.classList.toggle('hidden', !on);
        el.classList.toggle('is-active', on);
        if (on) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; } // restart stagger
    }
}

function renderStatsOverview(st) {
    const box = $('statsOverview');
    if (!st.charts) {
        box.innerHTML = `<div class="stats-empty">Ingen lagrede kart enda.<br><strong>Lagre kart i historikken</strong> for å bygge opp statistikk over hvem som har samarbeidet.</div>`;
        return;
    }
    const cov = pct(st.distinctAdj, st.possible);
    const iso = isolatesOf(st);
    const isoNote = iso.length ? 'Lavest: ' + iso.slice(0, 3).map(x => `${escapeHtml(x.s.name)} (${x.r})`).join(', ') : 'Alle har god bredde i hvem de samarbeider med.';
    const totG = st.mixedAdj + st.sameAdj, mix = pct(st.mixedAdj, totG);
    const nf = neverFrontOf(st);
    const ra = currentRuleAdherence();
    const wh = wishesHonoredNow();
    const tg = tagSpreadNow();

    const climate = `<div class="q-card"><h3>🌱 Er klasserommet et godt sted å være?</h3>
        <p class="q-sub">Tilhørighet, inkludering og at alle samarbeider bredt.</p>
        ${indHtml({ label: 'Samarbeidsbredde', val: cov + '%', valCls: cov >= 60 ? 'good' : cov >= 30 ? 'warn' : 'bad', pct: cov, meterCls: cov >= 60 ? 'good' : cov >= 30 ? 'warn' : 'bad', note: `${st.distinctAdj} av ${st.possible} mulige par har sittet sammen.` })}
        ${indHtml({ label: 'Elever i fare for isolasjon', val: iso.length, valCls: iso.length ? 'bad' : 'good', note: isoNote })}
        ${indHtml({ label: 'Lærervurdering: miljø', val: st.climateN ? st.avgClimate.toFixed(1) + '/5' : '—', valCls: ratingCls(st.avgClimate), pct: st.climateN ? st.avgClimate / 5 * 100 : 0, meterCls: ratingCls(st.avgClimate), note: st.climateN ? `Snitt av ${st.climateN} vurderte kart.` : 'Vurder kart i Historikk for å fylle dette.' })}
        ${wh.total ? indHtml({ label: 'Ønsker oppfylt nå', val: `${wh.ok}/${wh.total}`, valCls: wh.ok === wh.total ? 'good' : 'warn', pct: pct(wh.ok, wh.total), meterCls: wh.ok === wh.total ? 'good' : 'warn', note: 'Elever som sitter ved en de ønsket (gjeldende kart).' }) : ''}
    </div>`;
    const work = `<div class="q-card work"><h3>🎯 Får vi faktisk gjort arbeid?</h3>
        <p class="q-sub">Engasjement, rettferdig plassering og at reglene holder.</p>
        ${indHtml({ label: 'Aldri sittet foran', val: nf.length, valCls: nf.length ? 'warn' : 'good', note: nf.length ? nf.slice(0, 4).map(s => escapeHtml(s.name)).join(', ') + (nf.length > 4 ? ' …' : '') : 'Tilgangen til de fremre plassene er spredt.' })}
        ${indHtml({ label: 'Kjønnsblanding ved pulter', val: totG ? mix + '%' : '—', pct: totG ? mix : 0, note: totG ? 'Andel nabopar på tvers av kjønn.' : 'Sett kjønn på elevene for å måle dette.' })}
        ${tg ? indHtml({ label: 'Merkelapp-klumping', val: tg.excess, valCls: tg.excess ? 'warn' : 'good', note: tg.excess ? 'Samme merkelapp i samme gruppe – slå på «Spre merkelapper» og kjør smart plassering.' : 'Merkelapper er godt spredd mellom gruppene.' }) : ''}
        ${indHtml({ label: 'Lærervurdering: arbeid', val: st.workN ? st.avgWork.toFixed(1) + '/5' : '—', valCls: ratingCls(st.avgWork), pct: st.workN ? st.avgWork / 5 * 100 : 0, meterCls: ratingCls(st.avgWork), note: st.workN ? `Snitt av ${st.workN} vurderte kart.` : 'Vurder kart i Historikk for å fylle dette.' })}
        ${ra.total ? indHtml({ label: 'Regler oppfylt nå', val: `${ra.ok}/${ra.total}`, valCls: ra.ok === ra.total ? 'good' : 'warn', pct: pct(ra.ok, ra.total), meterCls: ra.ok === ra.total ? 'good' : 'warn', note: 'Gjeldende kart mot «Må/Bør»-reglene.' }) : indHtml({ label: 'Regler oppfylt nå', val: '—', note: 'Ingen regler satt enda.' })}
    </div>`;
    box.innerHTML = `<div class="q-grid">${climate}${work}</div>
        <p class="modal-hint" style="margin-top:16px">Bygget på ${st.charts} lagrede kart. Mer data = sikrere tall. Forskningsgrunnlag i <strong>docs/research.md</strong>.</p>`;
}

function heatmapHtml(st, mode) {
    const ss = [...st.students].sort((a, b) => a.name.localeCompare(b.name, 'nb'));
    const n = ss.length;
    if (!n) return '';
    const get = (a, b) => mode === 'co' ? (st.coCount.get(pairKey(a, b)) || 0) : mode === 'both' ? combinedCount(st, pairKey(a, b)) : (st.adjCount.get(pairKey(a, b)) || 0);
    let max = 1;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) max = Math.max(max, get(ss[i].id, ss[j].id));
    let html = `<div class="hm" style="grid-template-columns:minmax(96px,auto) repeat(${n},22px)">`;
    html += `<div class="hm-corner"></div>`;
    ss.forEach(s => { html += `<div class="hm-clabel">${escapeHtml(s.name)}</div>`; });
    ss.forEach((row, i) => {
        html += `<div class="hm-rlabel">${escapeHtml(row.name)}</div>`;
        ss.forEach((col, j) => {
            if (i === j) { html += `<div class="hm-cell hm-diag"></div>`; return; }
            const c = get(row.id, col.id);
            const a = c ? (0.15 + 0.85 * (c / max)) : 0;
            const bg = c ? `rgba(79,70,229,${a.toFixed(3)})` : 'var(--bg)';
            html += `<div class="hm-cell" style="background:${bg}" title="${escapeHtml(row.name)} &amp; ${escapeHtml(col.name)} — ${c}×"></div>`;
        });
    });
    return html + `</div>`;
}

function relGraphHtml(st) {
    const ss = st.students, n = ss.length;
    if (n < 2) return '<p class="ind-note">Trenger minst to elever.</p>';
    const S = 520, c = S / 2, R = S / 2 - 46, nodeR = 13;
    const pos = ss.map((s, i) => { const ang = -Math.PI / 2 + i * 2 * Math.PI / n; return { s, x: c + R * Math.cos(ang), y: c + R * Math.sin(ang) }; });
    let max = 1;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) max = Math.max(max, st.adjCount.get(pairKey(ss[i].id, ss[j].id)) || 0);
    let edges = '';
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const cnt = st.adjCount.get(pairKey(ss[i].id, ss[j].id)) || 0; if (!cnt) continue;
        const o = (0.1 + 0.55 * (cnt / max)).toFixed(3), w = (0.8 + 2.6 * (cnt / max)).toFixed(2);
        edges += `<line class="edge" x1="${pos[i].x.toFixed(1)}" y1="${pos[i].y.toFixed(1)}" x2="${pos[j].x.toFixed(1)}" y2="${pos[j].y.toFixed(1)}" stroke-opacity="${o}" stroke-width="${w}"></line>`;
    }
    let nodes = '';
    pos.forEach(p => {
        const col = avatarColor(p.s.id), init = (p.s.name.trim()[0] || '?').toUpperCase();
        nodes += `<g><title>${escapeHtml(p.s.name)}</title><circle class="node" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${nodeR}" style="fill:${col.bg};stroke:#fff;stroke-width:2"></circle>` +
            `<text class="node-label" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" style="fill:${col.fg}">${escapeHtml(init)}</text></g>`;
    });
    return `<svg class="relgraph" viewBox="0 0 ${S} ${S}" role="img" aria-label="Relasjonsgraf">${edges}${nodes}</svg>`;
}

function reachBarsHtml(st) {
    const rows = st.students.map(s => ({ s, r: reachOf(st, s.id) })).sort((a, b) => a.r - b.r);
    const denom = Math.max(1, st.n - 1);
    return rows.map(x => `<div class="bar-row"><span class="bar-name">${avatarHtml(x.s)}${escapeHtml(x.s.name)}</span>` +
        `<span class="bar-track"><span class="bar-val" style="width:${pct(x.r, denom)}%"></span></span>` +
        `<span class="bar-num">${x.r}/${denom}</span></div>`).join('');
}

function sparkHtml(series, possible) {
    if (series.length < 2) return '<p class="ind-note">Trenger flere lagrede kart for en trend.</p>';
    const W = 600, H = 56, max = possible || Math.max(...series, 1);
    const pts = series.map((v, i) => [i / (series.length - 1) * W, H - (v / max) * (H - 6) - 3]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = `M0 ${H} ` + pts.map(p => 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ') + ` L${W} ${H} Z`;
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="spk-area" d="${area}"></path><path class="spk-line" d="${line}"></path></svg>`;
}

function renderStatsPatterns(st) {
    const box = $('statsPatterns');
    if (!st.charts) { box.innerHTML = `<div class="stats-empty">Lagre noen kart først, så dukker mønstrene opp her.</div>`; return; }
    const seg = (m, lbl) => `<button data-mode="${m}" class="${statsMatrixMode === m ? 'on' : ''}">${lbl}</button>`;
    box.innerHTML =
        `<div class="viz-block"><div class="viz-head"><div><h3>Hvem har sittet sammen</h3><p>Mørkere = oftere. Diagonalen er eleven selv.</p></div>
            <div class="seg">${seg('adj', 'Naboer')}${seg('co', 'Gruppe')}${seg('both', 'Begge')}</div></div>
            <div class="hm-wrap">${heatmapHtml(st, statsMatrixMode)}</div></div>
        <div class="viz-block"><div class="viz-head"><div><h3>Relasjonsgraf</h3><p>Naboforhold over tid. Tette streker = hyppige par; elever i utkanten samarbeider smalt.</p></div></div>
            ${relGraphHtml(st)}</div>
        <div class="viz-block"><div class="viz-head"><div><h3>Sosial rekkevidde</h3><p>Antall ulike elever hver har vært nabo med (lavest først).</p></div></div>
            ${reachBarsHtml(st)}</div>
        <div class="viz-block"><div class="viz-head"><div><h3>Dekningsgrad over tid</h3><p>Hvor stor andel av alle mulige par som er realisert, kart for kart.</p></div></div>
            ${sparkHtml(st.coverageSeries, st.possible)}</div>` +
        ((st.cSeries.length >= 2 || st.wSeries.length >= 2) ?
            `<div class="viz-block"><div class="viz-head"><div><h3>Lærervurdering over tid</h3><p><span style="color:var(--ok);font-weight:700">●</span> Miljø &nbsp; <span style="color:#0ea5e9;font-weight:700">●</span> Arbeid &nbsp;(1–5, kart for kart)</p></div></div>
            ${dualSparkHtml(st.cSeries, st.wSeries, 5)}</div>` : '');
}

const STAT_AIMS = [
    {
        id: 'relations', label: '🤝 Bredere relasjoner', goal: 'Sørg for at alle samarbeider med flere – ingen blir isolert over tid.',
        tips: [
            ['Sett elever ved siden av noen de aldri har sittet med. Bredde i samarbeid styrker tilhørighet.', 'Tilhørighet – Allen m.fl.'],
            ['Følg ekstra med på elever med lav «sosial rekkevidde» – de havner ofte hos de samme.', 'Relasjonskartlegging – Harvard MCC'],
            ['Kjør «Smart plassering» jevnlig for å rotere naboer i stedet for å la vanen styre.', 'Praksis']
        ],
        callout: st => { const nt = neverTogetherOf(st); const ex = nt.slice(0, 3).map(p => `${escapeHtml(p[0].name)} & ${escapeHtml(p[1].name)}`).join(', '); return `<strong>${nt.length}</strong> par har aldri sittet sammen.${ex ? ' F.eks. ' + ex + '.' : ''}`; }
    },
    {
        id: 'focus', label: '🎯 Mindre uro, mer fokus', goal: 'Reduser forstyrrelser og hold oppmerksomheten i timen.',
        tips: [
            ['Plasser lett distraherte elever nærmere tavla og læreren.', 'Plassering & engasjement'],
            ['Hold kjente «uro-par» fra hverandre med en «Må – ikke ved siden av»-regel.', 'Klasseledelse – Korpershoek 2016'],
            ['Sosioemosjonelt rettede tiltak gir størst effekt på klassemiljøet.', 'Korpershoek 2016']
        ],
        callout: st => { const ra = currentRuleAdherence(); return ra.total ? `Gjeldende kart oppfyller <strong>${ra.ok}/${ra.total}</strong> regler.` : 'Ingen regler satt enda – lag noen i «Regler».'; }
    },
    {
        id: 'hetero', label: '🧩 Blandede grupper', goal: 'Sett sammen grupper som er faglig og sosialt blandet.',
        tips: [
            ['Heterogene grupper fremmer både læring og gode relasjoner.', 'Samarbeidslæring – Johnson & Johnson'],
            ['Unngå at den samme «klikken» alltid havner sammen – bland dem opp.', 'Samarbeidslæring']
        ],
        callout: st => { const mp = mostPairedOf(st); return mp && mp.count > 1 ? `Oftest sammen: <strong>${escapeHtml(mp.pair[0].name)} & ${escapeHtml(mp.pair[1].name)}</strong> (${mp.count}×). Vurder å bryte opp vanen.` : 'Ingen tydelige faste par enda.'; }
    },
    {
        id: 'equity', label: '⚖️ Rettferdig plassering', goal: 'Spre tilgangen til de gode plassene foran.',
        tips: [
            ['Roter hvem som sitter foran – de bakerste rekkene deltar og presterer ofte mindre.', 'Plassering & engasjement'],
            ['Bruk «Foran/bak»-ønsker bevisst, men ikke la de samme alltid sitte bakerst.', 'Praksis']
        ],
        callout: st => { const nf = neverFrontOf(st); return nf.length ? `<strong>${nf.length}</strong> elever har aldri sittet foran: ${nf.slice(0, 4).map(s => escapeHtml(s.name)).join(', ')}${nf.length > 4 ? ' …' : ''}.` : 'Tilgangen til de fremre plassene er godt spredt.'; }
    },
    {
        id: 'belonging', label: '💚 Tilhørighet & miljø', goal: 'Bygg et trygt klassemiljø der hver elev hører til.',
        tips: [
            ['Tilhørighet henger sammen med motivasjon, atferd og læring.', 'Tilhørighet – metaanalyser'],
            ['Sørg for at hver elev har minst én positiv voksenrelasjon på skolen.', 'Relasjonskartlegging – Harvard MCC'],
            ['Gode lærer–elev-relasjoner løfter både engasjement og prestasjoner.', 'Roorda m.fl. 2011']
        ],
        callout: st => { const iso = isolatesOf(st); return iso.length ? `<strong>${iso.length}</strong> elever ser ut til å samarbeide smalt – verdt å følge opp.` : 'Ingen elever peker seg ut som isolerte akkurat nå.'; }
    }
];

function renderStatsAims(st) {
    const box = $('statsAims');
    const chips = STAT_AIMS.map(a => `<button class="aim ${a.id === statsAimId ? 'is-active' : ''}" data-aim="${a.id}" type="button">${a.label}</button>`).join('');
    const aim = STAT_AIMS.find(a => a.id === statsAimId) || STAT_AIMS[0];
    const tips = aim.tips.map(([t, src]) => `<div class="tip"><div class="tip-text">${escapeHtml(t)}</div><span class="tip-src">${escapeHtml(src)}</span></div>`).join('');
    const callout = st.charts ? `<div class="callout">${aim.callout(st)}</div>` : '';
    box.innerHTML = `<div class="aim-list">${chips}</div><p class="aim-goal">${escapeHtml(aim.goal)}</p>${callout}${tips}
        <p class="modal-hint" style="margin-top:14px">Rådene er forskningsbaserte – kilder i <strong>docs/research.md</strong>.</p>`;
}

/* ------------------------------------------------------- class management   */
function renderClassDropdown() {
    const dd = $('classDropdown');
    dd.innerHTML = '';
    Object.values(store.classes).forEach(c => {
        const item = document.createElement('button');
        item.className = 'dd-item' + (c.id === store.activeClassId ? ' active' : '');
        item.textContent = c.name;
        item.addEventListener('click', () => { setActiveClass(c.id); closeAllDropdowns(); });
        dd.appendChild(item);
    });
    const sep = document.createElement('div'); sep.className = 'dd-sep'; dd.appendChild(sep);
    const add = document.createElement('button');
    add.className = 'dd-item'; add.textContent = '＋ Ny gruppe';
    add.addEventListener('click', () => { closeAllDropdowns(); showSetup(); resetSetupForm(); });
    dd.appendChild(add);
}
function resetSetupForm() {
    $('setupNames').value = '';
    $('setupCount').textContent = '0';
    $('setupClassSelect').value = '';
    $('setupGroupLabel').value = '';
}
function renameClass() {
    const name = prompt('Klassenavn:', state.name);
    if (name && name.trim()) { state.name = name.trim(); $('classMenuLabel').textContent = state.name; save(); }
}
/* Deleting the last group is allowed — it drops back to the setup screen, from
 * where a chart can be created or pulled down. Refusing left teachers stuck with
 * a group they had created only to get past that screen. */
async function deleteClass() {
    const id = store.activeClassId;
    const cls = store.classes[id];
    if (!cls) return;
    const synced = syncOn() && (kkServer[id] || Number(cls.sv || 0) > 0);

    // A local-only delete does not stick while sync is on: the server still has
    // the group, and the next pull downloads it again. Rather than let the group
    // reappear and look like a bug, require the unlock and delete both copies.
    if (synced && !syncUnlocked()) {
        toast('Lås opp synkronisering først – ellers kommer gruppa tilbake', 'err');
        openSyncModal();
        return;
    }
    const warn = synced
        ? `Slette «${cls.name}» både her og på serveren? Dette kan ikke angres.`
        : `Slette «${cls.name}»? Dette kan ikke angres.`;
    if (!confirm(warn)) return;

    if (synced) {
        try { await kkPost('kk_group_delete', { group: id }); }
        catch (e) {
            // Abort rather than delete locally: a half-delete is the resurrection
            // bug with extra steps.
            toast('Kunne ikke slette på serveren – ingenting er slettet', 'err');
            return;
        }
    }
    delete store.classes[id];
    delete kkServer[id]; delete kkCeks[id]; delete kkConflicts[id];
    const next = Object.keys(store.classes)[0];
    if (next) { setActiveClass(next); }
    else { state = null; store.activeClassId = null; saveQuiet(); showSetup(); resetSetupForm(); }
    updateSyncBadge();
    toast('Gruppe slettet', 'ok');
}

/* ------------------------------------------------------- backup / restore   */
function exportBackup() {
    const out = store;
    downloadBlob(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), 'klassekart-sikkerhetskopi.json');
    toast('Sikkerhetskopi lastet ned', 'ok');
}
function importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const s = JSON.parse(reader.result);
            if (!s || !s.classes) throw new Error('ugyldig');
            delete s.__rel;   // older backups may carry the removed relationship map; drop it
            store = s;
            for (const id in store.classes) store.classes[id] = normClass(store.classes[id]);
            store.roomTemplates = store.roomTemplates || [];
            if (!store.classes[store.activeClassId]) store.activeClassId = Object.keys(store.classes)[0];
            state = store.classes[store.activeClassId];
            save(); showApp(); render();
            toast('Sikkerhetskopi gjenopprettet', 'ok');
        } catch (e) { toast('Kunne ikke lese filen', 'err'); }
    };
    reader.readAsText(file);
}
function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

/* ------------------------------------------------------ present mode (P4)   */
function enterPresent() {
    if (editMode) exitEditMode();
    zoom = null;
    presentMode = true;
    setSelected(null);
    document.body.classList.add('present');
    $('presentBar').classList.remove('hidden');
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    requestAnimationFrame(fitBoard);
}
function exitPresent() {
    presentMode = false;
    zoom = null;
    document.body.classList.remove('present');
    $('presentBar').classList.add('hidden');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    requestAnimationFrame(fitBoard);
}

/* ------------------------------------------------------ export PDF / PNG    */
function seatingBBox() { return { w: boardW, h: boardH }; }

function drawSeatingToCanvas(scale) {
    const pad = 24, headH = 70;
    const cv = document.createElement('canvas');
    const dpr = 2;
    cv.width = (boardW * scale + pad * 2) * dpr;
    cv.height = (boardH * scale + pad * 2 + headH) * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    // background
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
    // header
    ctx.fillStyle = '#1f2233';
    ctx.font = '700 26px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(state.name, pad, 28);
    ctx.fillStyle = '#5b6072';
    ctx.font = '400 14px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText('Klassekart · ' + new Date().toLocaleDateString('no-NO', { day: 'numeric', month: 'long', year: 'numeric' }), pad, 52);
    // front bar
    const ox = pad, oy = pad + headH;
    ctx.fillStyle = '#2b2f45';
    const fw = 150, fh = 22;
    roundRect(ctx, ox + (boardW * scale - fw) / 2, oy - 30, fw, fh, 6); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '600 11px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('TAVLE / FRONT', ox + (boardW * scale) / 2, oy - 30 + fh / 2 + 1);
    ctx.textAlign = 'left';
    // chairs (behind desks) — same orientation logic as the on-screen board
    const chairDirs = seatChairDirs();
    ctx.fillStyle = '#d7dae9';
    for (const seat of state.seats) {
        const [cl, ct] = chairXY(seat, chairDirs[seat.id]);
        ctx.beginPath();
        ctx.arc(ox + (cl + CHAIR_D / 2) * scale, oy + (ct + CHAIR_D / 2) * scale, (CHAIR_D / 2) * scale, 0, Math.PI * 2);
        ctx.fill();
    }
    // seats
    for (const seat of state.seats) {
        const x = ox + seat.x * scale, y = oy + seat.y * scale, w = SEAT_W * scale, h = SEAT_H * scale;
        const sid = state.assign[seat.id];
        ctx.lineWidth = 1.5;
        if (sid) { ctx.fillStyle = '#fff'; ctx.strokeStyle = '#cfd3e6'; }
        else { ctx.fillStyle = '#f7f8fc'; ctx.strokeStyle = '#e0e3f0'; }
        roundRect(ctx, x, y, w, h, 8); ctx.fill(); ctx.stroke();
        if (sid) {
            const stu = studentById(sid);
            if (stu) {
                ctx.fillStyle = '#1f2233';
                ctx.font = '600 ' + Math.round(15 * scale) + 'px -apple-system, Segoe UI, Roboto, sans-serif';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                wrapText(ctx, stu.name, x + w / 2, y + h / 2, w - 10, 16 * scale);
                ctx.textAlign = 'left';
            }
        }
    }
    return cv;
}
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
function wrapText(ctx, text, cx, cy, maxW, lh) {
    const words = text.split(' ');
    const lines = []; let line = '';
    for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
        else line = test;
    }
    if (line) lines.push(line);
    const startY = cy - (lines.length - 1) * lh / 2;
    lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lh));
}
function exportPNG() {
    const cv = drawSeatingToCanvas(1);
    cv.toBlob(blob => { downloadBlob(blob, sanitizeName(state.name) + '.png'); toast('PNG lastet ned', 'ok'); });
}
function exportPDF() {
    if (!window.jspdf) { toast('PDF-bibliotek ikke lastet', 'err'); return; }
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = 297, pageH = 210, margin = 12, headH = 22;
    pdf.setFillColor(79, 70, 229); pdf.rect(0, 0, pageW, headH, 'F');
    pdf.setTextColor(255, 255, 255); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(16);
    pdf.text(state.name, pageW / 2, 10, { align: 'center', baseline: 'middle' });
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
    pdf.text('Klassekart · ' + new Date().toLocaleDateString('no-NO', { day: 'numeric', month: 'long', year: 'numeric' }), pageW / 2, 17, { align: 'center' });

    const availW = pageW - margin * 2, availH = pageH - headH - margin * 2 - 8;
    const scale = Math.min(availW / boardW, availH / boardH);
    const ox = (pageW - boardW * scale) / 2, oy = headH + margin + 8;
    // front bar
    pdf.setFillColor(43, 47, 69);
    pdf.roundedRect(ox + (boardW * scale - 40) / 2, oy - 7, 40, 5, 1.2, 1.2, 'F');
    pdf.setTextColor(255, 255, 255); pdf.setFontSize(6);
    pdf.text('TAVLE / FRONT', ox + boardW * scale / 2, oy - 4, { align: 'center', baseline: 'middle' });

    for (const seat of state.seats) {
        const x = ox + seat.x * scale, y = oy + seat.y * scale, w = SEAT_W * scale, h = SEAT_H * scale;
        const sid = state.assign[seat.id];
        pdf.setDrawColor(205, 209, 230); pdf.setLineWidth(0.3);
        if (sid) pdf.setFillColor(255, 255, 255); else pdf.setFillColor(247, 248, 252);
        pdf.roundedRect(x, y, w, h, 1.5, 1.5, 'FD');
        if (sid) {
            const stu = studentById(sid);
            if (stu) {
                pdf.setTextColor(31, 34, 51); pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(stu.name.length > 14 ? 8 : 10);
                pdf.text(stu.name, x + w / 2, y + h / 2, { align: 'center', baseline: 'middle', maxWidth: w - 3 });
            }
        }
    }
    pdf.save(sanitizeName(state.name) + ' ' + new Date().toISOString().split('T')[0] + '.pdf');
    toast('PDF lastet ned', 'ok');
}
function sanitizeName(n) { return (n || 'klassekart').replace(/[\/\\:*?"<>|]/g, '_').trim(); }

function printChart() {
    const cv = drawSeatingToCanvas(1);
    const data = cv.toDataURL('image/png');
    const w = window.open('', '_blank');
    if (!w) { toast('Tillat popup for utskrift', 'err'); return; }
    w.document.write('<html><head><title>' + escapeHtml(state.name) + '</title></head><body style="margin:0;text-align:center;">' +
        '<img src="' + data + '" style="max-width:100%;" onload="window.print()"></body></html>');
    w.document.close();
}

/* ---------------------------------------------------------------- main menu */
function buildMainMenu() {
    const dd = $('mainMenu');
    dd.innerHTML = '';
    // Everything a teacher reaches for during a lesson now has a home in the
    // workspace itself: export and print sit with the board, rename and delete
    // sit with the group pill they act on, and leaving is the ← in the corner.
    // What is left here is the stuff you touch once a term.
    const items = [
        [syncOn() ? (syncUnlocked() ? '☁ Synkronisering' : '🔒 Synkronisering (låst)') : '☁ Slå på synkronisering', openSyncModal],
        ['sep'],
        ['💾 Last ned sikkerhetskopi', exportBackup],
        ['📂 Gjenopprett fra fil', () => $('importFile').click()],
    ];
    items.forEach(([label, fn]) => {
        if (label === 'sep') { const s = document.createElement('div'); s.className = 'dd-sep'; dd.appendChild(s); return; }
        const b = document.createElement('button');
        b.className = 'dd-item'; b.textContent = label;
        b.addEventListener('click', () => { closeAllDropdowns(); fn(); });
        dd.appendChild(b);
    });
}

/* ---------------------------------------------------------------- wiring     */
function wireSetup() {
    const presetBtns = document.querySelectorAll('#presetList .preset');
    let chosen = 'pairs';
    presetBtns.forEach(btn => btn.addEventListener('click', () => {
        presetBtns.forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active'); chosen = btn.dataset.preset;
    }));
    const names = $('setupNames');
    const updateCount = () => { $('setupCount').textContent = parseNames(names.value).length; };
    names.addEventListener('input', updateCount); updateCount();

    // klasse (code from the school config) vs faggruppe (free text)
    let kind = 'klasse';
    document.querySelectorAll('#setupKindList .kind').forEach(btn => btn.addEventListener('click', () => {
        document.querySelectorAll('#setupKindList .kind').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        kind = btn.dataset.kind;
        $('setupClassField').classList.toggle('hidden', kind !== 'klasse');
        $('setupLabelField').classList.toggle('hidden', kind === 'klasse');
    }));

    // CSV import (Vigilo export) — read locally, never uploaded
    $('setupCsvBtn').addEventListener('click', () => $('csvFile').click());
    $('csvFile').addEventListener('change', e => { if (e.target.files[0]) csvHandleFile(e.target.files[0]); e.target.value = ''; });
    $('csvConfirmBtn').addEventListener('click', () => { if (csvRows) csvApply(csvRows, csvNameCol); });

    // sync dialog — delegated, since its body is re-rendered per state
    $('syncModal').addEventListener('click', e => {
        const b = e.target.closest('[data-syncact]');
        if (b) syncAction(b.dataset.syncact, b);
    });
    $('syncModal').addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.id === 'syncCodeInput') { e.preventDefault(); syncAction('unlock', e.target); }
    });

    // first run after moving from the standalone app: localStorage doesn't
    // cross origins, so the JSON backup is the only bridge
    $('setupImportBtn').addEventListener('click', () => $('importFile').click());
    $('setupSyncBtn').addEventListener('click', openSyncModal);
    $('setupFetchBtn').addEventListener('click', openSyncModal);

    $('setupGoBtn').addEventListener('click', () => {
        const list = parseNames(names.value);
        const label = kind === 'klasse' ? $('setupClassSelect').value : $('setupGroupLabel').value.trim();
        if (!label) {
            toast(kind === 'klasse' ? 'Velg en klasse' : 'Gi gruppa et navn', 'err');
            (kind === 'klasse' ? $('setupClassSelect') : $('setupGroupLabel')).focus();
            return;
        }
        if (!list.length) { toast('Lim inn minst ett elevnavn', 'err'); names.focus(); return; }
        startNewClass(list, chosen, label, kind);
    });
}

function wireApp() {
    $('smartBtn').addEventListener('click', () => smartArrange(false));
    $('shuffleBtn').addEventListener('click', () => shuffleSeating(false));
    $('presentBtn').addEventListener('click', enterPresent);
    $('printBtn').addEventListener('click', printChart);
    $('exportBtn').addEventListener('click', e => {
        e.stopPropagation();
        const dd = $('exportMenu');
        const opening = !dd.classList.contains('open');
        closeAllDropdowns();
        if (opening) dd.classList.add('open');
    });
    $('exportMenu').addEventListener('click', e => {
        const b = e.target.closest('[data-export]');
        if (!b) return;
        closeAllDropdowns();
        (b.dataset.export === 'png' ? exportPNG : exportPDF)();
    });

    // Regler and Elever are tabs now, not topbar buttons.
    $('kkTabs').addEventListener('click', e => {
        const t = e.target.closest('.kk-tab');
        if (t) setTab(t.dataset.tab);
    });
    $('innsiktSeg').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (b) setInnsiktSub(b.dataset.sub);
    });
    $('portalBtn').addEventListener('click', () => { location.href = 'teacher.html'; });
    $('undoBtn').addEventListener('click', undo);
    $('redoBtn').addEventListener('click', redo);
    $('renameGroupBtn').addEventListener('click', renameClass);
    $('deleteGroupBtn').addEventListener('click', () => { deleteClass(); });

    // class dropdown
    $('classMenuBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        const dd = $('classDropdown');
        const opening = !dd.classList.contains('open');
        closeAllDropdowns();
        if (opening) { renderClassDropdown(); dd.classList.add('open'); }
    });
    // main menu
    $('menuBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        const dd = $('mainMenu');
        const opening = !dd.classList.contains('open');
        closeAllDropdowns();
        if (opening) dd.classList.add('open');
    });
    document.addEventListener('click', closeAllDropdowns);

    // selection action bar
    $('selLockBtn').addEventListener('click', () => { if (selected) { toggleLock(selected); updateSelBar(); } });
    $('selPoolBtn').addEventListener('click', () => { if (selected) { unseat(selected); setSelected(null); } });

    // rules modal
    $('ruleType').addEventListener('change', updateRuleTypeUI);
    $('ruleCancelBtn').addEventListener('click', () => { setRuleEditMode(null); renderRulesList(); });
    $('ruleAddBtn').addEventListener('click', () => {
        const a = $('ruleA').value, type = $('ruleType').value;
        const strength = $('ruleStrength').value === 'should' ? 'should' : 'must';
        if (!a) { toast('Velg en elev', 'err'); return; }
        const members = [...$('ruleMembers').querySelectorAll('input:checked')].map(c => c.value).filter(id => id !== a);
        if (!members.length) { toast('Kryss av minst én elev', 'err'); return; }
        if (editingRuleId) { // editing: overwrite the rule in place
            const r = state.rules.find(x => x.id === editingRuleId);
            if (r) { r.type = type; r.a = a; r.members = members; r.strength = strength; toast('Regel oppdatert', 'ok'); }
        } else {
            // same student + type + strength → merge into one rule; else add a new one
            const existing = state.rules.find(r => r.type === type && r.a === a && (normStrength(r.strength) || 'must') === strength);
            if (existing) {
                existing.members = [...new Set([...(existing.members || []), ...members])];
                toast('Regel oppdatert', 'ok');
            } else state.rules.push({ id: uid(), type, a, members, strength });
        }
        setRuleEditMode(null);
        save(); renderRulesList();
    });
    $('prefBalanceGender').addEventListener('change', e => { state.prefs.balanceGender = e.target.checked; save(); });
    $('prefAvoidRepeat').addEventListener('change', e => { state.prefs.avoidRepeat = e.target.checked; save(); });
    $('prefAvoidAll').addEventListener('change', e => { state.prefs.avoidAllRepeat = e.target.checked; save(); });
    $('prefBalanceTags').addEventListener('change', e => { state.prefs.balanceTags = e.target.checked; save(); });
    $('rulesRunBtn').addEventListener('click', () => { closeModal('rulesModal'); smartArrange(false); });

    // roster modal
    $('rosterAddBtn').addEventListener('click', () => {
        const added = parseNames($('rosterAdd').value);
        if (!added.length) return;
        added.forEach(n => rosterWork.push({ id: uid(), name: n, gender: null, front: null, back: null, tags: [] }));
        $('rosterAdd').value = '';
        renderRoster();
    });
    $('rosterSaveBtn').addEventListener('click', saveRoster);
    // student-preferences modal
    $('prefDoneBtn').addEventListener('click', closeStudentPref);
    $('prefTagAddBtn').addEventListener('click', addPrefTag);
    $('prefTagInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addPrefTag(); } });
    $('prefCloseX').addEventListener('click', closeStudentPref);
    $('prefQuiet').addEventListener('change', () => { if (prefEditIndex >= 0 && rosterWork[prefEditIndex]) rosterWork[prefEditIndex].quiet = $('prefQuiet').checked; });

    // room modal
    document.querySelectorAll('#roomPresetList .preset').forEach(btn => btn.addEventListener('click', () => {
        document.querySelectorAll('#roomPresetList .preset').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active'); roomChoice = btn.dataset.preset;
        updateRoomConfigUI();
    }));
    $('roomApplyBtn').addEventListener('click', () => {
        const preset = roomChoice || state.room;
        const numOrNull = (v, lo, hi) => { const n = parseInt(v, 10); return isNaN(n) ? null : clamp(n, lo, hi); };
        const rows = numOrNull($('roomRows').value, 1, 20);
        const perRow = numOrNull($('roomPerRow').value, 1, 20);
        // Pass both through as entered; applyRoom decides what each one means.
        // Nulling one because the other was blank is what made "par per rad"
        // alone do nothing.
        const custom = preset !== 'u' && rows && perRow;
        const params = {
            rows, perRow,
            gapY: numOrNull($('roomGapY').value, 0, 200),
            gapX: numOrNull($('roomGapX').value, 0, 200)
        };
        applyRoom(preset, $('roomKeepSeats').checked, params);
        closeModal('roomModal');
        toast(custom ? 'Tilpasset oppsett laget' : 'Romoppsett oppdatert', 'ok');
    });

    // history modal
    $('historySaveBtn').addEventListener('click', saveHistory);

    // statistics modal
    $('statsTabs').addEventListener('click', e => { const t = e.target.closest('.stats-tab'); if (t) setStatsTab(t.dataset.tab); });
    $('statsModal').addEventListener('click', e => {
        const seg = e.target.closest('[data-mode]');
        if (seg) { statsMatrixMode = seg.dataset.mode; renderStatsPatterns(statsData); return; }
        const aim = e.target.closest('[data-aim]');
        if (aim) { statsAimId = aim.dataset.aim; renderStatsAims(statsData); }
    });

    // results modal
    $('resultsRerunBtn').addEventListener('click', () => { closeModal('resultsModal'); smartArrange(false); });

    // desk-edit mode
    // Desk editing lives on the Kart tab now — no need to leave the room panel
    // first, because you never got there from anywhere else.
    $('editDesksBtn').addEventListener('click', () => { setTab('kart'); enterEditMode(); });
    $('editDoneBtn').addEventListener('click', exitEditMode);
    $('editAlignBtn').addEventListener('click', alignAllDesks);
    $('editSaveTplBtn').addEventListener('click', saveRoomTemplate);
    $('roomSaveTplBtn').addEventListener('click', saveRoomTemplate);

    // zoom control
    $('zoomIn').addEventListener('click', () => zoomBy(1.2));
    $('zoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
    $('zoomLabel').addEventListener('click', () => setZoom(null));

    // present bar
    $('pShuffle').addEventListener('click', () => shuffleSeating(true));
    $('pSmart').addEventListener('click', () => smartArrange(true));
    $('pExit').addEventListener('click', exitPresent);

    // backup import
    $('importFile').addEventListener('change', e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });

    // generic modal closers
    document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
    document.querySelectorAll('.modal-overlay').forEach(ov => ov.addEventListener('click', e => { if (e.target === ov) closeModal(ov.id); }));

    // drag/drop + tap on the app screen
    const app = $('app');
    app.addEventListener('pointerdown', onPointerDown);
    app.addEventListener('click', onClick);

    buildMainMenu();
}

function wireGlobal() {
    window.addEventListener('resize', () => { if (state && !$('app').classList.contains('hidden')) fitBoard(); });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && presentMode) exitPresent(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPush(); });
    document.addEventListener('keydown', (e) => {
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
        if (e.key === 'Escape') {
            if (presentMode) { exitPresent(); return; }
            if (editMode) { exitEditMode(); return; }
            const open = document.querySelector('.modal-overlay.show');
            if (open) { closeModal(open.id); return; }
            closeAllDropdowns();
            if (selected) { setSelected(null); return; }
        }
        // undo / redo — work in edit mode too, but not while typing in a field
        if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[zyZY]$/.test(e.key)) {
            if (typing || $('app').classList.contains('hidden')) return;
            e.preventDefault();
            if (e.key === 'y' || e.key === 'Y' || e.shiftKey) redo(); else undo();
            return;
        }
        if (typing) return;
        if ($('app').classList.contains('hidden') || editMode) return;
        if (e.key === 'r' || e.key === 'R') shuffleSeating(false);
        else if (e.key === 's' && !(e.ctrlKey || e.metaKey)) smartArrange(false);
        else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); toast('Lagret', 'ok'); }
    });
}

/* ------------------------------------------------------------------ init    */
/* Session gate. Klassekart is a subpage of the teacher page and shares its
 * `up_session` cookie, so the check is a single ?action=me. A logged-out visitor
 * is sent to teacher.html, which owns the login screen — deliberately duplicated
 * from teacher.js:419 rather than extracted, to keep the change to that
 * 7000-line production file down to one listener.
 *
 * Note this gates the UI, not the data: everything here is localStorage, so a
 * determined local user could read it regardless. Real protection arrives with
 * the encrypted envelope in step 2. */
/* The session cookie is issued for `.ukeportalen.no`, so a page served from
 * localhost never receives it and could never pass this check — local testing
 * would be impossible. Skip the redirect there, matching the server, which
 * already allows any localhost origin (server.js isAllowedOrigin).
 *
 * Safe to ship: it cannot be reached from ukeportalen.no, and an attacker who
 * can serve pages from the victim's own localhost has already won. Note too
 * that this gate protects the UI, not the data — everything here is
 * localStorage until the encrypted envelope lands in step 2. */
const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

async function requireSession() {
    try {
        const res = await fetch(`${SCRIPT_URL}?action=me`, { credentials: 'include' });
        const data = await res.json();
        if (data && !data.error) return true;
    } catch (e) { /* offline or unreachable – treat as logged out */ }
    if (IS_LOCAL) {
        console.warn('[klassekart] No session — continuing anyway because this is localhost. This never happens on ukeportalen.no.');
        return true;
    }
    location.replace('teacher.html');
    return false;
}

async function init() {
    if (!(await requireSession())) return;
    document.body.classList.remove('kk-booting');
    $('kkOverlay').classList.remove('active');

    wireSetup(); wireApp(); wireGlobal();
    loadClassCodes();
    // Sync is opt-in and never interrupts a boot: if it is on but locked, the
    // menu label says so and the local copy works meanwhile.
    if (syncOn()) buildMainMenu();
    updateSyncBadge();
    if (loadStore()) { state = store.classes[store.activeClassId]; showApp(); render(); }
    else { showSetup(); }
    probeIdentity().then(updateSetupFetch);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
