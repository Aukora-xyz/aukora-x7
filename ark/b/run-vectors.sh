#!/bin/sh
# Reader 2 (Go): build the Go verifier and check it against every vector in vectors.
set -e
B="$(cd "$(dirname "$0")" && pwd)"
export GOTOOLCHAIN=local GOPROXY=off GOFLAGS= GOCACHE="$B/.gocache"
GO=${GO:-go}
cd "$B"
mkdir -p bin
"$GO" build -o bin/verifier ./cmd/verifier
"$GO" build -o bin/vectorcheck ./cmd/vectorcheck
exec "$B/bin/vectorcheck" "$B/bin/verifier" "$B/../vectors"
