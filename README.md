# Kodi for TizenBrew (unofficial)

A [TizenBrew](https://github.com/reisxd/TizenBrew) app module that runs the WebAssembly
build of Kodi from [Ricrdsson1/kodi-tizen-wasm](https://github.com/Ricrdsson1/kodi-tizen-wasm)
on Samsung Tizen TVs. Nothing has to be signed or installed: add the module in TizenBrew.

This is not an official Kodi release and is not endorsed by the XBMC Foundation.
Kodi® is a trademark of the XBMC Foundation; see [kodi.tv](https://kodi.tv).

## Install

In TizenBrew's module manager, add `gh/Jertlok/tizenbrew-kodi` and open "Kodi (unofficial)".
The first start downloads the Kodi build (the release assets) into TizenBrew's data
directory; later starts use it from there.

## How it works

Kodi's WASM build needs `SharedArrayBuffer`. On the TV, the web engine only gives it to
`file://` documents: pages served over http, even from `127.0.0.1` with COOP/COEP headers,
are not cross-origin isolated. So `service.js`, which TizenBrew runs in its Node service,
downloads the build into `/opt/usr/home/owner/apps_rw/<TizenBrew package>/data/kodi/<version>/`
and serves its progress on `http://127.0.0.1:8082/status`. `app/index.html` shows the
progress and then navigates to Kodi's `index.html` there. The Tizen WASM Player, which Kodi
decodes video with, is available on those pages.

Tested so far on one TV: Tizen 9.0, Chromium 120.

## Source of the Kodi build

The release assets are built unmodified from
[Ricrdsson1/kodi-tizen-wasm@8393ab6](https://github.com/Ricrdsson1/kodi-tizen-wasm/tree/8393ab6)
with `tools/wasm/tizen/build.sh` (Emscripten 5.0.6). The release names the exact commit
and carries a source archive. Kodi is GPL-2.0-or-later; Shaka Player, which plays DRM
protected streams, is Apache-2.0.

## Development

`node test-service.mjs` runs the service against a fake release. `publish.sh <owner/repo> <build-dir>`
uploads a build as the release `service.js` downloads from.

## Licence

GPL-2.0-or-later, see [LICENSE](LICENSE).
