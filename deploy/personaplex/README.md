# PersonaPlex 7B voice renderer (G-W3.1)

Self-hosted `nvidia/personaplex-7b-v1` behind an authenticating gateway and a locked Cloudflare
Tunnel. It feeds your-node's `GET /door/voice` and can serve `dsh-superagent-prototype`.

Status: **linted and unit-tested offline only** (hadolint, shellcheck, the gateway unit tests and the
verifier self-test RAN on a dev box). **No image build, no GPU run, no live tunnel: UNVERIFIED live.**

| file | what it is |
|---|---|
| `Dockerfile` | one file, two images: `--target renderer` (moshi.server) and `--target gateway` (auth + relay; its unit tests run as a build stage) |
| `cloudflared-config.example.yml` | tunnel ingress: one hostname, one path, one origin, Access validation under the rule, catch-all 404 |
| `verify-personaplex-zero-secret.mjs` | checks zero credentials in the image spec, compose file and running container, and that tunnel ingress is one hostname/path/origin with an Access JWT required under the rule. The Access *policy* (service token = your-node Worker only) lives in Cloudflare and is outside what it can see |
| `README.md` | this runbook |

Evidence tags: **SOURCE** = read from a file at the cited line, **RAN** = executed with the exit code
given, **UNVERIFIED** = not checked.

## 1. What the renderer actually is (SOURCE)

Upstream is `NVIDIA/personaplex` at commit `16419a2ef7b98611f58c9df07477d00e5ad61d5f`
(main on 2026-11-06), pinned by tarball sha256 in the Dockerfile.

- Install: `libopus` plus `pip install moshi/.`. The HF weights are gated: accept the licence, then use
  an `HF_TOKEN` (personaplex README "Installation", "Accept Model License").
- Launch: `python -m moshi.server`, port `8998` by default. The WebSocket route is `GET /api/chat`
  (`moshi/moshi/server.py:482`).
- Query: `voice_prompt` (a file name joined onto `--voice-prompt-dir` with `os.path.join`,
  server.py:158-161) and `text_prompt` (required; it is read unconditionally, server.py:176).
  `seed` is read from `request["seed"]` rather than the query (server.py:177), so sending it raises.
- Frames: `0x00` is the handshake, sent after the system prompts (server.py:294). `0x01` + Opus goes
  both ways (server.py:257). `0x02` + UTF-8 carries the **model's own** text tokens (server.py:245).
- Binding: `web.run_app(app, port=...)` never receives `--host` (server.py:501), so the server
  listens on every interface with no authentication.
- One session at a time (`async with self.lock`, server.py:265). `lm_gen` prompts are mutated
  before that lock is taken, so a second concurrent connection would corrupt the first.
- Voice files are loaded with `torch.load(path)` (`moshi/moshi/models/lm.py:1015`). On torch 2.4
  that is a pickle load, so a tampered voice file means code execution in the renderer.
- Flags used here: `--static none` (no web UI, no `dist.tgz` download), `--voice-prompt-dir`, and
  `--max-pinned-frames` (README "Endless Conversations"; default 512).
- Voices upstream: `NATF0-3`, `NATM0-3`, `VARF0-4`, `VARM0-4` (README "Voices"). The Worker exposes
  16 and leaves out `VARF4` and `VARM4`. The gateway matches the Worker.
- Hardware on the model card: A100/H100, Linux. A 24 GB 4090/L4 fit is UNVERIFIED.

## 2. The contract with your-node (SOURCE: `deploy/cloudflare/src/voice-director.mjs`)

- **The Worker env var is `PERSONAPLEX_WS_URL`, not `VOICE_RENDERER_URL`.** It must be `wss://`
  with no userinfo (`validRendererWsUrl`, :54-63; read at :67 and :242). If it is unset, the route
  returns `503 VOICE_RENDERER_UNCONFIGURED` (:246).
- The Worker rewrites the URL to `https:`, keeps the path, and adds
  `voice=<ID>&mode=forced_text_stream[&turnId=…]` (:256-259). It also sends
  `x-aukora-voice-protocol: aukora.voice-director.v1`, `x-aukora-voice-authority: none` (:262-263)
  and, if `PERSONAPLEX_AUTH_TOKEN` is set, `Authorization: Bearer <token>` (:264-265).
- Anything other than `101` from upstream becomes `502 VOICE_RENDERER_UNAVAILABLE` (:274-279).
- `/door/voice` sits behind the Worker's owner-access gate (`worker.mjs`, `verifyAccess` before
  every route) and a same-origin check (`worker.mjs` `voiceDoorRoute` branch).
- So set `PERSONAPLEX_WS_URL=wss://voice.example.invalid/api/chat`.

**Invariant 1 has no enforcement point on a stock renderer.** `aukora.voice-director.v1` says the
Brain is the sole author of substantive speech. Stock moshi.server has no input that forces its text
stream; it composes its own words. So the gateway **always** answers `mode=forced_text_stream` with
`501 VOICE_FORCED_TEXT_STREAM_UNAVAILABLE`, and the Worker turns that into `502`. Until the
forced-text decode fork exists, **the production voice door stays closed
by design**, even once everything here is deployed.

The only way to hear the model is a distinct `mode=free_render_unforced`. The Worker never sends it,
and the gateway accepts it only when `PERSONAPLEX_ALLOW_FREE_RENDER=1`. That is the labelled
Slice-1 "hear it" session, reachable from a local DSH client (section 5). Even then, the model's
`0x02` text frames are dropped and never reach the client.

## 3. Topology

```
browser ─owner session─▶ your-node Worker ─wss + Access service token + bearer─▶ Cloudflare edge
   ─▶ cloudflared (egress_net + tunnel_net) ─▶ gateway:8080 (tunnel_net + renderer_net, no egress)
   ─▶ renderer:8998 (renderer_net only: internal, no egress, no published port, zero credentials)
```

| container | networks | egress | published ports | credential held |
|---|---|---|---|---|
| renderer | `renderer_net` (internal) | none | none | **none**; launch refuses to start otherwise |
| gateway | `renderer_net`, `tunnel_net` (both internal) | none | none | none; holds only SHA-256 digests of the Worker bearer |
| cloudflared | `tunnel_net`, `egress_net` | outbound to Cloudflare | none (metrics on 127.0.0.1) | the tunnel's credentials file (one tunnel; not an API token) |

Inside containers, the HF token exists only in the one-shot fetch container (section 4, step 2): it
comes in on stdin and is never in env, argv, a file mount or the image. On the host it is read from
the operator's own file for that one command; keep that file mode 0600 and delete it afterwards if
the host is shared.

## 4. Bring-up

Two machines, on purpose. **GPU host**: Linux with an NVIDIA driver of at least 550 (the base image
declares `cuda>=12.4`), nvidia-container-toolkit, Docker Compose v2, Node (for the verifier). It never
holds an account-level Cloudflare credential, a wrangler login, or the plaintext Worker bearer.
**Admin workstation**: `wrangler` logged in to the account that owns `your-node`, and `cloudflared`
with its account `cert.pem`. Steps 3-5 run there; only a digest and the one tunnel credentials file
are copied to the GPU host. Commands run from the repo root.

1. **Build both images.** The gateway build runs its unit tests.
   ```sh
   docker build --target renderer -t aukora-voice-renderer:local deploy/personaplex
   docker build --target gateway  -t aukora-voice-gateway:local  deploy/personaplex
   ```
2. **Fetch the weights once.** This needs a fine-grained HF token with read access to this one gated
   repo, and a full HF commit sha that you choose and record.
   ```sh
   docker volume create personaplex-hf-cache
   docker run --rm -i --read-only --tmpfs /tmp --network bridge --cap-drop ALL \
     --security-opt no-new-privileges -e HF_HUB_OFFLINE=0 \
     -e PERSONAPLEX_HF_REVISION=<40-hex HF commit> \
     -v personaplex-hf-cache:/models --entrypoint python \
     aukora-voice-renderer:local /opt/voice/fetch_weights.py < ~/.secrets/hf_token
   ```
   This writes `/models/PINNED-REVISION.json` with per-file and per-voice sha256. Review it, then
   install the reviewed copy **outside the volume**, root-owned and read-only; `launch.sh` trusts only
   that copy (mounted at `/etc/voice-pin`) and re-checks the 16 voice files against it on every
   start, so rewriting a voice file on the volume is not enough to get a pickle loaded:
   ```sh
   sudo install -d -o root -g root -m 0755 /etc/aukora/voice-pin
   docker run --rm --network none -v personaplex-hf-cache:/models:ro --entrypoint cat \
     aukora-voice-renderer:local /models/PINNED-REVISION.json \
     | sudo install -o root -g root -m 0444 /dev/stdin /etc/aukora/voice-pin/PINNED-REVISION.json
   ```
   Commit those digests to this README and pass them on later fetches as
   `PERSONAPLEX_EXPECTED_SHA256='{"model.safetensors":"…",…}'`. Until you do, the first fetch is
   trust-on-first-use.
3. **Mint the Worker bearer (admin workstation).** Generate a 48-byte random token. Store it only
   as the Worker secret; only its digest goes to the GPU host.
   ```sh
   umask 077
   openssl rand -base64 48 | tr -d '\n' > /dev/shm/voice-token
   npx wrangler secret put PERSONAPLEX_AUTH_TOKEN --name your-node < /dev/shm/voice-token
   printf 'GATEWAY_TOKEN_SHA256=%s\nPERSONAPLEX_ALLOW_FREE_RENDER=0\n' "$(sha256sum /dev/shm/voice-token | cut -d' ' -f1)" > voice.env
   shred -u /dev/shm/voice-token
   # copy voice.env to the GPU host as /etc/aukora/voice.env (root:root 0600), then delete it here
   ```
   To rotate, add the new digest alongside the old one (comma-separated, up to 4), roll the Worker
   secret, then drop the old digest.
4. **Create the tunnel and DNS (admin workstation).**
   ```sh
   cloudflared tunnel create aukora-voice
   cloudflared tunnel route dns aukora-voice voice.example.invalid
   ```
   - Copy only `~/.cloudflared/<uuid>.json` to the GPU host and install it readable only by the
     cloudflared container user:
     `sudo install -o 65532 -g 65532 -m 0400 <uuid>.json /etc/aukora/voice-tunnel.json`.
     The 65532 uid is UNVERIFIED; check `docker image inspect --format '{{.Config.User}}' cloudflare/cloudflared:2026.10.7`.
   - Never copy `~/.cloudflared/cert.pem` to the GPU host. It is account-level.
   - Copy `cloudflared-config.example.yml` to `/etc/aukora/voice-cloudflared.yml` and fill it in.
5. **Create the Access application (admin workstation or dashboard)** for `voice.example.invalid`. Give it one "Service Auth" policy that
   includes one service token, "node-voice". Put its AUD tag and team name in the config.
6. **Verify the lock-down**, then start the stack (compose file below).
   ```sh
   node deploy/personaplex/verify-personaplex-zero-secret.mjs --config /etc/aukora/voice-cloudflared.yml \
     --team <ZERO_TRUST_TEAM_NAME> --compose /etc/aukora/voice-compose.yaml --env-file /etc/aukora/voice.env
   docker compose -f /etc/aukora/voice-compose.yaml --env-file /etc/aukora/voice.env up -d
   node deploy/personaplex/verify-personaplex-zero-secret.mjs --runtime aukora-voice-renderer-1
   ```
7. **Point the Worker at it**:
   `PERSONAPLEX_WS_URL=wss://voice.example.invalid/api/chat`, plus the Access service-token headers.
   **Until the Worker sends those headers, Access rejects every Worker request and `/door/voice`
   answers `502`.** That is fail-closed and expected; with invariant 1 it stays closed anyway.

### `/etc/aukora/voice-compose.yaml`

```yaml
name: aukora-voice
services:
  renderer:
    image: aukora-voice-renderer:local
    restart: unless-stopped
    networks: [renderer_net]
    read_only: true
    tmpfs: ["/tmp:size=1g,mode=1777,noexec,nosuid,nodev"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 2048
    mem_limit: 48g
    memswap_limit: 48g
    dns: ["127.0.0.1"]
    volumes: ["personaplex-hf-cache:/models:ro", "/etc/aukora/voice-pin:/etc/voice-pin:ro"]
    deploy:
      resources:
        reservations:
          devices: [{ driver: nvidia, device_ids: ["0"], capabilities: [gpu] }]
  gateway:
    image: aukora-voice-gateway:local
    restart: unless-stopped
    networks: [renderer_net, tunnel_net]
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 64
    mem_limit: 256m
    environment:
      GATEWAY_TOKEN_SHA256: ${GATEWAY_TOKEN_SHA256:?digest only, never the token}
      PERSONAPLEX_UPSTREAM: ws://renderer:8998/api/chat
      PERSONAPLEX_ALLOW_FREE_RENDER: "0"
    depends_on: { renderer: { condition: service_healthy } }
  cloudflared:
    image: cloudflare/cloudflared:2026.10.7@sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba
    restart: unless-stopped
    networks: [tunnel_net, egress_net]
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 256m
    dns: ["1.1.1.1", "1.0.0.1"]
    command: ["tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:20241", "--config", "/etc/cloudflared/config.yml", "run"]
    volumes:
      - /etc/aukora/voice-cloudflared.yml:/etc/cloudflared/config.yml:ro
      - /etc/aukora/voice-tunnel.json:/etc/cloudflared/credentials.json:ro
    depends_on: { gateway: { condition: service_healthy } }
networks:
  renderer_net: { internal: true, driver_opts: { com.docker.network.bridge.name: br-voice-rend } }
  tunnel_net: { internal: true }
  egress_net: { driver_opts: { com.docker.network.bridge.name: br-voice-egr } }
volumes:
  personaplex-hf-cache: { external: true }
```

**Host firewall (required).** `internal: true` blocks forwarding, but on many Docker engines it does
not stop processes on the host itself from reaching `renderer:8998` (UNVERIFIED per engine). It also
leaves cloudflared able to reach the LAN.
```sh
iptables -I OUTPUT -o br-voice-rend -p tcp --dport 8998 -m owner ! --uid-owner 0 -j REJECT
iptables -I DOCKER-USER -i br-voice-egr -j DROP
iptables -I DOCKER-USER -i br-voice-egr -p tcp --dport 7844 -j ACCEPT
iptables -I DOCKER-USER -i br-voice-egr -p udp --dport 7844 -j ACCEPT
iptables -I DOCKER-USER -i br-voice-egr -p udp --dport 53 -j ACCEPT
iptables -I DOCKER-USER -i br-voice-egr -p tcp --dport 53 -j ACCEPT
iptables -I DOCKER-USER -i br-voice-egr -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10 -j DROP
```
`-I` prepends, so the effective order is the reverse of the listing: private ranges dropped first,
then DNS and 7844 accepted, then everything else dropped. cloudflared therefore resolves through the
public resolvers set in the compose file (`dns:`), not a LAN resolver. These rules are not persistent
across reboots (use your distro's `iptables-persistent`/nftables unit) and cover IPv4 only; add the
`ip6tables` equivalents or disable IPv6 on `br-voice-egr`. Exact Docker engine behaviour is UNVERIFIED.

## 5. Local DSH host (dsh-superagent-prototype)

Run the DSH voice client as a container on `tunnel_net`, and point it at `ws://gateway:8080/api/chat`
with the same headers and **its own** bearer: mint a second token the same way, add its digest to
`GATEWAY_TOKEN_SHA256` (comma-separated; up to 4), and revoke it by removing the digest. Never reuse
the Worker's bearer. Don't publish a gateway port: a published port needs a non-internal
network, and that would give the gateway egress. For the Slice-1 "hear it" session, set
`PERSONAPLEX_ALLOW_FREE_RENDER: "1"` and send `mode=free_render_unforced`. Label that session as
unforced speech, because the model will confabulate.

## 6. Abuse limits in the gateway

- Bearer is checked by SHA-256 + `hmac.compare_digest`, with at least 43 characters.
- Query keys are allow-listed with no duplicates, and the 16 voices are allow-listed. The upstream
  query is rebuilt from scratch: never `seed`, never a client path, never client headers.
- Waits for the renderer handshake before sending `101`, with a 10 s connect timeout and 60 s for
  the handshake.
- Client→renderer: only kind `0x01`, frames of at most 4 KiB, a 12 kB/s budget with a 36 kB burst,
  and a 20 s idle timeout. These stop a faster-than-real-time backlog from wedging the renderer's
  `opus_loop`.
- Renderer→client: only kind `0x01`.
- One session at a time (`503 VOICE_RENDERER_BUSY`) and 900 s per session.
- Auth failures are logged with `cf-ray` only (truncated to 64 characters). No tokens, prompts or transcript are logged.
  Upstream does log the persona text prompt (server.py:260-261), so never put per-user state in it.

## 7. Still UNVERIFIED

- Any GPU run: VRAM headroom on 24 GB, real-time factor on L4 with `NO_TORCH_COMPILE=1`.
- Offline `hf_hub_download` against a read-only cache (expected to work with huggingface-hub
  0.24.7). Prove it with
  `docker run --rm --network none --read-only -v personaplex-hf-cache:/models:ro --entrypoint python aukora-voice-renderer:local -c "from huggingface_hub import hf_hub_download as d; print(d('nvidia/personaplex-7b-v1','config.json'))"`.
- Whether `TORCH_FORCE_WEIGHTS_ONLY_LOAD=1` is honoured by torch 2.4.1, and whether the stock voice
  files load under it.
- The layout of `voices.tgz` (assumed: a top-level `voices/` directory of `*.pt` files).
- That the torch, nvidia and triton wheel hashes download. They were taken from PyPI JSON. The other
  34 renderer pins and all 10 gateway pins were downloaded with `--require-hashes` (RAN, exit 0).
- That the remote `ADD --checksum` archive stays byte-stable.
- That Worker→tunnel WebSocket upgrade, pings and Access service-token auth work end to end.
- `gVisor`/`runsc` with nvproxy as an extra sandbox for the pickle-loading renderer.
- That the CUDA base image's environment is exactly what `launch.sh` allows (`NVARCH`, `CUDA_VERSION`,
  `NCCL_VERSION`, `NVIDIA_*`, `NV_*`, `PATH`, `LD_LIBRARY_PATH`, …). The `launch.sh --check-env` build
  step turns a mismatch into a build failure rather than a crash loop.
- That `uv` 0.9.5 ships CPython 3.12.11, and that `python -m moshi.server --help` runs on a CPU-only
  build host (both are build steps).
- `read_only: true` together with the NVIDIA container runtime hook.
- Upstream WebSocket pings: the gateway disables its own heartbeat towards the renderer, so a renderer
  stuck after the handshake is bounded by the 900 s session cap and the 20 s client idle timeout.

