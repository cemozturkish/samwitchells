# samwitchells

The site is a single page: the silver logo on black.

- `index.html`, `home.css`, `logo.js` — the homepage. `logo.js` lights the logo
  like polished metal: the mouse is the light on desktop, tilting the phone
  moves it on mobile.
- `assets/` — textures for the shader, generated from `background.png` by
  `python3 _tools/build_logo_maps.py` (needs pillow, numpy, scipy). Re-run it
  if the logo artwork changes.
- `404.html` — sends any other URL back to the homepage.

## Parked pages

Music, Merch, Inspiration and the Inspiration admin live in `_parked/` with
their stylesheet, script, data and images. GitHub Pages does not publish
folders that start with an underscore, so they are offline but intact.

To bring them back, move the contents of `_parked/` to the repository root
(`git mv _parked/* .`) and link to them from `index.html`.
