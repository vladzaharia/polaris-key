# PX-W13 Passthrough request metadata (G28): client records with presentation and the reserved-name check (warn first, then enforced), the request handle, `deviceName` label from the SDKs, consent data

| Field       | Value                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                                                             |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                              |
| Depends on  | [I-04](I-04-account-contract-plan.md), [LX-05](LX-05-reserved-names-warn.md)                                                                                                                        |
| Unblocks    | [I-08](I-08-app-passthrough.md), [PX-14](PX-14-passthrough-header.md), [SP-11](SP-11-presentation-accent.md)                                                                                        |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                               |
| Plan mode   | yes: executes the approved [`plans/PX-W13.md`](../plans/PX-W13.md) (approved 2026-10-05), which fills the G28 gap in [`plans/I-04.md`](../plans/I-04.md)                                            |
| Gates       | the PORTAL.md §11 green gate; plan mode; corpus and transcripts (`gen:corpus -- --check`, `gen:transcripts -- --check`); THREAT-MODEL; every SDK's replayer; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                           |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W13.md`](../plans/PX-W13.md):** this plan replaces "no separate plan" and was approved on 2026-10-05 with every recommendation accepted, except Q4, which the owner amended. `deviceName` stays the wire name (Q1); the label is also sent on `license/activate` and `register` (Q2); PX-W13 ships the §5 SDK and UI-kit label work itself (Q3); consent re-asks only on a change of claims or services (Q5); `account_product_grants` keeps its name and new surfaces say "app consent" (Q6).
- **Owner (2026-10-05):** reserved display names **warn first, then enforce**: `reserved_display_name` ships behind the platform switch `identity.reservedDisplayNames` (default `warn`), reusing LX-05's validator warning path (new dependency LX-05). PX-W13 flips it to `error` after the S-19 decision-15 window (two minor releases or 60 days, whichever is later). It is not a hard error from day one.

## Goal

Every app-initiated sign-in resolves a server-side client record (`appName`, `developerName`, proxied `iconUrl`, `kind`, registered origins, `services`) plus request-time `deviceLabel` and `user_code`, read by the login card through an opaque `request` handle, never from display query parameters; names are checked against a reserved list at registration.

## Why

The "<App> wants you to sign in" header must be trustworthy ([PORTAL.md §4.7](../../../../design/PORTAL.md#47-app-sign-in-the-card-header), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G28). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.7](../../../../design/PORTAL.md#47-app-sign-in-the-card-header), [PORTAL.md §4.8](../../../../design/PORTAL.md#48-app-sign-in-native-app-steps), [PORTAL.md §4.9](../../../../design/PORTAL.md#49-app-sign-in-device-code-tv-console), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `plans/I-04.md`; `wp/I-08-app-passthrough.md`
- `docs/security/THREAT-MODEL.md`

## Scope

**In:**

- Client records, the request handle, `deviceLabel` from the SDKs (wire), consent data, per I-04's plan.

**Out** (and where it belongs instead):

- UI (→ PX-14)

## Design notes

- **Plan mode:** executes I-04's approved plan; the SDKs send `deviceLabel`, so corpus and transcripts change.
- **THREAT-MODEL (spoofed app names):** reserved-name list, length limits, sanitised labels.
- **Overlap with the re-cut S-16/S-17 graph:** I-08 also names the passthrough header. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W13:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W13 in-review`.

## Acceptance criteria

- [ ] The card reads presentation only through the `request` handle (test: display query parameters are ignored).
- [ ] A reserved-name test refuses a spoofed app name.
- [ ] Corpus and transcripts are regenerated and every SDK sends `deviceLabel` (parity).
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check && mise exec node@22 -- pnpm gen:transcripts -- --check
```

## Hand-off

PX-14 renders the app and device headers and `AppConsent`.

The role agent sets `--set PX-W13 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W13 done`.
