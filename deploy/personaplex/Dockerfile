# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# PersonaPlex 7B voice renderer for your-node (GET /door/voice) and dsh-superagent-prototype.
# One self-contained Dockerfile, two images (see README.md):
#
#   docker build --target renderer -t aukora-voice-renderer:local deploy/personaplex
#   docker build --target gateway  -t aukora-voice-gateway:local  deploy/personaplex
#
# renderer  stock NVIDIA/personaplex moshi.server, pinned to a commit + tarball sha256 + per-wheel
#           sha256, credential-free (launch.sh refuses to start if one appears), offline weights.
# gateway   the only thing that may talk to the renderer: verifies the Worker's bearer against a
#           SHA-256 digest, rebuilds the upstream request, relays audio. Its unit tests run as a
#           build stage, so the gateway image cannot be built if they fail.
#
# Nothing in this file is a secret. Verify with: node deploy/personaplex/verify-personaplex-zero-secret.mjs

ARG CUDA_IMAGE=nvcr.io/nvidia/cuda:12.4.1-runtime-ubuntu22.04@sha256:517da2300c184c9999ec203c2665244bdebd3578d12fcc7065e83667932643d9
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.5@sha256:f459f6f73a8c4ef5d69f4e6fbbdb8af751d6fa40ec34b39a1ab469acd6e289b7
ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

# ---------------------------------------------------------------------------------------------
FROM ${UV_IMAGE} AS uv

# ---------------------------------------------------------------------------------------------
FROM ${CUDA_IMAGE} AS renderer-build
COPY --from=uv /uv /usr/local/bin/uv
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_NO_CACHE=1
# NVIDIA/personaplex main @ 2026-11-06T07:34:45Z. GitHub archive bytes are not contractually stable;
# if the checksum ever fails with no source change, re-measure and review the diff, never drop it.
ADD --checksum=sha256:70b2cea3f5e43bcec485a341b83cb2720faa395017a63574179edee08f573644 \
    https://github.com/NVIDIA/personaplex/archive/16419a2ef7b98611f58c9df07477d00e5ad61d5f.tar.gz /src/personaplex.tar.gz
RUN mkdir -p /src/personaplex \
 && tar -xzf /src/personaplex.tar.gz -C /src/personaplex --strip-components=1
# Exact versions resolved from moshi/pyproject.toml @16419a2e for CPython 3.12 manylinux x86_64,
# one sha256 per wheel taken from PyPI (torch 2.4.1 bundles CUDA 12.1 user-space libraries).
COPY <<"PINS" /src/renderer.requirements.txt
aiohappyeyeballs==2.7.1 --hash=sha256:9243213661e29250eb41368e5daa826fc017156c3b8a11440826b2e3ed376472
aiohttp==3.10.11 --hash=sha256:bc6f1ab987a27b83c5268a17218463c2ec08dbb754195113867a27b166cd6087
aiosignal==1.4.0 --hash=sha256:053243f8b92b990551949e63930a839ff0cf0b0ebbe0597b0f3fb19e1a0fe82e
attrs==26.1.0 --hash=sha256:c647aa4a12dfbad9333ca4e71fe62ddc36f4e63b2d260a37a8b83d2f043ac309
certifi==2026.10.23 --hash=sha256:e9b54de76e530bb6cf0ccd036787103acb58fd42ba930ea8bf948ddbaa2f61d1
cffi==2.1.1 --hash=sha256:c1453022f490d2459a11819d83ad1d586e9ff65a12ac3e705ffebd46d3685dcf
charset-normalizer==3.5.2 --hash=sha256:3d31298449090ab8d47b7b1b2a555ff73cac7ed438a08b7ac160980c7ebed649 --hash=sha256:b6b751274acb69d77b3323d6b7dbaa3c7fdfc1eb829b7eb61d262f32e1af9685
einops==0.7.0 --hash=sha256:0f3096f26b914f465f6ff3c66f5478f9a5e380bb367ffc6493a68143fbbf1fd1
filelock==4.2.10 --hash=sha256:9479aaeb4db20b5a53e3da28493edd24720b66b8a0b84030aa56ccdf243d6857
frozenlist==1.8.0 --hash=sha256:494a5952b1c597ba44e0e78113a7266e656b9794eec897b19ead706bd7074383 --hash=sha256:0c18a16eab41e82c295618a77502e17b195883241c563b00f0aa5106fc4eaa0d
fsspec==2026.9.0 --hash=sha256:8dd6e646e99ea382bd85f97a45e6b526a442d79423a7dc673f1e2756d05fcb5f
huggingface-hub==0.24.7 --hash=sha256:a212c555324c8a7b1ffdd07266bb7e7d69ca71aa238d27b7842d65e9a26ac3e5
idna==3.20 --hash=sha256:ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c
jinja2==3.1.6 --hash=sha256:85ece4451f492d0c13c5dd7c13a64681a86afae63a5f347908daf103ce6d2f67
markupsafe==3.0.4 --hash=sha256:8e124f974786f831d6043728e38296969d3579db8896fe004682f5758e613581
mpmath==1.3.0 --hash=sha256:a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c
multidict==6.9.1 --hash=sha256:976fd7689d69ec78d67d31d38d396d8adb562f7e8368279f76aed4aa451fa06d --hash=sha256:7bf6478188f4e47bf5686e8a33da4ae28bf43b1b2528d9ee144d28492bfac60b
networkx==3.7 --hash=sha256:e3fd2c13a7814cee3746340d8d7f8598a67f16a58bf47fb7f8793fab6efca1b0
numpy==2.1.3 --hash=sha256:2312b2aa89e1f43ecea6da6ea9a810d06aae08321609d8dc0d0eda6d946a541b
nvidia-cublas-cu12==12.1.3.1 --hash=sha256:ee53ccca76a6fc08fb9701aa95b6ceb242cdaab118c3bb152af4e579af792728
nvidia-cuda-cupti-cu12==12.1.105 --hash=sha256:e54fde3983165c624cb79254ae9818a456eb6e87a7fd4d56a2352c24ee542d7e
nvidia-cuda-nvrtc-cu12==12.1.105 --hash=sha256:339b385f50c309763ca65456ec75e17bbefcbbf2893f462cb8b90584cd27a1c2
nvidia-cuda-runtime-cu12==12.1.105 --hash=sha256:6e258468ddf5796e25f1dc591a31029fa317d97a0a94ed93468fc86301d61e40
nvidia-cudnn-cu12==9.1.0.70 --hash=sha256:165764f44ef8c61fcdfdfdbe769d687e06374059fbb388b6c89ecb0e28793a6f
nvidia-cufft-cu12==11.0.2.54 --hash=sha256:794e3948a1aa71fd817c3775866943936774d1c14e7628c74f6f7417224cdf56
nvidia-curand-cu12==10.3.2.106 --hash=sha256:9d264c5036dde4e64f1de8c50ae753237c12e0b1348738169cd0f8a536c0e1e0
nvidia-cusolver-cu12==11.4.5.107 --hash=sha256:8a7ec542f0412294b15072fa7dab71d31334014a69f953004ea7a118206fe0dd
nvidia-cusparse-cu12==12.1.0.106 --hash=sha256:f3b50f42cf363f86ab21f720998517a659a48131e8d538dc02f8768237bd884c
nvidia-nccl-cu12==2.20.5 --hash=sha256:057f6bf9685f75215d0c53bf3ac4a10b3e6578351de307abad9e18a99182af56
nvidia-nvjitlink-cu12==12.9.86 --hash=sha256:e3f1171dbdc83c5932a45f0f4c99180a70de9bd2718c1ab77d14104f6d7147f9
nvidia-nvtx-cu12==12.1.105 --hash=sha256:dc21cf308ca5691e7c04d962e213f8a4aa9bbfa23d95412f452254c2caeb09e5
packaging==26.3 --hash=sha256:d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c
propcache==0.5.4 --hash=sha256:2814ecd8e818f487bee4b0f921bc4d1c176cc5fc71ac0f072d0fa67eda4ac14b --hash=sha256:62c60aec739ed00124573cce1178138fd690c7676352d67a37328c1cf51d7468
pycparser==3.12 --hash=sha256:a076f3f489b39b43ed13563a1dafe42447445bec2e294154ec5c57fcdda4c85e
pyyaml==6.0.3 --hash=sha256:ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc
requests==2.34.2 --hash=sha256:2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0
safetensors==0.4.5 --hash=sha256:3685ce7ed036f916316b567152482b7e959dc754fcc4a8342333d222e05f407c
sentencepiece==0.2.0 --hash=sha256:f295105c6bdbb05bd5e1b0cafbd78ff95036f5d3641e7949455a3f4e5e7c3109
setuptools==84.2.1 --hash=sha256:ca140b45d5325a9478f880e351484f62fef15f336462e449ca0c03c873d589c2
sounddevice==0.5.0 --hash=sha256:8a734043ab1f751cb20f6f25d8f07408a1aadf2eeca923061849d38bb59f9e3d
sphn==0.1.12 --hash=sha256:7f5a33fce17cada06e02638d96a14ca7123fb5ea6155d79879520e6ce7285040
sympy==1.14.0 --hash=sha256:e091cc3e99d2141a0ba2847328f5479b05d94a6635cb96148ccb3f34671bd8f5
torch==2.4.1 --hash=sha256:fdc4fe11db3eb93c1115d3e973a27ac7c1a8318af8934ffa36b0370efe28e042
tqdm==4.70.1 --hash=sha256:c293e525e6fef9c20e8728fd4612df02a0aa31bb5fe91ecd93e123b1b7bffa73
triton==3.0.0 --hash=sha256:34e509deb77f1c067d8640725ef00c5cbfcb2052a1a3cb6a6d343841f92624eb
typing-extensions==4.16.0 --hash=sha256:481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8
urllib3==2.8.0 --hash=sha256:0cf3cae568d36aa9576b28dfb35f11328f1cb974ca7647d9475ebb86c75ac6e3
yarl==1.25.1 --hash=sha256:c6f117789d22dce188e5754e8bc65b7e6ebf8cb73963b9fa761f672a5883769d --hash=sha256:681c758b0490f9e96b78e5fa8e8dc6e648e9185bb6eaebe73183c33ea0c445f3
PINS

RUN uv venv /opt/venv --python 3.12.11 \
 && VIRTUAL_ENV=/opt/venv uv pip install --require-hashes --only-binary :all: -r /src/renderer.requirements.txt \
 && VIRTUAL_ENV=/opt/venv uv pip install --no-deps --no-build-isolation /src/personaplex/moshi \
 && VIRTUAL_ENV=/opt/venv uv pip check \
 && /opt/venv/bin/python -c "import torch, sphn, sentencepiece, huggingface_hub, moshi.models.loaders" \
 && /opt/venv/bin/python -m moshi.server --help > /src/moshi-server-help.txt \
 && grep -q -- --max-pinned-frames /src/moshi-server-help.txt \
 && grep -q -- --voice-prompt-dir /src/moshi-server-help.txt \
 && grep -q -- --static /src/moshi-server-help.txt

# ---------------------------------------------------------------------------------------------
FROM ${CUDA_IMAGE} AS renderer
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends libopus0 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin voice \
 && mkdir -p /models \
 && chown 10001:10001 /models
COPY --from=renderer-build /opt/python /opt/python
COPY --from=renderer-build /opt/venv /opt/venv
COPY --chmod=0555 <<"LAUNCH" /opt/voice/launch.sh
#!/bin/sh
# Renderer entrypoint (stock NVIDIA/personaplex moshi.server). The renderer needs NO credential:
# weights are pre-fetched into a read-only volume and HF_HUB_OFFLINE=1. This refuses to start if
# any unexpected variable, credential-shaped value, or token file is present.
# "launch.sh --check-env" runs only those refusals (used as a build step) and exits 0.
set -eu

env | cut -d= -f1 | while IFS= read -r name; do
  case "$name" in
    PATH|HOME|HOSTNAME|PWD|SHLVL|_|TERM|HF_HOME|HF_HUB_OFFLINE|HF_HUB_DISABLE_TELEMETRY|NO_TORCH_COMPILE|\
    PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|XDG_CACHE_HOME|TORCH_FORCE_WEIGHTS_ONLY_LOAD|\
    PERSONAPLEX_VOICE_DIR|PERSONAPLEX_MAX_PINNED_FRAMES|OMP_NUM_THREADS|MKL_NUM_THREADS|\
    OPENBLAS_NUM_THREADS|RAYON_NUM_THREADS|LD_LIBRARY_PATH|LIBRARY_PATH|NVARCH|CUDA_VERSION|\
    NCCL_VERSION|NVIDIA_*|NV_*) ;;
    *) echo "launch: refusing to start, unexpected variable: $name" >&2; exit 64 ;;
  esac
done || exit 64

if env | grep -Eq '(hf_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|eyJ[A-Za-z0-9_-]{10,}\.|BEGIN [A-Z ]*PRIVATE KEY)'; then
  echo "launch: refusing to start, credential-shaped value present" >&2; exit 64
fi
for f in /models/token /models/stored_tokens /run/secrets "$HOME/.cache/huggingface/token"; do
  [ ! -e "$f" ] || { echo "launch: refusing to start, credential file present: $f" >&2; exit 64; }
done
[ "${HF_HUB_OFFLINE:-}" = "1" ] || { echo "launch: HF_HUB_OFFLINE must be 1" >&2; exit 64; }
[ "${1:-}" != "--check-env" ] || exit 0

VOICE_DIR="${PERSONAPLEX_VOICE_DIR:-/models/voices}"
# The trusted pin is the reviewed copy mounted read-only from the host (/etc/aukora/voice-pin), NOT
# the one on the weights volume: whoever can rewrite a voice file there could rewrite that pin too.
PIN=/etc/voice-pin/PINNED-REVISION.json
[ -r "$PIN" ] || { echo "launch: $PIN missing; mount the reviewed pin (README step 2)" >&2; exit 66; }
# Re-verify every voice file against the reviewed hashes (voice .pt files are loaded with
# torch.load, i.e. pickle: lm.py load_voice_prompt_embeddings).
python - "$PIN" "$VOICE_DIR" <<'PY' || exit 65
import hashlib, json, sys, pathlib
pin, voices = json.load(open(sys.argv[1])), pathlib.Path(sys.argv[2])
need = {f"{k}{g}{i}.pt" for k in ("NAT", "VAR") for g in "FM" for i in range(4)}
recorded = pin.get("voiceSha256", {})
missing = sorted(need - set(recorded))
if missing:
    sys.exit("launch: voices missing from pin: " + ",".join(missing))
for name, digest in recorded.items():
    if hashlib.sha256((voices / name).read_bytes()).hexdigest() != digest:
        sys.exit("launch: voice hash mismatch: " + name)
PY

# --host is only the log banner upstream (server.py never passes it to web.run_app, which binds all
# interfaces); a non-wildcard value skips get_lan_ip()'s UDP probe to 8.8.8.8, which fails on an
# internal network. --static none: do not serve or download the bundled web UI (dist.tgz).
exec python -m moshi.server \
  --host renderer \
  --port 8998 \
  --static none \
  --voice-prompt-dir "$VOICE_DIR" \
  --max-pinned-frames "${PERSONAPLEX_MAX_PINNED_FRAMES:-512}"
LAUNCH

COPY --chmod=0444 <<"HEALTH" /opt/voice/healthcheck.py
"""Renderer liveness. moshi.server has no health route, and a bare TCP accept stays green while the
event loop is wedged, so require an actual HTTP response (404 is fine: --static none) within 3 s."""
import http.client
import sys

try:
    conn = http.client.HTTPConnection("127.0.0.1", 8998, timeout=3)
    conn.request("GET", "/")
    conn.getresponse().read(64)
except Exception:  # noqa: BLE001
    sys.exit(1)
sys.exit(0)
HEALTH

COPY --chmod=0444 <<"FETCH" /opt/voice/fetch_weights.py
"""One-shot weight fetch into the HF cache volume. Never run by the serving container.

The HuggingFace token arrives on stdin (no file mount, no env var, no argv). A full 40-hex HF commit
is required. Downloads exactly what moshi.server loads (SOURCE: moshi/moshi/models/loaders.py:60-63,
server.py _get_voice_prompt_dir), verifies optional expected hashes, extracts voices.tgz with a strict
member allow-list and tarfile's "data" filter, points refs/main at the commit so the offline server
resolves the same bytes, and records per-file and per-voice sha256 in PINNED-REVISION.json, which
launch.sh re-verifies on every start.
"""
import hashlib
import json
import os
import re
import sys
import tarfile
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download

REPO = "nvidia/personaplex-7b-v1"
FILES = ["config.json", "model.safetensors", "tokenizer-e351c8d8-checkpoint125.safetensors",
         "tokenizer_spm_32k_3.model", "voices.tgz"]
MODELS = Path(os.environ.get("HF_HOME", "/models"))
VOICES = {f"{k}{g}{i}.pt" for k in ("NAT", "VAR") for g in "FM" for i in range(4)}
MEMBER = re.compile(r"(?:\./)?voices(?:/[A-Za-z0-9_-]+\.(?:pt|wav))?/?")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    token = sys.stdin.read().strip()
    if not token:
        sys.exit("pipe the HuggingFace token on stdin")
    revision = os.environ.get("PERSONAPLEX_HF_REVISION", "").strip()
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        sys.exit("PERSONAPLEX_HF_REVISION must be a full 40-hex HF commit sha")
    if HfApi().model_info(REPO, revision=revision, token=token).sha != revision:
        sys.exit("HF did not resolve the requested commit")
    expected = json.loads(os.environ.get("PERSONAPLEX_EXPECTED_SHA256", "{}") or "{}")
    paths = {name: hf_hub_download(REPO, name, revision=revision, token=token) for name in FILES}
    del token
    files = {name: sha256(path) for name, path in paths.items()}
    for name, digest in expected.items():
        if files.get(name) != digest:
            sys.exit("sha256 mismatch for %s" % name)
    refs = MODELS / "hub" / ("models--" + REPO.replace("/", "--")) / "refs"
    refs.mkdir(parents=True, exist_ok=True)
    (refs / "main").write_text(revision, encoding="utf-8")  # no trailing newline: read unstripped
    with tarfile.open(paths["voices.tgz"], "r:gz") as tar:
        members = tar.getmembers()
        for member in members:
            if not (member.isfile() or member.isdir()) or not MEMBER.fullmatch(member.name):
                sys.exit("unexpected member in voices.tgz: %r" % member.name)
        tar.extractall(MODELS, members=members, filter="data")
    voices_dir = MODELS / "voices"
    present = {p.name for p in voices_dir.iterdir()} if voices_dir.is_dir() else set()
    missing = sorted(VOICES - present)
    if missing:
        sys.exit("voices.tgz is missing allow-listed voices: " + ",".join(missing))
    pinned = {"repo": REPO, "revision": revision, "files": files,
              "voiceSha256": {name: sha256(voices_dir / name) for name in sorted(VOICES)}}
    (MODELS / "PINNED-REVISION.json").write_text(json.dumps(pinned, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"revision": revision, "files": files}, indent=2))


if __name__ == "__main__":
    main()
FETCH

ENV PATH=/opt/venv/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    HF_HOME=/models \
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    NO_TORCH_COMPILE=1 \
    TORCH_FORCE_WEIGHTS_ONLY_LOAD=1 \
    OMP_NUM_THREADS=8 \
    MKL_NUM_THREADS=8 \
    OPENBLAS_NUM_THREADS=8 \
    RAYON_NUM_THREADS=8 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
USER 10001:10001
RUN ["/opt/voice/launch.sh", "--check-env"]
EXPOSE 8998
HEALTHCHECK --interval=30s --timeout=5s --start-period=900s --retries=3 \
  CMD ["python", "/opt/voice/healthcheck.py"]
ENTRYPOINT ["/opt/voice/launch.sh"]

# ---------------------------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS gateway-base
COPY <<"PINS" /tmp/gateway.requirements.txt
aiohappyeyeballs==2.7.1 --hash=sha256:9243213661e29250eb41368e5daa826fc017156c3b8a11440826b2e3ed376472
aiohttp==3.14.5 --hash=sha256:20f085697d7e911f1f73c43ed03fafbed1e7121797e2eb5428efa80398060584 --hash=sha256:efc21a454892828368b11c2c780de0ff8bc991f73f6b99c6b66e56205470929b
aiosignal==1.4.0 --hash=sha256:053243f8b92b990551949e63930a839ff0cf0b0ebbe0597b0f3fb19e1a0fe82e
attrs==26.1.0 --hash=sha256:c647aa4a12dfbad9333ca4e71fe62ddc36f4e63b2d260a37a8b83d2f043ac309
frozenlist==1.8.0 --hash=sha256:494a5952b1c597ba44e0e78113a7266e656b9794eec897b19ead706bd7074383 --hash=sha256:0c18a16eab41e82c295618a77502e17b195883241c563b00f0aa5106fc4eaa0d
idna==3.20 --hash=sha256:ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c
multidict==7.2.1 --hash=sha256:1fb8c1a3480c130c3a6422d5f16f3cad6552bf08c2089dd288ba7134649183b5 --hash=sha256:08ea94663d9e7c25d14d78222f7aee906c472d4837766bec62477c38f6e419dc
propcache==0.5.4 --hash=sha256:2814ecd8e818f487bee4b0f921bc4d1c176cc5fc71ac0f072d0fa67eda4ac14b --hash=sha256:62c60aec739ed00124573cce1178138fd690c7676352d67a37328c1cf51d7468
typing-extensions==4.16.0 --hash=sha256:481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8
yarl==1.25.1 --hash=sha256:c6f117789d22dce188e5754e8bc65b7e6ebf8cb73963b9fa761f672a5883769d --hash=sha256:681c758b0490f9e96b78e5fa8e8dc6e648e9185bb6eaebe73183c33ea0c445f3
PINS

RUN pip install --no-cache-dir --require-hashes --only-binary :all: -r /tmp/gateway.requirements.txt \
 && rm /tmp/gateway.requirements.txt \
 && useradd --uid 10002 --user-group --no-create-home --shell /usr/sbin/nologin gateway
COPY --chmod=0444 <<"GATEWAY" /opt/gateway/gateway.py
"""Authenticating WebSocket gateway in front of a stock PersonaPlex `moshi.server`.

Why this exists (SOURCE: NVIDIA/personaplex@16419a2e moshi/moshi/server.py):
  * `web.run_app(app, port=...)` never receives `--host`, so moshi.server binds every interface
    and has no authentication of its own. It must never be reachable except through this gateway.
  * `/api/chat` reads `request.query["voice_prompt"]` and `request.query["text_prompt"]`
    unconditionally (KeyError if absent) and joins `voice_prompt` onto the voice directory with
    `os.path.join`, so a raw client could name any `.pt` path on disk. `seed` is read from
    `request["seed"]` (not the query), which raises when a client sends `?seed=`.
  * The your-node Worker (`deploy/cloudflare/src/voice-director.mjs`, handleEdgeVoiceRequest)
    sends `?voice=<ID>&mode=forced_text_stream[&turnId=...]` plus
    `Authorization: Bearer <PERSONAPLEX_AUTH_TOKEN>`. Stock moshi.server understands none of it.

This gateway therefore:
  1. authenticates the bearer token against a SHA-256 digest (the token itself is never stored here);
  2. accepts only GET /api/chat with exactly the Worker's query keys, a voice from the fixed
     16-voice allow-list, and the voice-director protocol/authority headers;
  3. ALWAYS refuses `mode=forced_text_stream` with 501: a stock moshi.server cannot force the text
     stream, it would generate its own words, which breaks invariant 1 of aukora.voice-director.v1
     (the Brain is the sole author). Unforced speech is only reachable through the distinct
     `mode=free_render_unforced`, which the Worker never sends, and only when
     PERSONAPLEX_ALLOW_FREE_RENDER=1 (a labelled Slice-1 "hear it" session);
  4. rebuilds the upstream request from scratch (voice_prompt=<ID>.pt, text_prompt from a mounted
     non-secret persona file, never seed, never any client header);
  5. waits for the renderer's 0x00 handshake before upgrading the client (so a missing voice or a
     hung renderer is a 502, not "101 then close");
  6. relays only kind 0x01 (Opus) upstream, rate-limited with an idle timeout, and only kinds
     0x00/0x01 downstream (the model's own 0x02 text tokens never reach the client); caps frame
     size and session length; allows one session at a time (upstream mutates lm_gen prompts before
     taking its own lock, so a second session would corrupt the first).
It logs no tokens, no prompts and no transcript text.
"""
import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import sys
import time
from urllib.parse import parse_qsl, urlencode, urlsplit

import aiohttp
from aiohttp import web

PROTOCOL = "aukora.voice-director.v1"
# Must stay identical to PERSONAPLEX_VOICES in deploy/cloudflare/src/voice-director.mjs
# (upstream also ships VARF4/VARM4; the Worker deliberately exposes 16).
VOICES = frozenset(
    [f"NAT{g}{i}" for g in "FM" for i in range(4)] + [f"VAR{g}{i}" for g in "FM" for i in range(4)]
)
TURN_ID_RE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
HEX64_RE = re.compile(r"[0-9a-f]{64}")
ALLOWED_QUERY_KEYS = frozenset({"voice", "mode", "turnId"})
MODES = frozenset({"forced_text_stream", "free_render_unforced"})
KIND_HANDSHAKE, KIND_AUDIO = 0x00, 0x01
MAX_CLIENT_FRAME_BYTES = 4096
MAX_UPSTREAM_FRAME_BYTES = 1 << 20
MAX_TEXT_PROMPT_BYTES = 1200  # pinned-prompt budget: --max-pinned-frames 512 incl. voice frames
MIN_TOKEN_CHARS, MAX_TOKEN_CHARS = 43, 512  # >= 32 random bytes base64; digest is unsalted
RATE_BYTES_PER_S, BURST_BYTES, IDLE_SECONDS = 12_000, 36_000, 20
CLOSING = (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED,
           aiohttp.WSMsgType.ERROR)

log = logging.getLogger("voice-gateway")


class Config:
    def __init__(self, env=os.environ):
        # Comma-separated list so the Worker token can be rotated without downtime.
        digests = [d.strip().lower() for d in env.get("GATEWAY_TOKEN_SHA256", "").split(",") if d.strip()]
        if not digests or not all(HEX64_RE.fullmatch(d) for d in digests) or len(digests) > 4:
            raise SystemExit("GATEWAY_TOKEN_SHA256 must be 1-4 comma-separated 64-hex SHA-256 digests")
        self.token_digests = [bytes.fromhex(d) for d in digests]
        self.upstream = env.get("PERSONAPLEX_UPSTREAM", "ws://renderer:8998/api/chat")
        parts = urlsplit(self.upstream)
        if parts.scheme not in ("ws", "wss") or not parts.hostname or parts.query or parts.username:
            raise SystemExit("PERSONAPLEX_UPSTREAM must be a plain ws:// or wss:// URL")
        self.upstream_host = parts.hostname
        self.upstream_port = parts.port or (443 if parts.scheme == "wss" else 80)
        self.allow_free_render = env.get("PERSONAPLEX_ALLOW_FREE_RENDER", "0") == "1"
        self.max_session_seconds = int(env.get("GATEWAY_MAX_SESSION_SECONDS", "900"))
        self.listen_host = env.get("GATEWAY_LISTEN_HOST", "0.0.0.0")
        self.listen_port = int(env.get("GATEWAY_LISTEN_PORT", "8080"))
        self.health_port = int(env.get("GATEWAY_HEALTH_PORT", "8081"))
        prompt_file = env.get("PERSONAPLEX_TEXT_PROMPT_FILE", "/etc/voice/text-prompt.txt")
        with open(prompt_file, "rb") as handle:
            raw = handle.read(MAX_TEXT_PROMPT_BYTES + 1)
        if len(raw) > MAX_TEXT_PROMPT_BYTES:
            raise SystemExit("persona text prompt exceeds %d bytes" % MAX_TEXT_PROMPT_BYTES)
        self.text_prompt = raw.decode("utf-8").strip()


def deny(status, code):
    return web.json_response({"ok": False, "code": code}, status=status,
                             headers={"cache-control": "no-store"})


def bearer_ok(header_value, digests):
    if not isinstance(header_value, str) or not header_value.startswith("Bearer "):
        return False
    presented = header_value[len("Bearer "):].strip()
    if not MIN_TOKEN_CHARS <= len(presented) <= MAX_TOKEN_CHARS:
        return False
    actual = hashlib.sha256(presented.encode("utf-8")).digest()
    ok = False
    for digest in digests:  # no early exit: constant work across the list
        ok |= hmac.compare_digest(actual, digest)
    return ok


def parse_query(raw_query):
    """Return (params, error_code). Rejects unknown or duplicated keys."""
    pairs = parse_qsl(raw_query, keep_blank_values=True, strict_parsing=False)
    seen = {}
    for key, value in pairs:
        if key not in ALLOWED_QUERY_KEYS:
            return None, "VOICE_QUERY_INVALID"
        if key in seen:
            return None, "VOICE_QUERY_DUPLICATE"
        seen[key] = value
    voice = seen.get("voice")
    if voice not in VOICES:
        return None, "VOICE_ID_UNSUPPORTED"
    mode = seen.get("mode")
    if mode not in MODES:
        return None, "VOICE_MODE_INVALID"
    turn_id = seen.get("turnId")
    if turn_id is not None and not TURN_ID_RE.fullmatch(turn_id):
        return None, "VOICE_TURN_ID_INVALID"
    return {"voice": voice, "mode": mode, "turnId": turn_id}, None


def upstream_url(config, voice):
    # Rebuilt from scratch: nothing from the client query except the allow-listed voice id.
    query = urlencode({"voice_prompt": voice + ".pt", "text_prompt": config.text_prompt})
    return config.upstream + "?" + query


class Gateway:
    def __init__(self, config, session_factory=None):
        self.config = config
        self.busy = asyncio.Lock()
        self.session_factory = session_factory or (lambda: aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=None, connect=5, sock_connect=5)))

    async def handle_chat(self, request):
        if not bearer_ok(request.headers.get("Authorization"), self.config.token_digests):
            log.info(json.dumps({"event": "auth_fail", "ray": (request.headers.get("cf-ray") or "")[:64]}))
            return deny(401, "VOICE_GATEWAY_UNAUTHORIZED")
        if request.headers.get("x-aukora-voice-protocol") != PROTOCOL:
            return deny(400, "VOICE_PROTOCOL_INVALID")
        if request.headers.get("x-aukora-voice-authority") != "none":
            return deny(400, "VOICE_AUTHORITY_INVALID")
        params, error = parse_query(request.rel_url.raw_query_string)
        if error:
            return deny(400, error)
        if params["mode"] == "forced_text_stream":
            # Stock moshi.server cannot be forced to speak only Brain-approved clauses. Always.
            return deny(501, "VOICE_FORCED_TEXT_STREAM_UNAVAILABLE")
        if not self.config.allow_free_render:
            return deny(403, "VOICE_FREE_RENDER_DISABLED")
        if request.headers.get("Upgrade", "").lower() != "websocket":
            return deny(426, "WEBSOCKET_UPGRADE_REQUIRED")
        if self.busy.locked():
            return deny(503, "VOICE_RENDERER_BUSY")
        async with self.busy:
            return await self._relay(request, params)

    async def _relay(self, request, params):
        client = web.WebSocketResponse(max_msg_size=MAX_CLIENT_FRAME_BYTES, heartbeat=20, compress=False)
        started = time.monotonic()
        async with self.session_factory() as session:
            try:
                upstream = await asyncio.wait_for(session.ws_connect(
                    upstream_url(self.config, params["voice"]),
                    max_msg_size=MAX_UPSTREAM_FRAME_BYTES, heartbeat=None), 10)
                first = await upstream.receive(timeout=60)
                if first.type != aiohttp.WSMsgType.BINARY or first.data != bytes([KIND_HANDSHAKE]):
                    raise RuntimeError("no renderer handshake")
            except Exception:  # noqa: BLE001 - never echo upstream error detail
                return deny(502, "VOICE_RENDERER_UNAVAILABLE")
            await client.prepare(request)
            await client.send_bytes(bytes([KIND_HANDSHAKE]))
            log.info(json.dumps({"event": "session_open", "voice": params["voice"],
                                 "turnId": params["turnId"]}))

            async def client_to_upstream():
                budget, last = BURST_BYTES, time.monotonic()
                while True:
                    message = await asyncio.wait_for(client.receive(), IDLE_SECONDS)
                    if message.type in CLOSING:
                        return
                    if message.type != aiohttp.WSMsgType.BINARY:
                        continue  # only binary Opus frames cross; text/control is dropped
                    data = message.data
                    if not data or data[0] != KIND_AUDIO:
                        continue
                    now = time.monotonic()
                    budget = min(BURST_BYTES, budget + (now - last) * RATE_BYTES_PER_S) - len(data)
                    last = now
                    if budget < 0:  # faster than real time: would wedge the renderer backlog
                        await client.close(code=1008, message=b"rate")
                        return
                    await upstream.send_bytes(data)

            async def upstream_to_client():
                async for message in upstream:
                    if message.type == aiohttp.WSMsgType.BINARY:
                        if message.data[:1] == bytes([KIND_AUDIO]):  # never the model's 0x02 text
                            await client.send_bytes(message.data)
                    elif message.type in CLOSING:
                        break

            tasks = [asyncio.ensure_future(client_to_upstream()),
                     asyncio.ensure_future(upstream_to_client())]
            try:
                await asyncio.wait(tasks, timeout=self.config.max_session_seconds,
                                   return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                await upstream.close()
                await client.close()
                log.info(json.dumps({"event": "session_close", "voice": params["voice"],
                                     "seconds": round(time.monotonic() - started, 1)}))
        return client

    async def handle_other(self, request):
        return deny(404, "NOT_FOUND")


def build_app(gateway):
    app = web.Application(client_max_size=1024)
    app.router.add_get("/api/chat", gateway.handle_chat)
    app.router.add_route("*", "/{tail:.*}", gateway.handle_other)
    return app


def build_health_app(config):
    async def healthz(_request):
        try:
            _reader, writer = await asyncio.wait_for(
                asyncio.open_connection(config.upstream_host, config.upstream_port), 2)
            writer.close()
            return web.json_response({"ok": True})
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False}, status=503)

    app = web.Application()
    app.router.add_get("/healthz", healthz)
    return app


async def serve(config):
    gateway = Gateway(config)
    main_runner = web.AppRunner(build_app(gateway), access_log=None)
    health_runner = web.AppRunner(build_health_app(config), access_log=None)
    await main_runner.setup()
    await health_runner.setup()
    await web.TCPSite(main_runner, config.listen_host, config.listen_port).start()
    # Health is loopback-only so it is never reachable through the tunnel.
    await web.TCPSite(health_runner, "127.0.0.1", config.health_port).start()
    log.info(json.dumps({"event": "listening", "port": config.listen_port,
                         "freeRender": config.allow_free_render}))
    await asyncio.Event().wait()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")
    asyncio.run(serve(Config()))
GATEWAY

# Non-secret persona for the free-render demo only. Kept <= 1200 bytes (pinned-prompt budget).
COPY --chmod=0444 <<"PERSONA" /etc/voice/text-prompt.txt
You are the voice of Auma. You do not know any facts about Auma, her memory, her epochs, receipts or code. Never state a number, a version, a hash, a date or a promise. If asked anything factual, say only "one moment" and wait. You may say "mm-hm", "right" or "one sec".
PERSONA

# ---------------------------------------------------------------------------------------------
FROM gateway-base AS gateway-test
COPY <<"TESTS" /opt/gateway/test_gateway.py
"""Offline tests for gateway.py (no GPU, no network beyond loopback).

Runs as the gateway-test build stage: python /opt/gateway/test_gateway.py (stdlib unittest; the
image's hash-pinned aiohttp is the only dependency).
"""
import asyncio
import hashlib
import os
import sys
import tempfile
import unittest

from aiohttp import WSMsgType, web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gateway  # noqa: E402

TOKEN = "test-token-not-a-secret-" + "x" * 32
TOKEN2 = "rotated-token-not-a-secret-" + "y" * 32
GOOD = {"Authorization": "Bearer " + TOKEN, "x-aukora-voice-protocol": gateway.PROTOCOL,
        "x-aukora-voice-authority": "none"}
QUERY = "/api/chat?voice=NATF1&mode=free_render_unforced&turnId=t-1"
FORCED = "/api/chat?voice=NATF1&mode=forced_text_stream&turnId=t-1"


class FakeUpstream:
    def __init__(self):
        self.requests = []
        self.received = []

    async def chat(self, request):
        self.requests.append({"query": dict(request.query), "headers": dict(request.headers)})
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_bytes(b"\x00")
        async for message in ws:
            if message.type == WSMsgType.BINARY:
                self.received.append(message.data)
                await ws.send_bytes(b"\x02model-text-must-not-reach-client")
                await ws.send_bytes(b"\x01echo")
            elif message.type == WSMsgType.TEXT:
                self.received.append(("text", message.data))
        return ws


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        prompt = os.path.join(self.tmp.name, "prompt.txt")
        with open(prompt, "w", encoding="utf-8") as handle:
            handle.write("persona prompt\n")
        self.fake = FakeUpstream()
        upstream_app = web.Application()
        upstream_app.router.add_get("/api/chat", self.fake.chat)
        self.upstream = TestServer(upstream_app)
        await self.upstream.start_server()
        self.env = {"GATEWAY_TOKEN_SHA256": hashlib.sha256(TOKEN.encode()).hexdigest(),
                    "PERSONAPLEX_UPSTREAM": "ws://127.0.0.1:%d/api/chat" % self.upstream.port,
                    "PERSONAPLEX_TEXT_PROMPT_FILE": prompt, "PERSONAPLEX_ALLOW_FREE_RENDER": "1"}

    async def asyncTearDown(self):
        await self.upstream.close()
        self.tmp.cleanup()

    async def client(self, **overrides):
        env = dict(self.env, **overrides)
        app = gateway.build_app(gateway.Gateway(gateway.Config(env)))
        client = TestClient(TestServer(app))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        return client

    async def test_missing_and_wrong_bearer_are_401(self):
        client = await self.client()
        for headers in ({}, dict(GOOD, Authorization="Bearer nope"), dict(GOOD, Authorization=TOKEN),
                        dict(GOOD, Authorization="Basic " + TOKEN)):
            response = await client.get(QUERY, headers=headers)
            self.assertEqual(response.status, 401)
        self.assertEqual(self.fake.requests, [])

    async def test_protocol_and_authority_headers_are_required(self):
        client = await self.client()
        for key, value in (("x-aukora-voice-protocol", "other"), ("x-aukora-voice-authority", "owner")):
            response = await client.get(QUERY, headers=dict(GOOD, **{key: value}))
            self.assertEqual(response.status, 400)

    async def test_query_allow_list(self):
        client = await self.client()
        bad = ["/api/chat?voice=NATF1&mode=free_render_unforced&seed=1",
               "/api/chat?voice=NATF1&voice=NATM0&mode=forced_text_stream",
               "/api/chat?voice=../../etc/passwd&mode=forced_text_stream",
               "/api/chat?voice=/abs/evil&mode=forced_text_stream",
               "/api/chat?voice=VARF4&mode=forced_text_stream",
               "/api/chat?voice=NATF1&mode=free",
               "/api/chat?voice=NATF1&mode=free_render_unforced&turnId=abc%0A",
               "/api/chat?voice=NATF1",
               "/api/chat?voice=NATF1&mode=forced_text_stream&turnId=" + "x" * 129,
               "/api/chat?voice=NATF1&mode=forced_text_stream&text_prompt=hi",
               "/api/chat?voice=NATF1&mode=forced_text_stream&voice_prompt=x.pt"]
        for path in bad:
            response = await client.get(path, headers=GOOD)
            self.assertEqual(response.status, 400, path)
        self.assertEqual(self.fake.requests, [])

    async def test_forced_text_stream_is_always_501_on_stock_renderer(self):
        for flag in ("0", "1"):
            client = await self.client(PERSONAPLEX_ALLOW_FREE_RENDER=flag)
            response = await client.get(FORCED, headers=dict(GOOD, Upgrade="websocket", Connection="Upgrade"))
            self.assertEqual(response.status, 501)
            self.assertEqual((await response.json())["code"], "VOICE_FORCED_TEXT_STREAM_UNAVAILABLE")
        self.assertEqual(self.fake.requests, [])

    async def test_free_render_needs_the_flag(self):
        client = await self.client(PERSONAPLEX_ALLOW_FREE_RENDER="0")
        response = await client.get(QUERY, headers=GOOD)
        self.assertEqual(response.status, 403)
        self.assertEqual(self.fake.requests, [])

    async def test_rotated_token_list_accepts_both(self):
        both = hashlib.sha256(TOKEN.encode()).hexdigest() + "," + hashlib.sha256(TOKEN2.encode()).hexdigest()
        client = await self.client(GATEWAY_TOKEN_SHA256=both, PERSONAPLEX_ALLOW_FREE_RENDER="0")
        for token in (TOKEN, TOKEN2):
            response = await client.get(QUERY, headers=dict(GOOD, Authorization="Bearer " + token))
            self.assertEqual(response.status, 403)  # authenticated, then free render refused
        response = await client.get(QUERY, headers=dict(GOOD, Authorization="Bearer short"))
        self.assertEqual(response.status, 401)

    async def test_faster_than_real_time_audio_is_cut(self):
        client = await self.client()
        ws = await client.ws_connect(QUERY, headers=GOOD)
        await ws.receive()
        for _ in range(20):
            if ws.closed:
                break
            await ws.send_bytes(b"\x01" + b"a" * 4000)
        message = await asyncio.wait_for(ws.receive(), 5)
        while message.type == WSMsgType.BINARY:
            message = await asyncio.wait_for(ws.receive(), 5)
        self.assertIn(message.type, (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING))
        self.assertLess(len(self.fake.received), 20)

    async def test_other_paths_are_404(self):
        client = await self.client()
        for path in ("/", "/healthz", "/api/chat/x", "/static/index.html"):
            response = await client.get(path, headers=GOOD)
            self.assertEqual(response.status, 404, path)

    async def test_relay_rebuilds_upstream_request_and_filters_frames(self):
        client = await self.client()
        ws = await client.ws_connect(QUERY, headers=GOOD)
        handshake = await ws.receive()
        self.assertEqual(handshake.data, b"\x00")
        await ws.send_str("not forwarded")
        await ws.send_bytes(b"\x07control-kind-dropped")
        await ws.send_bytes(b"\x01opus")
        echo = await asyncio.wait_for(ws.receive(), 5)
        self.assertEqual(echo.data, b"\x01echo")  # the 0x02 model-text frame was dropped
        await ws.close()
        self.assertEqual(self.fake.received, [b"\x01opus"])
        sent = self.fake.requests[0]
        self.assertEqual(sent["query"], {"voice_prompt": "NATF1.pt", "text_prompt": "persona prompt"})
        lowered = {k.lower() for k in sent["headers"]}
        self.assertNotIn("authorization", lowered)
        self.assertNotIn("x-aukora-voice-authority", lowered)

    async def test_second_concurrent_session_is_503(self):
        client = await self.client()
        first = await client.ws_connect(QUERY, headers=GOOD)
        await first.receive()
        response = await client.get(QUERY, headers=dict(GOOD, Upgrade="websocket", Connection="Upgrade"))
        self.assertEqual(response.status, 503)
        await first.close()

    def test_config_refuses_non_digest(self):
        for value in ("", TOKEN, "z" * 64, ",".join(["a" * 64] * 5)):
            with self.assertRaises(SystemExit):
                gateway.Config(dict(self.env, GATEWAY_TOKEN_SHA256=value))

    def test_voice_allow_list_matches_voice_director(self):
        self.assertEqual(len(gateway.VOICES), 16)
        self.assertEqual(sorted(gateway.VOICES), sorted(
            ["NATF0", "NATF1", "NATF2", "NATF3", "NATM0", "NATM1", "NATM2", "NATM3",
             "VARF0", "VARF1", "VARF2", "VARF3", "VARM0", "VARM1", "VARM2", "VARM3"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
TESTS

RUN python /opt/gateway/test_gateway.py \
 && touch /opt/gateway/TESTED

# ---------------------------------------------------------------------------------------------
FROM gateway-base AS gateway
COPY --from=gateway-test /opt/gateway/TESTED /opt/gateway/TESTED
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/tmp
USER 10002:10002
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8081/healthz', timeout=3).status == 200 else 1)"]
ENTRYPOINT ["python", "/opt/gateway/gateway.py"]
