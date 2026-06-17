# Ukeplan — Runni ungdomsskole

Et nettverktøy for ukeplanarbeid: en **elevside** (lese) og en **lærerside**
(redigere) for den ukentlige planen per klasse — tema/læringsmål, ressurser,
lekser, beskjeder og vurderinger. Bygget som søsken til `vurderingskalender`,
men i egen mappe slik at det eksisterende verktøyet står helt urørt.
Vurderinger leses fra `vurderingskalender`-backenden og flettes inn ved
lesetidspunkt.

Ingen byggesteg, pakkebehandler eller testrammeverk — ren HTML/CSS/JS.

> Denne README-en er inngangsporten. For dypere detaljer:
> - **[CLAUDE.md](CLAUDE.md)** — fullstendig teknisk referanse (datamodell,
>   endepunkter, hver fane og funksjon). Hold denne oppdatert ved endringer.
> - **[roadmap.md](roadmap.md)** — designvalg og begrunnelser.
> - **[TODO.md](TODO.md)** — gjøremålsliste (`[x]`/`[ ]`).
> - **reset_password.txt** — hvordan sette/nullstille lærerpassordet.

---

## Funksjoner (kort)

**Elevside (`index.html`)**
- Velger klasse (lagres lokalt). Faner: **Ukeplan** (Uke/Dag), **Fag**
  (fagprogresjon uke for uke) og **Vurderingskalender** (månedsrutenett).
- Uke-visning: fag-rader (Fag · Tema og læringsmål · Lekser), med ressurser som
  underoverskrift i tema-cellen og vurderinger som en stripe under fagets rad.
- Dag-visning: alt for én dag; beskjeder vises også **dagen før**, ukelekser
  vises hver dag.
- Lokal avkryssing av lekser.

**Lærerside (`teacher.html`)** — passordbeskyttet
- **Ukeplan:** redigerbart ukebrett med inline-redigering, «Kopier forrige uke»,
  bulk-klasser og utskrift.
- **Vurderinger:** tabell- og kalendervisning med filtrering via klikkbare
  kolonneoverskrifter (modal). Skriver til `vurderingskalender`-backenden.
- **Oversikt:** «Sammenlign klasser» og «Progresjon» (med `.docx`-eksport).
- **Tilpasset plan:** egen, anonym plan for elever med individuell
  tilrettelegging — se [Personvern](#personvern--tilpassede-planer).

**Felles**
- PWA (installerbar, fungerer offline på cachet skall).
- In-app dialoger (`uiAlert`/`uiConfirm`/`uiPrompt` + lenke-modal) i stedet for
  nettleserens `alert`/`confirm`/`prompt`.
- Skolerute-overlegg fra Nes kommunes iCal-feed (ferier, planleggingsdager).

---

## Arkitektur

```
Google Sheet «Planelementer» ──► ukeplan_GAS.js (Apps Script)
                                   │  GET ?action=week|public   → elevside
                                   └─ GET/POST (token)           → lærerside

vurderingskalender-backend  ──► ?action=public  → vurderinger flettes inn (lese)
                                POST (token)     → lærersiden skriver vurderinger
```

- **Frontend:** statiske filer på GitHub Pages.
- **Backend:** Google Apps Script web-app mot ett regneark.
- **Auth:** SHA-256-hash av passord i Script Properties → kortlevd UUID-token i
  `sessionStorage`. Ingen hemmelighet i frontend.
- **To kilder:** ukeplan-data fra det nye arket; vurderinger fra det gamle
  `vurderingskalender`-backenden (uendret).

---

## Mappestruktur

```
ukeplan/                         ← parent-mappe (IKKE pushet til GitHub)
  ukeplan_GAS.js                 ← Apps Script for det nye arket «Planelementer»
  reset_password.txt             ← passord-instruksjoner
  roadmap.md / TODO.md / CLAUDE.md / README.md

  ukeplan-app/                   ← GitHub Pages repo-rot (det som publiseres)
    index.html / script.js / styles.css      ← elevside
    teacher.html / teacher.js / teacher.css   ← lærerside (lenker styles.css + teacher.css)
    rich.js                                   ← rik-tekst + in-app dialoger + HTML-sanitizer
    docx.js                                   ← .docx-generator (uten avhengigheter)
    sw.js / manifest.json / icon.svg          ← PWA
```

---

## Kjøre lokalt

```bash
cd ukeplan-app
python -m http.server 8000
# elev:  http://localhost:8000
# lærer: http://localhost:8000/teacher.html
```

`curl` kan ikke teste POST pålitelig (Apps Script 302-redirecter POST) —
verifiser innlogging/CRUD i nettleseren.

---

## Deploy

**Frontend (GitHub Pages):** commit og push filene i `ukeplan-app/`.
Endringer treffer nettleseren først etter at de er pushet.

**Backend (kun ved endring i `ukeplan_GAS.js`):**
1. Åpne regnearket → **Utvidelser → Apps Script**.
2. Lim inn `ukeplan_GAS.js` (erstatt alt).
3. **Deploy → Administrer distribusjoner → rediger → Ny versjon → Deploy**.
4. Sett samme distribusjons-URL som `SCRIPT_URL` i `script.js` og `teacher.js`.

**Service worker:** appen er nettverk-først (`sw.js`), så HTML/JS/CSS-endringer
dukker opp ved neste innlasting. **Bump alltid `CACHE` (`ukeplan-shell-vNN`)**
når du endrer filer — det forhåndslaster ferske filer ved install og rydder bort
gammel cache. Sitter en gammel versjon fast: F12 → Application → «Clear site
data», eller avregistrer service workeren.

---

## Vedlikehold — sjekkliste

**Ved hver kodeendring i `ukeplan-app/`**
- [ ] Bump `CACHE`-versjonen i `sw.js`.
- [ ] Oppdater `CLAUDE.md` hvis oppførsel/datamodell endres.
- [ ] Push til GitHub Pages.

**Ved backend-endring**
- [ ] Redeploy Apps Script (se over). `getSheet()` selvheler header-raden.
- [ ] Hold `isoWeekString()` (backend) og `dateToWeek()` (frontend) i synk —
      de må gi identiske `YYYY-Www`-strenger.

**Hvert skoleår**
- [ ] Oppdater `CLASSES`/`CLASS_GRADES` og `SUBJECTS` (begge i `script.js` *og*
      `teacher.js`).

**Konfigurasjon som må stemme overens**
- `SCRIPT_URL` (nytt ukeplan-backend) og `VURD_URL` (vurderingskalender) er
  satt i både `script.js` og `teacher.js`.

---

## Datamodell & endepunkter (kort — se CLAUDE.md for detaljer)

Arket «Planelementer», kolonner:
`id | timestamp | type | classes | week | day | subject | description | teacher | weekTo`

- `week` = start på uke-rekkevidden, `weekTo` = slutt (tom = én uke).
- `day` = kommaseparerte ukedager (`man,ons`); tom = hele uka.
- `type`: `læringsmål`, `ressurs`, `lekse` (fag-celler) og `beskjed`,
  `timeendring`, `utstyr`, `aktivitet`, `annet` (generelle). `vurdering` lagres
  **ikke** her — den hører til `vurderingskalender`-backenden.

Endepunkter: `public`/`week` (GET, åpne), `login`/`create`/`update`/`delete`/
`clone` (token). `clone` har valgfri `toClasses` for å kopiere klasse → kode.

---

## Personvern — tilpassede planer

Elever med individuell tilrettelegging får en **anonym kode** i stedet for
lagret identitet. Lagret nøkkel er `KLASSE-SUFFIKS`, men eleven/læreren ser og
skriver kun **suffikset** (f.eks. `K7X9M`) — klassen kommer fra elevens
klassevalg, så koden virker **bare med riktig klasse** og røper ikke hvilken
klasse den hører til.

- **Ingen identifiserende data lagres.** Planinnholdet ligger som vanlige
  elementer med `classes = KLASSE-SUFFIKS`. Koblingen kode → elev holdes av
  læreren **utenfor appen**. Ikke noe registerark.
- **Avstigmatisering:** elevens visning er identisk med en vanlig klasse; ingen
  merker noe sted andre ser.
- **Vurderinger arves** fra grunnklassen.
- **Skriv aldri elevnavn i appen.**

---

## Konvensjoner & fallgruver

- POST bruker `application/x-www-form-urlencoded` (via `URLSearchParams`) for å
  unngå CORS-preflight mot Apps Script. **Ikke** bytt til JSON-body.
- Apps Script kan ikke returnere ikke-200-statuskoder — feil kommer som
  `{ error }` i svarkroppen.
- Rik tekst lagres som et begrenset, sanitert HTML-utvalg
  (`<strong> <em> <u> <a href> <br>`), renset både ved lagring og visning.
- Skolerute-feeden caches 24 t i `localStorage`; uke-/vurderingsdata caches 1 t.

---

Copyright Benjamin Ensrud 2026
