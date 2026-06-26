# UX-gjennomgang — «idiotsikring» av ukeplanappen

Gjennomgang av elev- og lærersiden med tanke på brukeropplevelse: steder der en
forvirret eller ikke-teknisk bruker kan sette seg fast, gjøre feil, eller miste
data. Hvert funn har et konkret forbedringsforslag. Sortert etter prioritet.

Filreferanser peker til `ukeplan-app/`.

---

## Status etter runde 1 (implementert)

- ✅ **A1** Bekreftelse før celletømming-sletting, med «ikke spør igjen» (kan slås
  på igjen i den nye profilmodalen). Avbryt gjenoppretter teksten.
- ✅ **A2** Angre/gjør-om for alle plan- og vurderingsendringer (knapper i
  verktøylinja + Ctrl+Z / Ctrl+Y). Angre-toasten har en «Gjør om»-snarvei.
- ✅ **A3** Advarsel når legg-til/rediger-modalen lukkes ved klikk utenfor med
  ulagret tekst.
- ✅ **A4** Lagringsfeil er nå tydelig: rød toast + «⚠ Ikke lagret!» og rød ramme
  på feltet som ikke ble lagret.
- ✅ **Profilmodal** Lærernavn-feltet er gjort om til en knapp («👤 Navn») som
  åpner profil/innstillinger (navn + bryter for slettebekreftelse).
- ✅ **B2** Vurderinger kan legges på hvilken som helst skoledag, men blokkeres på
  helger og fri-/planleggingsdager fra skoleruta (med varsel i modalen).
- ✅ **B3** Passordspørsmålet for vurderingskalenderen sier nå tydelig «Skriv
  passordet på nytt» og at det er samme passord.
- ✅ **B5** Klassevalget låses ved redigering av et eksisterende element (hindrer
  dupliserte/inkonsistente rader), med forklarende notis.
- ✅ **C1** Feil tilpasset-kode gir nå «Finner ingenting her. Har du skrevet koden
  riktig?» – også i Dag-visningen.
- ⏸️ **B1** (auto-lagring usynlig) – satt på vent etter avtale.
- 🔵 **B4** (feilattribuering) – ikke nødvendig; lærere har egne PC-er. Profilen
  viser uansett hvem man er.
- 🗣️ **C2** (avhuking er lokal) – forklares muntlig til elevene.
- ✅ **D2** Kolonneetiketter i elevens Fag-fane på mobil (via `data-label`).
- ✅ **D3** Format-verktøylinja holdes innenfor skjermen (legges under feltet når
  det ikke er plass over).
- ✅ **E1** Forvarsel ~5 min før lærerøkten logger ut.
- ✅ **E3** `role="tab"` / `aria-selected` på fanene (elev + lærer).
- ✅ **E4** Tekniske/engelske feilmeldinger oversettes til vennlig norsk.
- ⬜ **D1** (mobil-merknad for lærerredigering), **E2** (filter-oppdagbarhet) – ikke
  tatt; lav prioritet.

---

## A. Datatap-risiko (høyest prioritet)

Dette er de farligste for «idiotsikring»: lett å utløse ved uhell, ingen vei tilbake.

### A1. Tømming av en celle sletter innholdet permanent – uten bekreftelse
- **Hvor:** `commitRichCell` (teacher.js:845), `commitHomeworkRow` (teacher.js:765),
  `commitProgCell` (teacher.js:1948). Tom verdi ved blur ⇒ `api('delete', …)`.
- **Problem:** En lærer som markerer alt og sletter (f.eks. for å «starte på nytt»
  eller fjerne formatering) og så klikker vekk, sletter elementet for godt. Eneste
  tilbakemelding er et lite «Lagret ✓». Ingen angre.
- **Forslag:** Be om bekreftelse før sletting når en celle som *hadde* innhold blir
  tom (`uiConfirm("Slette innholdet i …?")`), eventuelt bare for celler med ID.
  Alternativt: en kort «Angre»-knapp i toast-en (du har allerede `toast-action`-
  knappen i markup, men den brukes ikke).

### A2. Ingen angrefunksjon noe sted
- **Problem:** Kombinert med autolagring-ved-blur (A1/B1) finnes det ingen måte å
  reversere en utilsiktet endring eller sletting på.
- **Forslag:** Minst «Angre»-knapp i toast-en etter en sletting (behold elementet i
  minnet noen sekunder og gjenopprett via `create`). Stor effekt for liten kost.

### A3. Legg-til/rediger-dialogen forkastes ved klikk utenfor – uten advarsel
- **Hvor:** `closeAddModal` er bundet til `modalOverlay`-klikk (teacher.js:881).
- **Problem:** En lærer skriver en lang beskjed/lekse, bommer på et klikk utenfor
  boksen, og alt forsvinner uten spørsmål.
- **Forslag:** Hvis tekstfeltet er endret, spør «Forkaste det du har skrevet?» før
  lukking ved overlay-klikk (ikke ved «Avbryt»-knappen, som er et bevisst valg).

### A4. Lagringsfeil er nesten usynlig
- **Hvor:** `setSaveError` (teacher.js:2155) — liten tekst i verktøylinja.
- **Problem:** Ved nettverksfeil står det «Feil: …» i liten skrift, men den
  innskrevne teksten blir stående i cellen. Læreren tror den er lagret og navigerer
  videre – endringen er tapt.
- **Forslag:** Tydeligere feil (rød toast med «Ikke lagret – prøv igjen»), og
  marker cellen som «ulagret» (f.eks. gul kant) til den faktisk er lagret.

---

## B. Forvirring / lett å gjøre feil (lærer)

### B1. Autolagring-ved-blur er en usynlig modell
- **Problem:** Det finnes ingen «Lagre»-knapp per celle. Lærere som er vant til at
  «man må trykke lagre» vet ikke at endringer lagres automatisk – eller når. Noen
  vil tro at de *ikke* har lagret og dobbeltskrive; andre vil tro at de har lagret
  noe de ikke har (hvis blur ikke fikk fyrt).
- **Forslag:** En kort forklarende linje over brettet («Endringer lagres automatisk
  når du klikker ut av feltet»), og behold/forsterk «Lagret ✓»-statusen ved hver
  celle.

### B2. Vurdering fra brettet kan bare få dato i inneværende uke
- **Hvor:** For `vurdering` skjules uke-velgeren og dato-feltet låses til uka via
  `min`/`max` (teacher.js:1067 + `setDateInputBounds`:1027).
- **Problem:** Læreren åpner «+ vurdering» på et fag, vil legge prøven til neste
  uke, men datovelgeren tillater bare denne uka. Det er ikke åpenbart at man må
  navigere uke først (eller bruke kalendervisningen).
- **Forslag:** Tillat fri dato i vurderingsdialogen (la datovelgeren styre uka), 
  eller vis en hjelpetekst: «Bytt uke øverst for å legge til en annen dato.»

### B3. Uventet «andre passord» for vurderinger
- **Hvor:** `ensureVurdToken` (teacher.js:288) spør om vurderingskalenderens passord
  ved første vurdering hvis det er forskjellig fra ukeplan-passordet.
- **Problem:** En ikke-teknisk lærer skjønner ikke hvorfor appen plutselig ber om
  *enda* et passord, og hvis de ikke kan det, kan de ikke lagre vurderinger – uten
  å forstå hvorfor.
- **Forslag:** Forklar i dialogen («Vurderinger ligger i vurderingskalenderen, som
  har sitt eget passord»), og helst sørg for at de to passordene er like i drift.

### B4. Lærernavn forhåndsutfylles fra forrige bruker (delt PC)
- **Hvor:** `up_teacher_name` i localStorage; fylles inn i login og som standard
  «Lærer» på nye oppføringer/vurderinger.
- **Problem:** På en delt skole-PC arver neste lærer forrige lærers navn, og
  oppføringer/vurderinger blir feilattribuert.
- **Forslag:** Vis tydelig hvem man er logget inn som, og vurder å ikke prefylle
  navnet på tvers av økter (eller bekreft navnet ved innlogging på delt maskin).

### B5. Redigering av ett per-klasse-element + å legge til en klasse gir dupliserte data
- **Hvor:** Bulk-opprettelse lager ett element per klasse; `openElementEdit`
  redigerer kun *det ene* elementet (teacher.js:964), men klassevelgeren er aktiv.
- **Problem:** Legger man til en klasse i redigeringsmodus, havner to klasser på
  ett element, mens de andre klassene fortsatt har egne elementer ⇒ inkonsistent /
  delvis duplisert. Vanskelig å forstå og rydde i.
- **Forslag:** I redigeringsmodus, enten lås klassevelgeren til elementets egen
  klasse, eller forklar at endring av klasser her bare gjelder dette ene elementet.

---

## C. Forvirring (elev)

### C1. Feil/tastet kode gir misvisende melding i Dag-visning
- **Hvor:** `buildDayDetail` tom-tilstand (script.js:671) viser «Ingenting
  registrert for denne dagen», mens uke-visningen (script.js:840) har det riktige
  hintet «Sjekk at du har valgt riktig klasse og skrevet koden riktig».
- **Problem:** En elev med tilpasset plan som har skrevet feil kode, og som står i
  Dag-visning, får ingen pekepinn om hva som er galt.
- **Forslag:** Vis samme «sjekk klasse og kode»-hint i Dag-visningen når en
  `variantCode` er aktiv og dagen er tom.

### C2. Avhuking av lekser – uklart om det er personlig
- **Hvor:** Lokale avhukingsbokser (`up_done`, script.js:1009).
- **Problem:** En elev kan tro at avhuking sier ifra til læreren / synkroniseres.
  Det er kun lokalt på den enheten.
- **Forslag:** En liten ledetekst («Bare for deg, på denne enheten») over
  lekselisten eller ved første avhuking.

### C3. Foreldet innhold inntil 1 time
- **Hvor:** `CACHE_TTL = 1 t` med bakgrunnsoppdatering (script.js:21).
- **Problem:** Hvis fanen står åpen, kan eleven se gammel plan i opptil en time.
  Oppdater-knappen (↻) er kryptisk og uten tekst.
- **Forslag:** Gi ↻-knappen en synlig etikett eller mer åpenbart ikon, og vurder å
  hente på nytt når fanen får fokus igjen (`visibilitychange`).

---

## D. Mobil / visning

### D1. Lærerredigering er i praksis desktop-orientert
- **Problem:** Inline `contenteditable`-felt + dag-nedtrekk + flytende
  formatlinje er fiklete på telefon. Lærere som prøver å redigere på mobil får en
  dårlig opplevelse.
- **Forslag:** Aksepter at redigering er for desktop, men si det (en liten merknad
  på smal skjerm: «Best på PC»), eller forstørr trykkflater på mobil.

### D2. Stablede kort i elevens Fag-fane mangler kolonneetiketter
- **Hvor:** Fag-fanen bruker `.plan-table` (ikke `.editable`); mobil-CSS-en
  (styles.css:457–463) setter `::before`-etiketter via `.cell-goals` o.l., men
  Fag-fanens celler har ikke disse klassene.
- **Problem:** På mobil blir Uke / Ressurser / Vurdering stående uten ledetekst, og
  det blir uklart hva hver rad/celle er.
- **Forslag:** Gi Fag-tabellens celler samme klasser/etiketter, eller egne
  `::before`-labels for den tabellen.

### D3. Flytende formatlinje kan havne utenfor skjermen
- **Hvor:** `positionRichToolbar` (rich.js:288) plasserer linja over feltet
  (`top - høyde - 6`).
- **Problem:** For et felt øverst i viewporten kan verktøylinja få negativ
  topp-posisjon og bli utilgjengelig.
- **Forslag:** Klem posisjonen til viewporten; legg linja *under* feltet hvis det
  ikke er plass over.

---

## E. Mindre / opprydding

- **E1. Økt utløper etter 4 t uten forvarsel** (teacher.js `TOKEN_TTL`). Ulagret
  inline-redigering kan gå tapt hvis utløpet treffer midt i en økt. Forslag: varsle
  «Økten utløper snart» noen minutter før.
- **E2. Kolonneoverskrifter-som-filter** i Vurderinger-fanen er ikke åpenbart
  klikkbare (kun en liten ▾). «Filtrer»-knappen er tydeligere; vurder å lene seg på
  den.
- **E3. Tilgjengelighet:** Faneknappene mangler `role="tab"` / `aria-selected`.
  (Dag- og kalenderceller har korrekt `role="button"` + tastatur — bra.)
- **E4. Backend-feilmeldinger vises rått** (`err.message`) og kan være tekniske.
  Vurder å oversette de vanligste til vennlig norsk.

---

## Det som allerede er gjort bra

For balanse – flere klassiske fallgruver er allerede håndtert:

- **Dobbel-innsending er sikret** overalt som kan `create` (`_busy`/`_pending`,
  `modalSaving`, `cloning`) – hindrer dupliserte rader.
- **Konfliktvarsling ±7 dager** i vurderingsdialogen.
- **«Kopier forrige uke» advarer** hvis uka allerede har innhold (dupe-fare).
- **Proaktiv utlogging** speiler backend-tokenets levetid.
- **Tilpasset plan er anti-stigma og personvernvennlig** (kun suffiks, ingen
  navn, vises som vanlig klasse for eleven).
- **In-app-dialoger** (ikke native `alert/confirm`) med fokusfelle og Escape.
- **Sletting via dialog bekreftes** (`deleteFromModal`) – det er kun *celletømming*
  som mangler bekreftelse (A1).

---

## Anbefalt rekkefølge

1. **A1 + A2** – bekreft/angre ved celletømming-sletting (størst datataps-risiko).
2. **A3 + A4** – advar mot å forkaste dialog; gjør lagringsfeil tydelig.
3. **B2 + C1** – datovalg for vurderinger; riktig hint ved feil kode.
4. **B1 + C2** – kommuniser autolagring og at avhuking er lokal.
5. Resten (B3–B5, D, E) etter kapasitet.
