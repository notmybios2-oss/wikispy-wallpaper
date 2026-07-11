# HUMANITY WALLPAPER

[![Wallpaper Engine](https://img.shields.io/badge/Wallpaper%20Engine-web%20wallpaper-blue)](https://www.wallpaperengine.io/)
[![Powered by Wiki Spy](https://img.shields.io/badge/powered%20by-neal.fun%2Fwiki--spy-orange)](https://neal.fun/wiki-spy/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Live demo](https://img.shields.io/badge/live%20demo-github%20pages-lightgrey)](https://notmybios2-oss.github.io/HUMANITY-WALLPAPER/)

Get the world's knowledge as your wallpaper (Thanks to [neal.fun Wiki Spy](https://neal.fun/wiki-spy/) and wikipedia)
It drifts forever in the background, you can click on anything you see to have a quick description and fall in a rabbit-hole without even opening wikipedia

![Drifting cosmos](docs/media/drift.gif)

## What

- **Endless** — streams the live 43,000+ object from Wiki Spy catalogue
- **Force-in-space steering** — hold left mouse and drag to grab the cosmos
- **Item cards** — left-click any object for its card instantly
- **Block anything** — the ✕ on a card hides that item or its whole category ("shoutout to all my arachnophobians !")
- **Parallax depth** — three drift layers at different speeds and scales (might be changed in the future to allow scrolling front to back)
- **Offline resilient** — you'l see it once you have no internet
- **Performance-aware** — near-zero CPU when still, sheds objects under load,
  low-power mode, respects the Wallpaper Engine FPS limit (thank you  for the optimisation claude code !)

## See item cards example
![Item card](docs/media/card.png) 

## Install (Wallpaper Engine, windows)

~~REMINDER FOR MYSELF : Add it to the wallpaper engine discovery tab so users don't have to do all this bs for a wallpaper~~

Update, uploaded to workshop : https://steamcommunity.com/sharedfiles/filedetails/?id=3762580198

1. Clone or download this repository.
2. Copy the `wallpaper/` folder into
   `...\Steam\steamapps\common\wallpaper_engine\projects\myprojects\wikispy-wallpaper\`
   — or just run `deploy.ps1`, which finds Steam and syncs it for you.
3. Restart Wallpaper Engine and select **HUMANITY WALLPAPER** under
   Installed → My Projects.

> Wallpaper Engine forwards only the **left mouse button** and cursor
> position to web wallpapers — the wallpaper is built entirely around that.

## Install (macOS — free btw) (not tested srry but let me know)

1. Install [Plash](https://sindresorhus.com/plash) (free, open source, on the Mac App Store)
2. Click the Plash icon in your menu bar → **Add Website…**
3. Paste this and hit save:
   `https://notmybios2-oss.github.io/HUMANITY-WALLPAPER/`
4. ALSO: in the Plash menu, enable **Browsing Mode** to click items and drag the cosmos around or i thnk it won't work

## Settings

Everything is a Wallpaper Engine property — no code editing needed:

| Setting | Default | What it does |
| --- | --- | --- |
| Background color | deep navy | Also follows your WE scheme color until customized |
| Motion / speed / direction | on, 8 px/s, → | The ambient drift; direction re-aims when you fling |
| Direction wander | on | Slow ±10° meander so long sessions never feel mechanical |
| Object density / scale | 1.0 / 1.0 | How crowded and how big |
| Parallax depth | on | Three-layer depth illusion |
| Grab and pan | on | Left-drag steering (middle mouse also works in a browser) |
| Stir the cosmos | off | Fast pointer sweeps push the world without clicking |
| Focus + cards | on | Track an object to freeze the drift; left-click for its card (hover-cards optional, off) |
| Show blocked list | off | Overlay to review and revert blocks |
| Low power mode | off | Half density + 24 FPS cap for laptops |
| Debug overlay | off | Live API/FPS/cache/input diagnostics |

## Development

```
node dev/serve.mjs
```

Open `http://localhost:8090/?debug=1`. The dev server proxies the Wiki Spy
API (its CORS allowlist only covers neal.fun; Wallpaper Engine's runtime
calls it directly). Useful URL params: `speed`, `direction`, `density`,
`q=<keyword>`, `blocksui=1`, `failapi=1` (simulate an outage), `debug=1`.
Press `d` for the debug overlay.

## Credits

- **[Neal Agarwal](https://neal.fun)** — Wiki Spy is his creation; this
  wallpaper is an unofficial fan project that renders the live Wiki Spy
  catalogue in ambient form. Go play [the original](https://neal.fun/wiki-spy/).
- **[Wikipedia](https://www.wikipedia.org/) / [Wikimedia Commons](https://commons.wikimedia.org/)** —
  every object is a Creative Commons or public-domain image contributed by
  Wikimedia photographers and artists. Per-image attribution (artist and
  license) is shown on each item card.
- **[Wallpaper Engine](https://www.wallpaperengine.io/)** — the runtime that
  makes web wallpapers possible.

This project is not affiliated with or endorsed by Neal Agarwal, the
Wikimedia Foundation, or Wallpaper Engine. It uses the public Wiki Spy API
politely (small batches, backoff, ~50 requests/hour measured) and is
intended for personal use. If you are Neal and want anything changed,
please open an issue.

## Contact

contact.mybios@gmail.com if you wana contact me

## License

[MIT](LICENSE) — covers the code in this repository only. The Wiki Spy
catalogue, its cutout images, and Wikipedia content remain under their own
licenses and belong to their respective creators.
