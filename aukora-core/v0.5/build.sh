#!/bin/sh
# Clean, serial, offline build and comparison. The lab supplies the pinned toolchains.
set -eu
exec python3 "$(dirname "$0")/tools/build.py"
