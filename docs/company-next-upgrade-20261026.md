# Company Desktop: Next framework migration

## Source and release identity

This candidate uses Desktop `e910c86de21159bf37abaf4f62342378a2c592a3`
and the unmodified Harness submodule `1f81c047fc48fa190a683e469daa699857e9afe8`
(`0.2.1-rc.3`). Company packaging remains in `dsh-plugin-desktop-beta`.
The independent `dsh-desktop-next` package retains its upstream product identity
and update service.

The Beta manifest seals transport version `2.0.21-beta.15` and build
`2026102602`. The earlier `.20` / `2026102601` acceptance artifacts remain
immutable; `.21` adds inline-thinking compatibility after the real Qwen report.
`company-build-version.ts` maps the transport version to the agreed
UI label `2.0.18-beta.15`; Desktop state exposes these as separate fields. P7
requests and installer checks continue to use the transport version. Release
notes must include the UI label and internal build from this contract.

The `.21` company model middleware translates leading inline `<think>`
preambles into native reasoning deltas as they arrive. Ordinary answer text,
including Markdown examples of the tag, remains text. Truncated thinking
stays in the reasoning disclosure. Auxiliary title requests use the same
middleware and retain only the actual title as visible text. Official and
personal provider routes are outside this transformation.

Historical completed replies are adapted in memory by the company client.
The rc.3 Slot API has no decorator primitive; this compatibility adapter wraps
the writable component field of the existing assistant entry, retaining its
identity, owned children and authorized rendering props. It restores only its
own wrapper when unloaded. Do not replace this with a shadow entry that
redeclares the shipped child slots. The saved session events remain untouched;
the real shipped-UI fixture must exercise collapsed and expanded legacy text
whenever the upstream renderer changes.

App identity remains `ai.deepseek.dsh.desktop.companytest`, product name
`P7 DSH Company Test`, Electron user data `P7 DSH Company Test`, and company
home `.p7-dsh-companytest`. Existing selected home and Profile directory are
reused in place; startup does not copy user credential vaults or chat storage.

## Company composition

The models, web-search and managed-MCP plugins run in the same Profile Host.
Native OS-encrypted refresh storage and browser authorization are bridged by
the main process. Company login is required before company models become
available. Final composition seals this policy on initial load and HMR;
official DeepSeek account UI, feedback UI and its platform browser-login
handoff are disabled for Company only. The P7 account page retains login,
logout and personal usage.

New Company Profiles enable the community market. Existing market selection
is preserved. StreamFold is pinned to `0.7.9`; its defaults are written only
when no saved StreamFold preferences exist: fold mode, 180px window, sparks
off, settle-to-prompt off, keep questions visible. Real Agent-event rendering
requires a separate browser acceptance run; DOM-only tests are insufficient.

## Shared source rule

Run `corepack yarn check:desktop-variants` before committing or packaging.
Common Next/Beta files still use the upstream bidirectional name transforms.
`scripts/company-variant-differences.json` lists individually reviewed Company
differences, their reasons, and both normalized content hashes. There are no
directory or wildcard exclusions. A changed declared file fails verification
until its new content is reviewed and its exact hash is deliberately updated.
Sync commands skip these exact files, including Company-only files, so they
cannot copy Company identity into ordinary Next or delete its Company bridge.
Do not regenerate the manifest as a routine way to silence drift failures.

Legacy appearance/loopback regression helpers are retained as reference
coverage; they are not entry points in the new Host. Company acceptance must
use `verify:company-host` and the new packaged runtime rather than the retired
Beta loader scripts.

## Build and acceptance

1. Run immutable install, market and Agents Anywhere freshness checks.
2. Run layout, type, unit, frontend and Host checks; verify the three inference
   protocols reject redirects. Run `verify:company-host` with its disposable
   home. Its mocked policy is an offline fixture, never a production bypass.
3. Commit the candidate. Build via `corepack yarn dist:win-company-release`
   with `DSH_P7_BOOTSTRAP_FILE` pointing to the protected local bootstrap.
   Both distributions must record the same committed source. The Full package
   alone includes the bootstrap; the public update package must contain none.
4. Inspect/extract actual NSIS payloads, verify sealed ASAR metadata, runtime
   closure, exact installer filenames and blockmap coverage.
5. Back up the authorized Windows test installation and user data. Test beta14,
   old beta15 and the current bridge: actual download ranges, SHA512/SHA256,
   corrupted-delta fallback to the same credential-free update, installation
   path, restart and chat/vault preservation. Report measured transfer bytes.
6. Complete employee Feishu authorization, model/MCP/usage acceptance and
   restart recovery. Supplier quota tests remain bounded; Wkinfo at most once.

Publish only after all gates pass using `scripts/publish-company-release.mjs`
and the existing [three-artifact workflow](company-release.md). The validator
reads actual `app.asar/package.json` (and compares a legacy loose manifest if
one exists); Windows does not require a loose `resources/app` directory.
Publication verifies all staged hashes before changing the public revision.
Keep the previous complete release and restore evidence. No P7 business
service restart is required. A failed login, data-preservation or installation
gate leaves the candidate unpublished.
