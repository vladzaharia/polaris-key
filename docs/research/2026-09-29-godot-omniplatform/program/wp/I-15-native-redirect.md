# I-15 Native redirect sign-in: loopback, claimed-HTTPS and registered-scheme redirects on I-08's token route, retire `/auth/poll`, `signIn({redirect})` in all six SDKs (system browser only)

| Field       | Value                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1b)                                                                                |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                |
| Depends on  | [I-08](I-08-app-passthrough.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md)                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-14](PX-14-passthrough-header.md)                                                                                          |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                  |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-15.md` first; it needs human approval before code                                                                            |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); all six SDKs (`parity:check`); THREAT-MODEL |
| Human input | none                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                             |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W13.md`](../plans/PX-W13.md):** §2.5: the request carries `deviceName` under §2.1 and the entry creates a `native` handle.
- **[`plans/PX-W13.md`](../plans/PX-W13.md):** offer a pushed-request step (RFC 9126 style, `POST /<p>/identity/request` → `{request, authorizeUrl}`), because a label in an `authorize` query string would be a display query parameter.

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Native redirect uses the same card: LicenseChoiceStep, then Consent when due; the redirect code carries the choice; ReturnStep per SIGN-IN.md §3.10 ("is yours" only when a license was added or issued now; timer with **Stay here** on mobile).
- **Desktop (SIGN-IN.md §3.17, §6.4, D-60–D-77):** desktop SDKs open the **default browser** (never an embedded web view) with a loopback redirect `http://127.0.0.1:<any port>/pkey/callback` (IP literal, port not compared, one request, matching `state`, PKCE S256), or a registered scheme when the app cannot listen; claimed HTTPS stays mobile. The listener answers `303` to a new browser-facing page `GET /signin/return?request=<handle>[&cancelled=1]` (the desktop ReturnStep: no timer, "You can close this tab and return to <App>", **Return to <App>** only with a registered scheme), which this package's plan adds (OpenAPI, `routeCoverage`). For loopback and scheme redirects the choice, any Replace and the grant apply at `redirect/token`, so an app-side Cancel changes nothing. Device code is the fallback ("Use a code instead", headless terminals), with no QR on desktop. Godot desktop uses `OS.shell_open` plus a `TCPServer` loopback.

## One sign-in form (2026-10-05): `plans/I-04.md` §G and SIGN-IN.md §3.17

The owner decided on 2026-10-05 that every in-app sign-in step happens in **one form whose body
morphs in place** (no stacked sheets), that the license is chosen **inside the app** when it can
show it, that the presentation is configurable with native controls kept, that there are **two
equal ways to integrate** (the hosted card, and the kit form with headless primitives), and that
the web flow is one continuous, animated card. The wire is
[`plans/I-04.md`](../plans/I-04.md) §G (a pending sign-in grant, `licenseChoice: "app" | "card"`);
the experience is [`SIGN-IN.md`](../../../../design/SIGN-IN.md) §2.4, §3.17, §3.18, §4.16 and
D-78–D-93. Where this brief differs, they win. **No device-wire version change**
(`PROTOCOL_VERSION` 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2; no corpus file). New UI copy uses
the owner's license vocabulary (SIGN-IN.md O-17: the tier pill and "{used} of {limit} devices" on
every row, no "Account-wide"). For this package:

- **Channels with `licenseChoice`.** Loopback, scheme and claimed HTTPS start through the pushed request with `licenseChoice` (`"app"` from a kit's inline or sheet form, `"card"` from the browser presentation and the terminals); `redirect/token` answers `choose` with a grant in app mode (I-04 §G.4). `signIn.start({channel, licenseChoice})`, `session.wait()`, `session.reopen()` and `session.cancel()` in all six SDKs.
- **The desktop ReturnStep** (`/signin/return`) gains the path B variant: "You're signed in · Go back to <App> to choose a license. You can close this tab." (`signin.return.chooseInApp`, frame 26).
- **Transcript:** `redirect-native-choose-app.json`.
- Mobile: `ASWebAuthenticationSession` and Custom Tabs stay the platform's own sheet; the kit's form morphs to step 3 when it closes (SIGN-IN.md D-92).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Native redirect (loopback, claimed HTTPS, scheme) on the same, now OAuth-shaped, authorize/token. signIn({redirect}) is named in api.json first.

## Goal

Desktop and mobile apps sign in by a native redirect: loopback, claimed-HTTPS and registered-scheme redirect URIs on I-08's code-exchange route, `signIn({redirect})` in all six SDKs with the system browser only, and `/auth/poll` retired.

## Why

Device code is a poor fit on a phone, and four native SDK rows are planned and unowned ([S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J9). I-08 already built the code exchange; this extends its redirect rules to native URIs.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); `plans/I-15.md` once approved; `plans/I-04.md`.
- [S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J9, [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (SDK table, `signIn({redirect})` row), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 13, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-15.
- `packages/worker/src/services/identity/oidc.ts:1871-1885`, `packages/worker/src/services/identity/index.ts:67` (the `/auth/poll` note), `packages/worker/src/core/cors.ts`.

## Scope

**In:**

- Native redirect URI classes on the token route: loopback (any port, RFC 8252), claimed HTTPS on the product's domains, per-product registered schemes.
- `signIn({redirect})`: Node and Python loopback, Swift `ASWebAuthenticationSession`, Kotlin Custom Tabs, Godot desktop OS browser plus loopback (device code elsewhere); React already has the web redirect.
- Retire `/auth/poll` and its rate-limit buckets; transcripts. **Correction (2026-10-06):** done
  early by fix/followups-sweep-1006 (route, `authPoll`/`authPollState` buckets, CORS row, OpenAPI
  path and `routeCoverage` row removed; no transcript or SDK used it). Nothing is left for I-15
  here beyond keeping it gone.

**Out** (and where it belongs instead):

- Web redirect (done in I-08).

## Design notes

- No non-http(s) schemes except per-product registered native schemes; never an embedded web view. Account credentials are entered only on the `key.plrs.im` login card (D17, decided by the owner 2026-10-04).
- Identity service only (owner, 2026-10-04): native redirect is app passthrough sign-in ("<App> wants you to sign in"), offered only for products with Identity on. The first sign-in to each app ends on "Continue to <App>" (D22).
- Cloud Sync needs sign-in (owner, 2026-10-04, final answers); native SDKs sign in by device code or QR until this lands, so it stays a soft dependency of the Cloud Sync SDK packages.
- Returns the activation response; no `PROTOCOL_VERSION` bump.
- Native sign-in in S-17's MVP is device code or QR until this lands; it is a soft dependency of U-06, U-07 and U-21.

## Steps

1. Plan, approved.
2. Redirect URI rules and the `/auth/poll` retirement.
3. Six SDKs and transcripts.

## Acceptance criteria

- [ ] Each URI class is accepted only as registered; unregistered schemes and hosts are refused (tests).
- [ ] `/auth/poll` no longer answers; discovery and transcripts updated.
- [ ] All six SDKs complete a redirect sign-in against transcripts; parity rows updated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity redirect
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- U-06, U-07 and U-21 switch native sign-in from device code to redirect where available.

The role agent sets `--set I-15 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-15 done`.
