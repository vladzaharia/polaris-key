# UK-42 Activation without an account in ui-core, the elements and React: the Done step after a key with the capability-aware recommendation, **Add your name and email** (hints, then keep and attach), the owned, waiting and other-email states, the AccountAndLicense row, copy keys and UI fixtures

| Field       | Value                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                            |
| Size        | 0.8–1.2 engineer-weeks                                                                                                  |
| Depends on  | [UK-03](UK-03-ui-core.md), [UK-05](UK-05-react-kit.md), [I-10a](I-10a-sdk-identity-node-react-python.md)                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-31](LX-31-holders-closeout.md), [UK-43](UK-43-activation-holders-native.md) |
| Role        | `pkey-sdk-porter`                                                                                                       |
| Plan mode   | no                                                                                                                      |
| Gates       | UI snapshots in both themes; modernity lint; kit copy drift gate (`gen:brand -- --check`); UI fixtures in every SDK     |
| Human input | none                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                               |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> In ui-core, the elements and React (rebuilt kits only). LX-31's global default waits for it; LX-39's per-product flips do not.

- Depends on: removed UK-44.
- UX rows that name this package: UX-47 (built by PX-17 (UK-42 in the kits)).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: appends its rows to `ui-matrix.json` (§4.8).

## Owner direction (2026-10-08)

- **Responsive.** Every kit screen adapts to its window, with landscape layouts where the window is landscape.
- **Resolution matrix.** Tested at every size in [UI-KITS.md](../../../../design/UI-KITS.md) §7.1, including 200% text or zoom.
- **Spacing and theming.** One spacing rhythm, and themable with `preset: "polaris-key" | "native"`, where `native` matches the platform.
- **Quality bar.** Meets the bar in `.claude/agents/pkey-ux-reviewer.md` ("a GOOD UI", good use of visual space), not just no overflow.
- **Review.** Several UX reviews (`pkey-ux-reviewer`), not one.
- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Goal

After a key activates, the kit's form shows a Done step that gently recommends keeping the product
in an account, with only the reasons the product really has; **Add your name and email** turns the
floating licence into an assigned one on the same licence without leaving the form's flow; and the
keys that already belong to someone have their own clear states.

## Why

The owner's activation rules ([S-24](../../notes/S-24-licence-holders.md) R1, R2): continue without
an account (the licence stays floating), recommend a name and email for Cloud Sync and the other
account features, and handle assigned keys. SIGN-IN.md §3.17 has no Done step after a key today.

## Read first

- AGENTS.md and CLAUDE.md.
- [S-24](../../notes/S-24-licence-holders.md) §5.8, §5.9, §9 (D13–D18); frames 42–48 in
  [`docs/design/sign-in/`](../../../../design/sign-in/).
- [SIGN-IN.md](../../../../design/SIGN-IN.md) §3.9, §3.17 (amended), §5.2 copy keys;
  [UI-KITS.md](../../../../design/UI-KITS.md) §1, §4.3 (amended), §4.8.
- [UK-03](UK-03-ui-core.md), [UK-05](UK-05-react-kit.md), [UK-44](UK-44-sdk-signin-hints.md),
  [I-10a](I-10a-sdk-identity-node-react-python.md) (attach, `choice.complete`).

## Scope

**In:**

- **ui-core models**: `ActivateDoneModel` (product row, the reasons computed from discovery:
  Cloud Sync only when the product's sync service is on, recovery and devices always, Identity off
  switches to the portal hand-off) and `AddToAccountModel` (name, email, `signIn.start({loginHint,
nameHint, purpose: "attach", licenseChoice: "app"})`, then `choice.complete({kind: "keep"})` and
  `attach({confirm: true})`, mapping `license_owned` to the owned state).
- **States**: Done after a key (frame 42); Add your name and email (43); Added (44); owned with
  D24's refusal on (45, completing `{kind: "key", key}` after sign-in); key sent to another email
  (46, the masked address); assigned and waiting (the "Sign in as a•••@…" line); in an account with
  the refusal off ("Sign in to turn on Cloud Sync here").
- **Continue without an account** everywhere a skip exists (D13) and the AccountAndLicense row "Not
  in an account · Add your name and email" (D14). The kit holds the key in memory only until Done
  closes.
- **Components** in the elements and React, three layers: drop-in (inside `SignIn` and
  `PolarisKeyGate`), styled (`<ActivateDone>`, `<AddToAccount>`), headless (`useActivateDone`,
  `useAddToAccount`).
- **Copy keys** in the kit copy catalog (`activate.done.*`, `activate.recommend.*`,
  `signin.attach.*`, `activate.owned.*`) per SIGN-IN.md §5.2; `gen:brand`.
- **UI fixtures** (UK-02b's format) for every state, so the native kits (UK-43) match.
- Motion: the body morph, the reason lines' stagger (three at most), one check draw; reduced motion
  instant.

**Out:**

- SwiftUI, Compose, Godot, Qt and terminals (→ UK-43). The SDK hint members (→ UK-44).

## Design notes

- Never block: the primary on Done is **Start using <Product>**; the recommendation is secondary.
- The email from `license.email` is shown masked (first character and domain).
- The recommendation shows once per activation, never again at launch.

## Steps

1. ui-core models and fixtures.
2. Elements and React components; copy keys; snapshots in both themes.
3. The React reference app path used by LX-31's e2e.

## Acceptance criteria

- [ ] Every state above renders from its fixture in both themes at the kit's sizes; the modernity
      lint is clean.
- [ ] Add your name and email ends with the same `licenseId`, the device signed in, and the licence
      in the account (integration test against the Worker).
- [ ] Cloud Sync is listed only when the product has it (test).
- [ ] `gen:brand -- --check` and the green gate pass (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/ui-core test
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm gen:brand -- --check
```

## Hand-off

UK-43 ports the same states from the fixtures; LX-31's e2e drives the React reference app.

The role agent sets `--set UK-42 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-42
done`.
