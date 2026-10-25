#!/bin/sh
# Uploads a Kodi WASM build as the GitHub release that service.js downloads from,
# with the source archive of the Kodi tree it was built from (GPL).
# Usage: publish.sh <owner/repo> <build-dir> <kodi-source-dir>
# The build dir is <work-dir>/build of build.sh; package.sh staged the files in its tizen-wgt.
set -e
USAGE='usage: publish.sh <owner/repo> <build-dir> <kodi-source-dir>'
REPO=${1:?$USAGE}
STAGE=${2:?$USAGE}/tizen-wgt
KODI=${3:?$USAGE}
VERSION=$(sed -n "s/^var VERSION = '\(.*\)';/\1/p" "$(dirname "$0")/service.js")
COMMIT=$(git -C "$KODI" rev-parse HEAD)

# config.xml belongs to the widget only; TizenBrew's own widget hosts the page.
(cd "$STAGE" && find . -type f ! -name config.xml ! -name files.txt | sed 's|^\./||' | sort) > "$STAGE/files.txt"
cat "$STAGE/files.txt"
# Release assets are flat: media/splash.jpg goes up as media__splash.jpg (service.js maps it back).
FLAT=$(mktemp -d)
while read -r f; do cp "$STAGE/$f" "$FLAT/$(echo "$f" | sed 's|/|__|g')"; done < "$STAGE/files.txt"
cp "$STAGE/files.txt" "$FLAT/"
# Not in files.txt, so the TV does not download it.
git -C "$KODI" archive --format=tar.gz --prefix="kodi-tizen-wasm-$COMMIT/" -o "$FLAT/kodi-source-$COMMIT.tar.gz" HEAD
gh release create "v$VERSION" -R "$REPO" -t "Kodi WASM $VERSION (unofficial)" -n "Unofficial Kodi WASM build for the tizenbrew-kodi module.

Built unmodified with tools/wasm/tizen/build.sh from https://github.com/Ricrdsson1/kodi-tizen-wasm/tree/$COMMIT (GPL-2.0-or-later); its source is attached as kodi-source-$COMMIT.tar.gz. Shaka Player is Apache-2.0. Not endorsed by the XBMC Foundation." "$FLAT"/*
rm -rf "$FLAT"
