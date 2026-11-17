#!/bin/sh
# Builds pangu-cli and stages it where Tauri's externalBin expects it.
# Usage: build-pangu.sh [debug|release]
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
profile="${1:-debug}"
flag=""
[ "$profile" = release ] && flag="--release"
cd "$root"
cargo build -p pangu-cli $flag
triple="$(rustc -vV | sed -n 's/^host: //p')"
dest="$root/apps/panguyuban-desktop/src-tauri/binaries"
mkdir -p "$dest"
cp "target/$profile/pangu" "$dest/pangu-$triple"
