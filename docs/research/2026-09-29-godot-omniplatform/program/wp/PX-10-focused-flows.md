# PX-10 Focused flows: free-device and download (`FocusedFlow`, return-URL allowlist)

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-04](PX-04-product-page-today.md), [PX-W1](PX-W1-library-api-media.md)                                                                                                                |
| Unblocks    | [I-26](I-26-legacy-oidc-license-choice.md)                                                                                                                                               |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W8.md`](../plans/PX-W8.md):** `next=` from activate is carried by PX-17, because this package is done.

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that every sign-in that binds a device asks the person which licence to use (**Choose a licence for this device**, with an inline **Replace a device** on full licences), never silently mints a second auto-issued licence, and treats the rank-first rule as the preselected default only. The verbatim decision, the card API and the delegated decisions are in [`plans/I-04.md`](../plans/I-04.md), "Owner decision (2026-10-05): licence choice at sign-in"; that section wins over this brief where they differ. **The device wire does not change** (`PROTOCOL_VERSION` 4, no corpus change).

This package is done. For the record:

- **Its focused flow is the fallback** behind the sign-in card's **Free a device** link:
  `/#/p/<slug>/free-device?for=<licenseId>&return=…`.
- **A return to the card** (the same-origin `/signin?request=rq_…`) must pass the return-URL
  allowlist. PX-14 carries that change.
- **Its Remove handler is extracted** into `freeAccountDevice()` by I-08. Behaviour does not
  change: the same ownership check, `portalDeviceDisconnect` budget, audit row and email. The
  card's inline **Replace a device** calls the same function.

## Goal

`#/p/:product/free-device?for=&return=` and `#/p/:product/download?platform=` render in minimal chrome (`FocusedFlow`) and return to the app only when the return URL matches a scheme or origin the product declares.

## Why

Targets of `manageUrl` and email links ([PORTAL.md §3.4](../../../../design/PORTAL.md#34-entry-points), [PORTAL.md §4.25](../../../../design/PORTAL.md#425-device-limit-focused-flow)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §3.3](../../../../design/PORTAL.md#33-routes), [PORTAL.md §3.4](../../../../design/PORTAL.md#34-entry-points), [PORTAL.md §4.25](../../../../design/PORTAL.md#425-device-limit-focused-flow)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `FocusedFlow` with the two flows; return-URL allowlist against the product's declared redirects.

**Out** (and where it belongs instead):

- `manageUrl` on the wire (→ PX-W8)

## Design notes

- **Return URLs** are accepted only when they match a declared scheme or origin; otherwise the flow ends on the product page (§3.3).

## Corrections (verified against the code, PX-10)

- **"The product's declared redirects" did not reach the portal.** The only return targets a
  product declares today are its exact browser origins (`web.origins`, P0-05); app schemes arrive
  with S-16 I-15 (native redirect), and the OIDC `redirectUris` are Polaris Key's own IdP
  callbacks, not app returns. PX-10 adds `returnTo: { origins, schemes }` to
  `GET /api/products/<p>` (origins from `web.origins`, schemes empty until the manifest can
  declare them), documented on the docs site's portal page (rule 10 for portal routes is
  narrative-only, PORTAL.md §10.1). No device-wire change.
- **The allowlist is exact:** same scheme, host and port for web origins, exact scheme for app
  links; `javascript:`, `data:` and the like are refused even when declared; credentials, control
  characters, whitespace and values over 2,048 characters are dropped; without a match the way
  back is the product page.
- **The library's "Free up a device"** keeps opening the product page's Devices section (inline
  remove); the focused flow is for apps and email links.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-10:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-10 in-review`.

## Acceptance criteria

- [ ] Return-URL allowlist tests (declared, undeclared, malformed).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-W8's `manageUrl` points here.

The role agent sets `--set PX-10 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-10 done`.
