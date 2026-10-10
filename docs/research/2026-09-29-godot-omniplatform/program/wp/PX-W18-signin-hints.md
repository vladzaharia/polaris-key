# PX-W18 Sign-in hints on the identity request: optional `loginHint`, `nameHint` and `purpose: "signin" | "attach"` on the pushed request and `login_hint` on `authorize`; the card prefills CodeStep and RegisterStep and never skips verification; new transcripts and the `identity.signin.hints` parity row

| Field       | Value                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                            |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                             |
| Depends on  | none                                                                                                                                                               |
| Unblocks    | none                                                                                                                                                               |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                              |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/PX-W18.md` first; nothing is built before a human approves it                                                               |
| Gates       | plan mode; rule 10 (OpenAPI + `routeCoverage`); transcripts (`gen transcripts`, Swift and Godot mirrors); `features.json` + `gen constants`; THREAT-MODEL; workerd |
| Human input | approval of `plans/PX-W18.md`                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                          |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [I-08](I-08-app-passthrough.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [I-08](I-08-app-passthrough.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Same pushed request and authorize route: hints become login_hint on the OAuth-shaped authorize, one wire event not two.

- Dependencies cleared on closing (they were PX-W13, I-08 and I-07), so nothing in the graph waits on or through a closed package.

## Goal

An app can start a sign-in with the email and name the person just typed, and the login card opens
with that email ready for a code and that name ready for a new account, without the hint ever
counting as verification; the card can also say "Add <Product> to your account".

## Why

The owner wants the activation wizard to recommend adding a name and email
([S-24](../../notes/S-24-licence-holders.md) R1). Credentials stay on the card (D17 of S-16), so the
app collects the two values and hands them over (D15). The pushed request (PX-W13 §2.5) and the
`authorize` redirect (I-08) carry no such members yet. This is a device-facing request change, so
it is plan mode (CLAUDE.md), even though it touches no signed document and no corpus.

## Read first

- AGENTS.md (rules 1, 2, 3, 10) and CLAUDE.md (plan mode).
- [S-24](../../notes/S-24-licence-holders.md) §6.4, §7.2, §9.2 (D15, D23).
- [SIGN-IN.md](../../../../design/SIGN-IN.md) §3.3, §3.4, §3.17, §6.5 and the new §6.6.
- [`plans/PX-W13.md`](../plans/PX-W13.md) §2.5, [`plans/I-04.md`](../plans/I-04.md) §G.2,
  [I-08](I-08-app-passthrough.md), [I-07](I-07-login-card-email.md).

## Scope

**In (for the plan to fix exactly):**

- `POST /<p>/identity/request` accepts optional `loginHint` (an email, ≤ 254, normalised like
  I-07's input), `nameHint` (≤ 80, trimmed, control characters stripped) and
  `purpose: "signin" | "attach"` (default `"signin"`), stores them on the request record, and echoes
  `purpose`. `GET /<p>/identity/authorize` accepts `login_hint` (OIDC's name).
- The card: a valid `loginHint` prefills MethodsStep's email and goes straight to CodeStep with
  "We sent a code to …" and **Use a different email**; `nameHint` prefills RegisterStep's name only
  for a new account; `purpose: "attach"` switches the header line, Consent and ReturnStep to the
  attach copy (SIGN-IN.md §5.2 `signin.attach.*`). No rule, binding or verification changes.
- Invalid hints are ignored silently (never an error to the app).
- Transcripts `identity-request-hints.json` (recorded through the Worker router) with the Swift and
  Godot mirrors; `features.json` row `identity.signin.hints`; `gen constants`; OpenAPI and
  `routeCoverage`.
- THREAT-MODEL T-H5: a hint never verifies an address; a hint for another person's email only
  sends that person a code they did not ask for, under I-07's per-recipient limits.

**Out:**

- The SDK members (→ UK-44) and the kit screens (→ UK-42, UK-43).

## Design notes

- `PROTOCOL_VERSION` stays 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2: additive, opt-in, on routes
  whose shapes are not frozen yet (SIGN-IN.md §6.5 precedent). An old Worker ignores the members.
- The hints never appear in a URL the Worker builds; `login_hint` on `authorize` is the app's own
  choice, as in OIDC.

## Steps

1. The planner writes `plans/PX-W18.md` (shapes, normalisation, card behaviour, transcripts, the
   SDKs UK-44 must follow) and sets `awaiting-approval`.
2. After approval: request record, `authorize`, card prefill and copy, transcripts, parity row,
   OpenAPI.

## Acceptance criteria

- [ ] `plans/PX-W18.md` is approved before any code.
- [ ] A hinted request opens CodeStep for that email; the account is created or signed in only after
      the code (test); a new account's name is prefilled from `nameHint` (test).
- [ ] Invalid hints are ignored (test).
- [ ] Transcripts and mirrors regenerate cleanly (`gen transcripts --check`); `parity:check` and
      `gen constants --check` pass.
- [ ] The green gate passes (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm gen transcripts --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity request routeCoverage
```

## Hand-off

UK-44 replays the transcripts in six SDKs; UK-42 and UK-43 call `signIn.start({loginHint,
nameHint, purpose: "attach"})`.

The role agent sets `--set PX-W18 in-review` when it hands off. After review, the lead adds the
last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set
PX-W18 done`.
