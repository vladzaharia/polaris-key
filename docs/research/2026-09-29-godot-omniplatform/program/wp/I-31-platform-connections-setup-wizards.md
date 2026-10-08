# I-31 Platform -> Connections and setup wizards

| Field       | Value                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity)                          |
| Size        | 1–1.4 engineer-weeks                                                                                                       |
| Depends on  | [I-30](I-30-connections-one-oidc-relying-party.md), [ST-09](ST-09-platform-settings-area.md), [ST-39](ST-39-wizard-kit.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                     |
| Role        | `pkey-implementer`                                                                                                         |
| Plan mode   | no                                                                                                                         |
| Gates       | `threat-model`, `console-csp-parity`                                                                                       |
| Human input | none                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                  |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-04** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: the built-in connection rows with `seed-builtin-connections`, and the `SIGNIN_*` names removed in the same release (its scope's "env `SIGNIN_*` as overrides" goes). Operator audiences stay refused until ST-32.

## Goal

Platform -> Connections and setup wizards, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-04** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §5); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §5, for **IX-04**.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- One Platform -> Connections page grouped by kind: Sign-in providers and SSO (Google, Apple, Steam with status and step-by-step setup, secrets sealed under the platform KEK, env SIGNIN\_\* as overrides; SSO connections list and add wizard: discovery, redirect URI, client, test sign-in with claims preview, domains with the TXT record and live verification, audience, group mappings; per-connection status), Email (delivery status, I-18) and Turnstile; the Stores group joins when P0-28 lands, replacing the separate Store connections nav item. No Policies page: method strength is ST-28's fixed rule, session lengths are shown read-only as deploy-time values, reserved display terms stay with PX-W13b.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-04**; DX consolidation F: Identity.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A connection is added end to end without editing env
- [ ] All settings through the registry and SettingsRow; no new policy knob
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/sign-in/*`; `operate/platform/connections`; `help/work-account`, `help/account`, `help/connected-apps`; the React cookie note removed.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-31 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-31 done`.
