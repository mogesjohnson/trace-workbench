#!/usr/bin/env bash
# Build whisper.cpp inside the phone's Termux -> proot Debian and install phone-transcribe (A8).
# Run as root in Debian. Safe to rerun. Long builds die with the proot login, so from Termux run:
#   nohup proot-distro login debian -- bash /path/to/install-whisper.sh > ~/install-whisper.log 2>&1 < /dev/null &
# Extra models: install-whisper.sh small.en tiny.en   (base.en is always installed)
set -euo pipefail

TAG="${WHISPER_TAG:-v1.9.5}"
ROOT="${WHISPER_ROOT:-/opt/whisper.cpp}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Termux's bin dir is first on Debian's PATH (its gcc is clang for Android); build with Debian's tools only.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive

for tool in cmake g++ git make; do
  command -v "$tool" >/dev/null || { apt-get update -qq; apt-get install -y -qq cmake build-essential git; break; }
done

if [ ! -d "$ROOT/.git" ]; then
  git clone -q --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp "$ROOT"
fi
git -C "$ROOT" fetch -q --depth 1 origin tag "$TAG"
git -C "$ROOT" -c advice.detachedHead=false checkout -q "$TAG"

cmake -S "$ROOT" -B "$ROOT/build" -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DBUILD_SHARED_LIBS=OFF
cmake --build "$ROOT/build" -j "$(nproc)" --target whisper-cli

for model in base.en "$@"; do
  [ -f "$ROOT/models/ggml-$model.bin" ] || sh "$ROOT/models/download-ggml-model.sh" "$model"
done

install -m 755 "$HERE/phone-transcribe" /usr/local/bin/phone-transcribe
echo "installed: $("$ROOT/build/bin/whisper-cli" --version 2>&1 | head -1); models: $(ls "$ROOT"/models/ggml-*.bin | xargs -n1 basename | tr '\n' ' ')"
