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
# The release tag kodi-service.js downloads from; bump KODI_RELEASE there for a new Kodi build.
TAG=$(sed -n "s/^var KODI_RELEASE = '\(.*\)';/\1/p" "$(dirname "$0")/kodi-service.js")
COMMIT=$(git -C "$KODI" rev-parse HEAD)

# A fast-linked build (FAST_LINK=1 build.sh) is larger and slower: for development only.
if grep -q '^WASM_FAST_LINK:BOOL=ON' "$STAGE/../CMakeCache.txt"; then
  echo "error: this build was linked with WASM_FAST_LINK; build it again without FAST_LINK=1" >&2; exit 1
fi

TREE=$(mktemp -d); FLAT=$(mktemp -d)
cp -r "$STAGE/." "$TREE/"
rm -f "$TREE/files.txt"
# The build leaves paths of the build machine in the binaries (OpenSSL and fontconfig
# directories, source file names in log and assert strings); none is used on the TV,
# which keeps Kodi's files under /kodi. Overwrite the workspace that holds the Kodi tree
# and the work dir with /build padded with slashes to the same length: lengths in the
# binary stay valid, and repeated slashes name the same path.
WS=$(dirname "$(cd "$KODI" && pwd)")
NEUTRAL=/build; while [ ${#NEUTRAL} -lt ${#WS} ]; do NEUTRAL="$NEUTRAL/"; done
[ ${#NEUTRAL} -eq ${#WS} ] || { echo "error: workspace path $WS is shorter than /build" >&2; exit 1; }
find "$TREE" -type f -exec env WS="$WS" NEUTRAL="$NEUTRAL" perl -0777 -pi -e 's/\Q$ENV{WS}\E/$ENV{NEUTRAL}/g' {} +
if grep -rlF -e "$WS" -e "$HOME" "$TREE"; then
  echo "error: the files above still name a path of this machine; nothing was uploaded" >&2; exit 1
fi

# The standalone app: the same files as a widget of its own (package KodiWasmTv). It is
# unsigned; the TizenBrew Installer, TizenBrew's "Install as app" or tools/tv.mjs sign it
# with the user's certificate.
(cd "$TREE" && zip -q -r "$FLAT/Kodi.wgt" .)

# What the module's service downloads. config.xml belongs to the widget only; TizenBrew's
# own widget hosts the page. Files over 4 MB (kodi.wasm, kodi.data) go up gzipped, which
# halves the download; the service unpacks them. Release assets are flat: media/splash.jpg
# goes up as media__splash.jpg (the service maps it back).
(cd "$TREE" && find . -type f ! -name config.xml | sed 's|^\./||' | sort) | while read -r f; do
  flat=$(echo "$f" | sed 's|/|__|g')
  if [ "$(stat -c %s "$TREE/$f")" -gt 4000000 ]; then
    gzip -9n -c "$TREE/$f" > "$FLAT/$flat.gz"; echo "$f.gz"
  else
    cp "$TREE/$f" "$FLAT/$flat"; echo "$f"
  fi
done > "$FLAT/files.txt"
cat "$FLAT/files.txt"
rm -rf "$TREE"
# Not in files.txt, so the TV does not download it.
git -C "$KODI" archive --format=tar.gz --prefix="kodi-tizen-wasm-$COMMIT/" -o "$FLAT/kodi-source-$COMMIT.tar.gz" HEAD
# The build fixes made in the Kodi tree, which the archive (of the commit) does not have.
git -C "$KODI" diff HEAD > "$FLAT/kodi-local-changes.patch"
# DRY_RUN=1: stop here and keep the files, to look at them first.
if [ -n "${DRY_RUN:-}" ]; then echo "dry run: the release files are in $FLAT"; exit 0; fi
gh release create "$TAG" -R "$REPO" -t "Kodi WASM $TAG (unofficial)" -n "Unofficial Kodi WASM build for the tizenbrew-kodi module.

Built with tools/wasm/tizen/build.sh from https://github.com/Ricrdsson1/kodi-tizen-wasm/tree/$COMMIT (GPL-2.0-or-later) plus the build fixes in kodi-local-changes.patch; the source is attached as kodi-source-$COMMIT.tar.gz. Shaka Player is Apache-2.0. Not endorsed by the XBMC Foundation." "$FLAT"/*
rm -rf "$FLAT"
