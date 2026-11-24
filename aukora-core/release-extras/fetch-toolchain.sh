#!/bin/sh
# Download the two pinned toolchains for Apple-silicon macOS into DIR (about 650 MB unpacked).
# Nothing here is trusted: build-tree.py checks every file of both against release-tools/TOOLCHAIN-darwin-arm64.sha256.
# Usage: sh release-tools/fetch-toolchain.sh toolchain
set -eu
dir="${1:?usage: fetch-toolchain.sh DIR}"; mkdir -p "$dir"; cd "$dir"
lean=https://github.com/leanprover/lean4/releases/download/v4.19.0/lean-4.19.0-darwin_aarch64.zip
wasi=https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-arm64-macos.tar.gz
[ -d lean-4.19.0-darwin_aarch64 ] || { curl -fL --retry 3 -o lean.zip "$lean"; unzip -q lean.zip; rm lean.zip; }
[ -d wasi-sdk-25.0-arm64-macos ] || { curl -fL --retry 3 -o wasi.tar.gz "$wasi"; tar -xzf wasi.tar.gz; rm wasi.tar.gz; }
ls -d lean-4.19.0-darwin_aarch64 wasi-sdk-25.0-arm64-macos
