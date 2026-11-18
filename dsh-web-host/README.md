# DSH Web Host

This package composes the unmodified official `web` profile with the shared P7
company-models and P7 MCP plugins. It is not a browser authentication service:
the P7 edge authenticates the browser before proxying to the loopback-only
Harness listener, then adds a per-request HMAC attestation.

Company Web workspaces load `dsh-claude-data` and `dsh-claude-artifacts` from
the workspace image on startup. Their pinned versions live in this package's
dependencies and the root Yarn lockfile. Upgrade both together and ship them
with the signed workspace image. The workspace proxy must permit
`dsh-claude-artifacts` client assets.
The Web image build applies `scripts/install-company-artifact-publish.mjs` to
add the company publishing action to the bundled synthetic demo. Re-run the
browser preview and publishing checks when changing the pinned package.

## Container contract

- Start the controlled launcher, not a local frontend fork or a shell wrapper:
  `node /opt/dsh/node_modules/dsh-web-host/lib/run.js`. It requires `DSH_HOME`
  and `DSH_WEB_PUBLIC_URL=https://<edge>/dsh/`, and accepts
  `DSH_WEB_DSH_BIN`, `DSH_WEB_PATCH`, and `DSH_WEB_PORT` (default `3080`). It
  selects the container's concrete `eth0` IPv4 for the official listener and
  executes the official web profile with its configured public authority. The
  patch's `publicOrigin` is the exact HTTPS origin without `/dsh/`.
- The personal persistent volume is mounted at `/var/lib/dsh`; it holds the
  official profile, chats, files, personal Skills, and P7 Memory sync
  checkpoint/outbox baselines. Company Skills remain image-owned and read-only.
- The container root filesystem may be read-only, and Docker injects the
  read-only passwd home as `HOME`. The launcher therefore points the web
  session's `HOME` at `$DSH_HOME/home` (created on boot) so the home
  directory — the directory picker's default location for new workspaces —
  is writable and persistent. `DSH_WEB_HOME` overrides the target when set.
- The controller mounts `/run/p7-web` read-only, mode `0700`, with mode `0600`
  `instance.json` (`p7wi_` instance credential), `attestation.key`, and
  `controller.token`. The browser never receives these files or tokens.
- The reverse proxy is the only public edge. It strips the `/dsh/` prefix,
  preserves Host, rewrites Secure cookie paths, proxies WebSocket upgrades, and
  rejects requests without its P7 session gate. The Harness listener remains
  container-private. `/p7-web-host/internal/**` is never proxied to browsers.

The controller can query `GET /p7-web-host/internal/activity` from the exact
`P7_WEB_CONTROLLER_PEER` bridge address (default `127.0.0.1`) with the
`x-p7-controller-token` header. CIDRs and broad private-network admission are
not accepted. A missing/invalid token returns `503` with
`state: unknown`; `unknown` must be treated as busy and must block stop/update.
The probe uses Host `agent/status` lifecycle events and never treats a browser
heartbeat or HTTP health response as task-idle proof.

`GET /p7-web-host/internal/ready` reports route readiness separately from
activity. `GET /p7-web-host/internal/bootstrap` returns a private official-core
cookie only to the same controller channel; the proxy attaches it upstream and
must strip all core `Set-Cookie` headers before responding to the browser. The
official cookie carries an absolute expiry (`cookieMaxAgeDays`, 30 days by
default); the host renews the stored cookie through the process launch token
before that expiry, so the proxy must re-pull the bootstrap route whenever the
upstream answers `401` instead of treating the container as broken.

## Deployment requirements

- The official listener binds the container `eth0` address and has no edge
  attestation of its own. The pod must run no third-party containers, and a
  NetworkPolicy (or equivalent) must restrict ingress on the listener port to
  the proxy sidecar alone.
- The edge and the container must be NTP-synchronized; attestations older than
  60 seconds of clock skew are rejected fail-closed.
- `/run` must remain a container-private tmpfs: the core-cookie state file
  lives under `/run/p7-web-state` and must never land on a persistent volume.
- The proxy must strip all core `Set-Cookie` headers (`dsh-auth-*`) from
  upstream responses and must never expose `/p7-web-host/internal/**`.
- Verify a deployed edge with `corepack yarn workspace dsh-web-host check:edge
  https://<edge>/dsh/`; every probe is unauthenticated and must fail closed.
- On an upstream `@deepseek-ai/*` version bump, run `corepack yarn workspace
  dsh-web-host test` first: the contract tests pin the official startup URL
  line, the connection-service renewal API, the `agents` service name, and the
  exact installed versions.

Memory sync supports Mnemon runtime and document records. It reports
`memory-spaces` as unsupported; those records must not be shown as synchronized.

With `P7_DSH_TENCENT_MEMORY=1`, Web Host records completed human turns through
the company portal and registers the `search_company_memory` tool. This
requires a configured server-managed Tencent MemoryCore backend. The portal
verifies the current workspace credential and scopes each operation to the
employee and organization it resolves. The Tencent service credential stays
on the portal.
