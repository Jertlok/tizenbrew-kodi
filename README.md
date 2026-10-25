# Kodi for TizenBrew (unofficial)

A [TizenBrew](https://github.com/reisxd/TizenBrew) app module that runs the WebAssembly
build of Kodi from [Ricrdsson1/kodi-tizen-wasm](https://github.com/Ricrdsson1/kodi-tizen-wasm)
on Samsung Tizen TVs. Nothing has to be signed or installed: add the module in TizenBrew.

This is not an official Kodi release and is not endorsed by the XBMC Foundation.
Kodi® is a trademark of the XBMC Foundation; see [kodi.tv](https://kodi.tv).

## Install

In TizenBrew's module manager, add `gh/Jertlok/tizenbrew-kodi@0.0.5` and open
"Kodi (unofficial)". That is the only time a version is typed: updates arrive by
themselves (see below).
The first start downloads the Kodi build (the release assets, about 56 MB gzipped) into
TizenBrew's data directory; later starts use it from there.

## Kodi as an app of its own

The release also has `Kodi.wgt`, the same build as a widget of its own (package
`KodiWasmTv`). Installed, Kodi gets a tile on the TV's home screen and starts without
TizenBrew. The widget is unsigned: a TV only installs it signed with the user's own Samsung
certificate. With the certificate made by TizenBrew Installer Desktop, this PC can sign and
install it while Developer Mode stays at `127.0.0.1`:

    cd tools && npm install && cd ..
    node tools/tv.mjs install Kodi.wgt --tv <tv-ip>

TizenBrew has to be open, with this module added. `tv.mjs` signs the widget, serves it on
the LAN for one download, and asks the module's service, through TizenBrew's DevTools, to
install it with the TV's own sdb. The certificate stays on the PC. Any other widget can be
installed the same way.

## How it works

Kodi's WASM build needs `SharedArrayBuffer`. On the TV, the web engine only gives it to
`file://` documents: pages served over http, even from `127.0.0.1` with COOP/COEP headers,
are not cross-origin isolated. So `kodi-service.js`, which runs in TizenBrew's Node service,
downloads the build into `/opt/usr/home/owner/apps_rw/<TizenBrew package>/data/kodi/<version>/`
and serves its progress on `http://127.0.0.1:8083/status`. `app/index.html` shows the
progress and then navigates to Kodi's `index.html` there. The Tizen WASM Player, which Kodi
decodes video with, is available on those pages.

Tested so far on one TV: Tizen 9.0, Chromium 120.

## Source of the Kodi build

The release assets are built from
[Ricrdsson1/kodi-tizen-wasm@8393ab6](https://github.com/Ricrdsson1/kodi-tizen-wasm/tree/8393ab6)
with `tools/wasm/tizen/build.sh` (Emscripten 5.0.6), plus two build fixes in
`kodi-local-changes.patch`: the C standard option autoconf 2.72 adds to `CC` is kept out
of the generated toolchain files, and the static add-ons wait for the libraries Kodi
builds itself. The release names the exact commit and carries the source archive and
the patch. Kodi is GPL-2.0-or-later; Shaka Player, which plays DRM
protected streams, is Apache-2.0.

## Development

`node test-service.mjs` runs the service against a fake release and a fake sdb;
`node tools/test-tv.mjs` checks the signing. `publish.sh <owner/repo> <build-dir> <kodi-source-dir>`
uploads a build as the release `service.js` downloads from (`DRY_RUN=1` stops before the
upload and keeps the files). It refuses a build made with `FAST_LINK=1`.

TizenBrew gets `service.js` and `app/` from jsDelivr, whose alias for the newest tag can
lag for hours, and starts a module's service only once per run of its service process,
which outlives the TizenBrew app. So those files are a bootstrap that stays the same:
`service.js` only fetches `kodi-service.js` from the `main` branch and runs it, and the
page asks it to fetch and run the newest copy (`/reload`) each time Kodi is opened. A
change to `kodi-service.js` therefore reaches the TV by pushing to `main`. Changing
`service.js` or `app/` needs a new tag and the module added again with that version.

The Kodi build is a separate release, named by `KODI_RELEASE` in `kodi-service.js`.

## Licence

GPL-2.0-or-later, see [LICENSE](LICENSE).
