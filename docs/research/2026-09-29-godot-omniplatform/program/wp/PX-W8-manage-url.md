# PX-W8 `manageUrl` (G15b) on `device_limit` and on `key_entry_limit` (one name, owner 2026-10-05): contract, `core/manageUrl.ts` builder, transcript, client-core `readManageUrl`, every SDK and UI kit

| Field       | Value                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                                                                                           |
| Size        | 1–1.6 engineer-weeks                                                                                                                                                                                                              |
| Depends on  | [I-04](I-04-account-contract-plan.md)                                                                                                                                                                                             |
| Unblocks    | [PX-17](PX-17-activate-confirm.md)                                                                                                                                                                                                |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                             |
| Plan mode   | yes: executes the approved [`plans/PX-W8.md`](../plans/PX-W8.md) (approved 2026-10-05), which refines [`plans/I-04.md`](../plans/I-04.md)                                                                                         |
| Gates       | the PORTAL.md §11 green gate; plan mode; corpus and transcripts (`gen:corpus -- --check`, `gen:transcripts -- --check`); `gen:constants -- --check`, `parity:check`; every SDK's replayer; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                         |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W8.md`](../plans/PX-W8.md):** approved on 2026-10-05 with every recommendation accepted: `manageUrl` on both refusals (Q1); the Worker emits no key, and the SDK may add `#key=` as a fragment (Q2); a floating licence links to `/activate?product=…&next=free-device` (Q3); the app's return URL travels as a client-side `return=` (Q4); sign-in seat refusals are left to LX-18 (Q5). Corrections: there is no signed-corpus impact; the portal is served at the root, so the paths are `/activate` and `/signin`; PX-10's `FreeDevicePage` already reads `for`, `return` and `license`; no `device_limit` transcript exists today. PX-W8 now executes its own plan, not I-04's.

## Implementation notes (PX-W8, 2026-10-05)

Corrections to the brief, found against the code (the code is the fact):

- **No `errors.json` code and no signed corpus change.** `device_limit` already exists; its
  description in `conformance/parity/errors.json` now mentions `manageUrl`. `gen:corpus -- --check`
  is unchanged. The evidence is the new transcript `license-device-limit.json` (with its Swift and
  Godot mirrors), replayed by all six SDKs, and the parity rows `license.manage` and
  `ui.kit.manage`.
- **Contract section.** I-09 has not opened §12, so the contract text is the standalone
  **WIRE-CONTRACT-V4 §5.3 "Refusal links"**, as the plan allows.
- **The Goal's link shapes are superseded by the plan.** The Worker never puts the key in the link
  (`/activate?product=<slug>`, the SDK adds `#key=`), and a floating licence links to
  `/activate?product=<slug>&next=free-device`.
- **`key_entry_limit` is built, not emitted.** `core/manageUrl.ts` builds the `key_entry_limit`
  link (`kind: "key_entry_limit"`), but no route emits that refusal until I-09 ships. The SDKs read
  `manageUrl` from either envelope through one helper, so I-10a and I-10b only wire the outcome.
- **The transcript has three steps, not the plan §4 list.** `license-device-limit.json` replays a
  floating licence, an attached licence and the portal turned off. The `session/license` route and
  the Device A 200 step are not in it: SDKs never call the browser route, so it is covered by the
  Worker test `packages/worker/test/manageUrl.test.ts` instead.
- **"When every seat is taken" lives in each SDK README.** `packages/docs` has no per-SDK
  licensing guides, so the section the plan puts there went into the README of every SDK (Node,
  Python, React, Swift, Kotlin, Godot).

Decisions taken by the lead (owner delegated; recommended option each time):

- **Validation in SDKs without a URL parser** (Godot, Kotlin, Swift's helpers) uses one shared
  rule: scheme `https` (or `http` to `localhost`, `127.0.0.1`, `[::1]`), a non-empty host, no
  userinfo, no whitespace or control characters, at most 2048 characters. Every SDK repeats the
  client-core table, so the links are byte-identical.
- **Where the QR replaces the button.** Swift: tvOS. Kotlin: `UI_MODE_TYPE_TELEVISION`. Godot: a
  runtime with no browser (not desktop, web or a phone OS), or a phone OS with no touchscreen and a
  joypad connected (Android TV); `PKeyActivationPanel.manage_mode` overrides it.
- **"Try again" is the existing Activate button.** The kits add only **Free up a device**; the
  person frees a seat in the portal and presses Activate again. No new retry control.
- **Swift `.deviceLimit` gains `manageURL: String? = nil`.** Construction stays source-compatible;
  an exhaustive two-value pattern binding needs a third pattern (0.x, noted in the Swift README).
- **UI kits get the functional link only** (lead instruction): the UK programme restyles the kits.
- **A QR code never carries the key** (review round 1). The key is a bearer credential, and a QR
  code on a shared TV screen can be scanned by anyone in the room. So the QR form of the link is
  built without `#key=` (Swift `offeredManageURL(presentation: .qr)`, Kotlin
  `PolarisActivationUi.manageQrUrl`, Godot `manage_link(..., for_qr = true)`); the phone opens
  `/activate` with an empty field (plans/PX-W8.md Q2 allows it). The button form keeps `#key=`:
  same device, same person. Recorded in `docs/security/THREAT-MODEL.md` ("Refusal links") and
  WIRE-CONTRACT-V4 §5.3 item 5, which also make PX-17 drop `#key=` with `history.replaceState`
  after reading it, since the browser keeps a fragment in its history.

## Goal

Apps receive a `manageUrl` on `device_limit` and on the key-entries refusal that opens `#/p/:product/free-device?for=…&return=…` or `/activate?key=…&product=…`, specified in I-04's contract and carried through `errors.json`, the corpus and transcripts, client-core, Node, React, Python, Swift, Godot, Kotlin and the SDK UI kits.

## Why

Without it an app can only say "device limit reached" ([PORTAL.md §3.4](../../../../design/PORTAL.md#34-entry-points), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G15b). This is a wire change: an all-languages event. PORTAL.md sizes this L (5+ agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §3.4](../../../../design/PORTAL.md#34-entry-points), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `plans/I-04.md` once approved; `wp/I-04-account-contract-plan.md`, `wp/I-09-key-entry-attach.md`
- AGENTS.md rules 1–3 and CLAUDE.md plan mode

## Scope

**In:**

- The `manageUrl` field per I-04's approved plan: contract → `errors.json` → corpus and transcripts → client-core → six SDKs → UI kits.

**Out** (and where it belongs instead):

- The key-entry counter itself (→ PX-W9)
- Portal focused flows (→ PX-10)

## Design notes

- **Plan mode:** executes I-04's approved plan (one contract plan for PX-W8, PX-W9, PX-W13 and PX-W17).
- **Overlap with the re-cut S-16/S-17 graph:** I-09 also names the key-entry refusal with a portal URL (`key_entry_limit` with `portalUrl`, renamed `manageUrl` by the owner on 2026-10-05). PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W8:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W8 in-review`.

## Acceptance criteria

- [x] `gen:corpus -- --check`, `gen:constants -- --check`, `parity:check` and every SDK's replayer pass.
- [x] Each SDK and UI kit surfaces `manageUrl` on both refusals (parity tests). The helpers read either refusal; `key_entry_limit` is emitted once I-09 ships, and I-10a/I-10b wire that outcome.
- [x] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [x] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check && mise exec node@22 -- pnpm parity:check
```

## Hand-off

PX-10's free-device flow and PX-17's deep link are the targets.

The role agent sets `--set PX-W8 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W8 done`.
