#!/bin/sh
# Uploads a Kodi WASM build as the GitHub release that service.js downloads from.
# Usage: publish.sh <owner/repo> <build-dir>
# The build dir is <work-dir>/build of build.sh; package.sh staged the files in its tizen-wgt.
set -e
REPO=${1:?usage: publish.sh <owner/repo> <build-dir>}
STAGE=${2:?usage: publish.sh <owner/repo> <build-dir>}/tizen-wgt
VERSION=$(sed -n "s/^var VERSION = '\(.*\)';/\1/p" "$(dirname "$0")/service.js")

# config.xml belongs to the widget only; TizenBrew's own widget hosts the page.
(cd "$STAGE" && find . -type f ! -name config.xml | sed 's|^\./||' | sort) > "$STAGE/files.txt"
cat "$STAGE/files.txt"
# Release assets are flat: media/splash.jpg goes up as media__splash.jpg (service.js maps it back).
FLAT=$(mktemp -d)
while read -r f; do cp "$STAGE/$f" "$FLAT/$(echo "$f" | sed 's|/|__|g')"; done < "$STAGE/files.txt"
cp "$STAGE/files.txt" "$FLAT/"
gh release create "v$VERSION" -R "$REPO" -t "Kodi WASM $VERSION" -n "Kodi WASM build for the tizenbrew-kodi module." "$FLAT"/*
rm -rf "$FLAT"
