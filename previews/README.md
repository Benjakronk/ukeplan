# previews/

Standalone, self-contained HTML mockups for eyeballing a single piece of UI in
isolation — without logging in or triggering the real flow. Each file inlines
its own copy of the relevant CSS/markup, so you can just **double-click it** to
open in a browser.

These are development aids, not part of the app. They are not linked from the
site, but because this repo is served by GitHub Pages they *are* reachable at
`https://ukeportalen.no/previews/<file>` — keep them free of anything sensitive.

Duplicated snippets here can drift from the real `teacher.js`/`teacher.css`; treat
a preview as a design sketch of that moment, and re-generate it if the real UI
has moved on.

## Files

- `onboard-preview.html` — the first-run onboarding **journey progress bar** in
  all seven states (welcome → mål). The "Mål" card has a button to replay the
  pin's victory hop.
