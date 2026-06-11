# Ukeplan — Roadmap & Design

Et nettverktøy for ukeplanarbeid ved Runni ungdomsskole. Erstatter den
tidkrevende Teams → OneNote → klassenotatblokk → ukeplaner-navigasjonen med
en elevside (les) og en lærerside (rediger) — bygget på samme mønster som
`vurderingskalender`, men i egen mappe slik at det eksisterende verktøyet
står urørt.

## Designvalg (besluttet)

1. **Slått sammen med vurderingskalenderen, men i egen mappe.** Originalkoden,
   det gamle arket og den gamle Apps Script-backenden røres ikke. Sammenslåingen
   skjer på *lesetidspunktet*: ukeplan-appen henter vurderinger fra den
   eksisterende `vurderingskalender`-backenden og fletter dem inn.
2. **Fag-rader-layout.** Ukeplanen vises som rad per fag, med kolonner for
   læringsmål, lekser og vurdering — den vanligste norske ukeplan-formen.
3. **Per uke som detaljnivå.** Innhold knyttes til uka per fag (ikke per dag).
   Dagspesifikke elementer (prøve, tur, gymtøy) kan likevel få en `day`.

## Hvorfor dette kutter klikkene

Dagens flyt for å redigere en ukeplan: Teams → OneNote → klassenotatblokk →
ukeplaner → finn riktig uke → rediger. Det nye verktøyet:

- **Lærer logger inn → lander rett på et ukebrett** for valgt klasse +
  inneværende uke. Null navigasjon.
- **Inline hurtig-add:** klikk en celle (fag × kategori) → skriv → Enter.
  Ingen flerstegs-dialog for enkle ting.
- **«Kopier fra forrige uke»:** ukeplaner gjentar struktur (faste læringsmål,
  faste lekser). Duplisér forrige uke og rediger differansen. Sparer mest tid.
- **Bulk-klasser:** ett element → flere paralleller (8A 8B 8C) i ett jafs.
- **Tastaturførst:** Tab mellom fag, Enter for å lagre.

---

## Arkitektur

```
ukeplan/                         ← ny parent-mappe (ikke pushet til GitHub)
  ukeplan_GAS.js                 ← Apps Script for det NYE arket (Planelementer)
  reset_password.txt             ← passordinstruks (samme mønster som gammelt)
  roadmap.md                     ← dette dokumentet
  CLAUDE.md                      ← guide for videre arbeid

  ukeplan-app/                   ← GitHub Pages repo-rot
    index.html / script.js / styles.css     ← elev-ukeplan (les)
    teacher.html / teacher.js / teacher.css  ← lærer-ukeplan (rediger)
    sw.js / manifest.json / icon.svg         ← PWA (gjenbruk)
```

### Dataflyt

```
Nytt ark "Planelementer"  ──► ukeplan_GAS.js ──► GET ?action=week ──┐
(lekser, læringsmål,                                                 ├─► flettes i
 beskjeder, utstyr, …)                                               │   nettleseren
                                                                     │   → ukebrett
Eksisterende vurderings-  ──► gammel GAS ─────► GET ?action=public ──┘
kalender-backend (urørt)      (uendret)
```

Vurderinger har én eier (det gamle systemet); planelementer har én eier (det
nye arket). Ukeplan-appen er kun en **leser** av vurderinger — den skriver dem
aldri. (Senere fase kan eventuelt la lærersiden opprette vurderinger via den
gamle GAS-ens `create`-endepunkt, uten å endre gammel kode. Se Fase 4.)

---

## Datamodell — nytt ark "Planelementer"

Én rad per planelement. Vurderinger lagres **ikke** her (de kommer fra det
gamle arket på lesetidspunktet).

| Col | Felt | Merknad |
|-----|------|---------|
| A | `id` | UUID generert av skriptet. |
| B | `timestamp` | ISO-tidsstempel, oppdateres ved hver create/edit. |
| C | `type` | `lekse` · `læringsmål` · `beskjed` · `timeendring` · `utstyr` · `aktivitet` · `annet` |
| D | `classes` | Mellomromsseparerte klassekoder, f.eks. `8A 8B 9C`. |
| E | `week` | ISO-uke som `YYYY-Www`, f.eks. `2026-W24`. Bøttenøkkel. |
| F | `day` | Valgfri: `man`–`fre`. Tom for ukegenerelle elementer. |
| G | `subject` | Valgfri fagkode. Tom for ukegenerell `beskjed`. |
| H | `description` | Fritekst innhold. |
| I | `teacher` | Lærerens navn (manuelt, som i vurderingskalenderen). |

Rad 1 er header: `id | timestamp | type | classes | week | day | subject | description | teacher`.

### Faste lister (hardkodet, oppdateres hvert skoleår)

```js
const CLASSES = [
  '8A','8B','8C','8D','8E','8F',
  '9A','9B','9C','9D','9E','9F',
  '10A','10B','10C','10D','10E','10F',
];

const SUBJECTS = [
  'Norsk','Matematikk','Engelsk','Naturfag','Samfunnsfag','KRLE',
  'Kroppsøving','Musikk','Kunst og håndverk','Mat og helse',
  'Fremmedspråk','Utdanningsvalg',
];
```

### ISO-uke

`week` lagres som `YYYY-Www`. Hjelpefunksjoner: `dateToWeek(date)` og
`weekToDates(week)` (mandag–fredag). Vurderinger fra det gamle arket har bare
`date` — appen utleder `week` fra `date` ved fletting.

---

## Apps Script API (nytt — speiler vurderingskalenderens mønster)

Samme auth-modell: delt passord (SHA-256-hash i Script Properties) → kortlevd
UUID-token i `sessionStorage`. Alle feil returneres som `{ "error": "..." }`
med HTTP 200 (GAS-begrensning).

| Action | Metode | Auth | Formål |
|--------|--------|------|--------|
| `week` | GET | ingen | Planelementer for `classes` + `week` (server-side filtrert — for skalering) |
| `public` | GET | ingen | Alle planelementer (fallback/elevcache) |
| `login` | POST | ingen | Valider passord, returner token |
| `all` | GET | token | Alle planelementer for lærerdashboard |
| `create` | POST | token | Nytt element |
| `update` | POST | token | Endre element via `id` |
| `delete` | POST | token | Slett element via `id` |
| `clone` | POST | token | Kopier alle elementer fra `fromWeek` → `toWeek` for `classes` |

**Skalering:** I motsetning til vurderingskalenderen (få rader, last alt) kan
ukeplaner bli mange rader (klasser × fag × uker × år). Derfor filtrerer `week`
server-side på klasse + uke, så elevsiden ikke laster hele året hver gang.

---

## Elevside (`index.html` / `script.js`)

- **Velg klasse én gang** (huskes i `localStorage`, gjenbruk modal-mønsteret).
- **Lander på inneværende uke**, med ◀ ▶ for forrige/neste uke + «I dag».
- **Fag-rader-brett:**

```
┌────────────────────────────────────────────────────────┐
│  Ukeplan — 8A            ◀  Uke 24 · 9.–13. juni  ▶    │
│  📣 Husk gymtøy onsdag · Tur fredag                    │
├──────────┬──────────────┬───────────────┬─────────────┤
│  Fag     │  Læringsmål  │  Lekser       │  Vurdering  │
├──────────┼──────────────┼───────────────┼─────────────┤
│  Norsk   │  Skrive...   │  Les s.40–42  │             │
│  Matte   │  Brøk        │  Oppg 5.1–5.6 │  Prøve fre ●│
│  Engelsk │  Past tense  │  Gloser       │             │
└──────────┴──────────────┴───────────────┴─────────────┘
```

- **Skolerute-overlay** (fri/planleggingsdag) gjenbrukes fra vurderingskalenderen.
- **Vurderinger** hentes read-only fra gammel backend og vises i `Vurd.`-kolonnen.
- **Skriv ut / PDF** for uka (foreldrevennlig).
- **Offline** via service worker + `localStorage`-cache (1 t TTL + «Oppdater»).

## Lærerside (`teacher.html` / `teacher.js`)

- **Login-skjerm** → **ukebrett** for valgt klasse + uke (redigerbart).
- **Inline-redigering** av celler (fag × {læringsmål, lekser}).
- **«Kopier fra forrige uke»**-knapp (`clone`-endepunkt).
- **Bulk-klasser** i add/edit: huk av flere paralleller.
- **Beskjeder** = ukegenerelle (uten `subject`), vises i toppbanneret.
- **Klasse-/ukevelger** øverst; lærernavn huskes i `localStorage`.

---

## Migrasjonsplan / byggerekkefølge

### Fase 1 — Backend
- Opprett nytt ark `Planelementer` med header-rad.
- Deploy `ukeplan_GAS.js` som ny web-app («Execute as: Me», «Anyone»).
- Kjør engangs `setupPassword()` i Script Editor.

### Fase 2 — Elevside
- `index.html` / `script.js` / `styles.css`: fag-rader-brett, ukevelger,
  klassevalg-modal, skolerute-overlay, vurderingsfletting fra gammel backend.
- Deploy til GitHub Pages og verifiser.

### Fase 3 — Lærerside
- `teacher.html` / `teacher.js` / `teacher.css`: login, ukebrett-redigering,
  inline-add, «kopier forrige uke», bulk-klasser.
- Brief lærere på ny flyt.

### Fase 4 (valgfri, senere) — Vurderingsforfatting i samme verktøy
- La lærersiden opprette vurderinger via den gamle GAS-ens `create`-endepunkt
  (gammel kode forblir urørt — vi bruker bare API-et). Da har lærere ett sted
  for alt, uten dobbeltføring.

## Implementasjonsrekkefølge

1. **Nytt Apps Script** — CRUD + auth + `week`/`clone`. Alt annet avhenger av dette.
2. **Elevside** — synlig forbedring for flest brukere.
3. **Lærerside** — bygget på fungerende backend.
4. **Vurderingsforfatting** — når lærere er komfortable.
