# TODO

Liste med gjøremål for å forbedre applikasjonen. `[x]` = ferdig, `[ ]` = gjenstår.

## Beslutninger (avklart)

- **Tekstformat (#lenker/#fet):** WYSIWYG-verktøylinje (fet/understrek/lenke) over feltene; lagrer et begrenset, renset HTML-utvalg.
- **Vurderingskalender-faner:** bygges inn i appen som en delt kalender-/tabellvisning (elev + lærer), data fra eksisterende backend.
- **Tema:** «Læringsmål»-kolonnen døpes om til «Tema og læringsmål» (ett felt, ingen datamodellendring).

---

## Ukeplanstruktur

- [x] Døp om «Læringsmål» → «Tema og læringsmål» (ett felt).
- [x] Hyperlenker i innhold (WYSIWYG-verktøylinje, `rich.js`).
- [x] Formatere deler av tekst som fet/understrek (WYSIWYG).
- [x] Dag per lekse; egen dag per klasse. Lekser-kolonnen er nå en per-element-
      editor med dag-nedtrekk; siden brettet redigerer én klasse om gangen, kan
      hver klasse få egen dag. Merk: bulk-tillegg i dialogen setter samme dag for
      alle valgte klasser – per-klasse-dag justeres etterpå i brettet. (Si fra om
      du vil ha dag-per-klasse direkte i dialogen ved bulk.)

## Elevsiden

- [x] Fjernet header «Ukeplan / Runni ungdomsskole»; flyttet til footer.
- [x] Kompakte datoknapper – dag, dato og vurderingsmarkør på én linje.
- [x] Fast kolonnebredde på planarket (`table-layout: fixed`).
- [x] Eleven kan huke av for gjort arbeid (lagret lokalt, per lekse).
- [x] Fane for vurderingskalender (innebygd månedsvisning + dag-detalj).
- [x] Ukedagvisning som alternativ presentasjon: Uke/Dag-veksler; trykk på en
      dag viser alt for den dagen i hovedfeltet. Slide-inn-sidepanelet er fjernet.

## Lærersiden

- [x] Obligatorisk navnefelt i innloggingen.
- [x] Lekser-kolonnen viser hele teksten (fast bredde + autovekst).
- [x] Større tekstfelt i legg-til-dialogen (høyde + padding + synlig markør).
- [x] Oversikt per fag, med sammenligning mellom klasser/trinn (Oversikt-fane).
- [x] Faner for «Ukeplan» / «Vurderinger» / «Oversikt».
- [x] Legg-til-dialog: mulighet til å velge en annen uke enn gjeldende.
- [x] Fane for vurderinger – tabell over klassens vurderinger med rediger/slett,
      legg til ny, og konfliktvarsling (±7 dager) i dialogen.

---

## Alt i lista er nå implementert ✓

Lagt til senere:
- [x] **Ressurser-kolonne** (ny type `ressurs`) per uke/fag, f.eks. sider i læreboka.
      Vises i ukebrett, fagprogresjon og oversikt. (Krever redeploy av Apps Script.)
- [x] **Eksporter fagrapport (.docx)** fra Progresjon-modus (lærer) — bygger en
      Word-fil for valgt fag + klasse, uke for uke, uten eksterne biblioteker.
- [x] **Uke-intervall «fra uke A til uke B»** i progresjonsvisningene (elev «Fag»
      og lærer «Progresjon»). Eksporten følger samme valgte intervall.
- [x] **Dato-intervall «fra dato A til dato B»** i vurderingskalender-fanen, med
      samme standard som original-appen (i dag → +2 mnd, klemt til skoleåret).
- [x] **Skoleruta i kalendervisningen** — fri/planleggingsdager tones, «P»-merke
      og grønn markør, og info vises når man klikker en dag. (Skoleruta ble alt
      hentet for ukestripa/dagvisning; nå også synlig i kalenderfanen.)
- [x] **Fagprogresjon (uke for uke).** Lærer: Oversikt-fanen har modus «Sammenlign
      klasser» og «Progresjon» (fag + klasse, uke for uke). Elev: ny «Fag»-fane som
      viser progresjonen i et valgt fag for egen klasse. Begge henter alle
      planelementer via `action=public` (cachet 1 t).

- [x] **Uke-intervall + flere dager + fag på generelle elementer.** Elementer kan
      gjelde uke A–B og flere dager; beskjeder/utstyr/aktiviteter kan knyttes til fag
      («Fag:»-prefiks) eller være generelle for uka. Like elementer grupperes i én
      rute per type. Inline-redigering for enkeltuke; fler-uke/-dag via dialog-chips.
      (Krever redeploy av Apps Script – ny `weekTo`-kolonne.)
- [x] **Redigerbar progresjon + tema for en periode.** Tema/ressurser redigeres rett
      i progresjons-tabellen; «+ Tema for periode» setter tema over et uke-intervall.

Mulige videre forbedringer (ikke i opprinnelig liste):
- Dag-per-klasse direkte i legg-til-dialogen ved bulk (i dag justeres det i brettet).
- Måned-/kalendervisning også i lærerens Vurderinger-fane (i dag tabell; elevsiden har månedsgrid).
- Rydde bort ubrukt CSS for det gamle slide-inn-panelet og ubrukt `autoGrow` i teacher.js.
