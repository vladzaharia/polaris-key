# H1 plan: kit contract fixes (ui-core rules, cli gate rows, fixture URLs)

Bug package H1 of the v0.9.15 ledger
(`_mockups/review/stabilization/bug-ledger.md`, B-122 to B-128), plus the lead's fixture item:
customer-facing URLs in `ui-matrix.json` still say `https://key.plrs.im`. Status: **awaiting
approval**. Nothing is implemented. Judged at `integ/next-stage` `3a94c7180`.

## 1. Summary

- **No wire change.** `PROTOCOL_VERSION` stays 4. `corpusVersion` stays 2. Nothing signed, no
  route, header, error code or JSON body changes. The only corpus file that changes is
  `conformance/corpus/v2/ui-matrix.json`, which is unsigned and generated, and its Godot mirror.
  `uiMatrixVersion` goes from 3 to **4**, once, for both halves.
- **Split.** The package is too big for one 1.5 h builder.
  - **H1a** (cli family; Node and Python terminal kits, ~1 h 15): B-123, B-124, B-125.
  - **H1b** (component families; all five model ports, ~1 h 30): B-122, B-126 and the fixture
    URLs.
  - B-127 and B-128 aren't corpus changes. CloudSyncStatus has no ui-matrix family, and catalog
    roles aren't pinned. They move to **H2**, which already edits kit copy and runs after H1
    (decision D1).
- **The rules move into ui-core and the generator.** React's `adaptStatus`, its
  `adaptActivate` base and title rules, elements' matching `withBase` cases and the matrix test's
  `leftOutFor` are deleted. Swift, Kotlin, Godot and Python follow the regenerated rows.
- **The cli gate rows change in four ways:**
  - every refusal has at least one way on;
  - `update apply` appears only for version-too-old;
  - not-entitled, channel-not-entitled and version-too-new lead with the product's page link;
  - a failed check fails closed: ✗ and exit 4.

## 2. Contract

`docs/security/WIRE-CONTRACT-V4.md`, `packages/shared-protocol`, `packages/shared-jws` and
`packages/client-core` are untouched. `PROTOCOL_VERSION` stays 4 because nothing that crosses the
wire changes:

- `ui-matrix.json` is the kits' presentation contract and has its own version;
- copy keys, fix rows and exit codes stay inside the app;
- the cli `--json` result line keeps `CLI_JSON_VERSION` 1, its shape, and the closed `error` set
  (`license_required`, `not_entitled`);
- no error code is added (`core.codes.sync-failed` and both gate errors already exist);
- the fixture URLs are inputs a kit passes through. `CUSTOMER_ORIGIN_DEFAULT` is already
  `https://polaris.locker` (`shared-protocol/src/core.ts:109`).

**Already deployed:** Workers are unaffected. Apps keep their old kit behaviour until they take
the next SDK. Mixed versions are safe because nothing on the server changes.

**One CLI-visible change:** a Node gate whose check throws used to crash (stack trace, exit 1).
It now refuses with exit 4, as Python already does. The Node README's "Changed in" list says so.

## 3. Catalog and manifests

`shared-catalog` and `shared-manifest` aren't touched, so rule 9 doesn't apply. The kit copy
catalog is touched:

- **H1a** adds `cli.gate.notIncluded` ("Your license doesn't include {command}", role `title`; D3)
  to `packages/brand/kit-copy/en.json` and the eight locale packs. Each locale value is a machine
  translation with `reviewed: false`, because `gen brand` refuses a key a pack lacks. It also
  updates the note on `cli.gate.needs` (now also a refusal title).
- **H1b** edits `packages/brand/kit-copy/components.json`. These are state lists only:
  - `StatusScreen.revoked` becomes `[core.gate.revoked.title, core.gate.revoked.message,
welcome.signIn, signin.key.differentKey]`;
  - `Activate.{typing,parsed,cut-short,rejected,busy}` gain the base five keys (`activate.title`,
    `activate.lede`, `part.keyField.label`, `part.keyField.placeholder`, `common.paste`).
- Regenerate with `pnpm gen brand`. That writes the web, Node, Python, Swift, Kotlin and Godot
  catalogs. `conformance/parity/copy.*.json` (core copy) is unchanged.

## 4. Corpus

Generator source: `tools/ui-matrix.ts`. `tools/ui-matrix.test.ts` is its test. Write with
`pnpm gen corpus`, which writes `ui-matrix.json` and the mirror
`sdks/godot/tests/corpus/v2/ui-matrix.json`; `pnpm gen ui-matrix` is the same writer. The drift
gate is `pnpm gen corpus --check`. Never hand-merge `ui-matrix.json`: regenerate it after a
rebase.

**Version.** `UI_MATRIX_VERSION` goes from 3 to 4. Both halves change rows ("a changed row, input
member or rule bumps it"). The first half to merge bumps the version; the second keeps 4 unless a
tag shipped in between (D2). The bump touches:

- `tools/ui-matrix.ts` (constant and header history);
- `tools/ui-matrix.test.ts:50`;
- the hand constants `packages/ui-core/src/vocabulary.ts:7` and
  `sdks/godot/addons/polaris_key/ui/model/vocabulary.gd:7`;
- `pnpm gen constants`, which writes Node, React, Python, Swift, Kotlin and Godot;
- `contribute/corpus.md:107`;
- `pnpm gen docs-reference` (`reference/protocol/corpus.mdx`).

### 4.1 H1a: the `cli` family (B-123, B-124, B-125)

New optional `CliGateInput` members:

- `mounted?: string[]`: absent means the end-user set;
- `portal?: false`: the kit knows no product page;
- `check?: "throws" | "unknown-status"`.

Changes to `CliGateExpect`:

- `outcome` gains `"fail"`;
- a new `link?: "portal" | "contact"` field: a link row above the fix rows.

`CliOutcomeExpect` gains `link?`. The new `refGate` rule:

| Case                                        | `copy` (drawn on stderr)                   | `link` | `fix`             | `error`            |
| ------------------------------------------- | ------------------------------------------ | ------ | ----------------- | ------------------ |
| usable, entitlement not held                | `cli.gate.notIncluded`                     | portal | `status`          | `not_entitled`     |
| `channel-not-entitled`                      | `core.gate.channel-not-entitled.title`     | portal | `status`          | `not_entitled`     |
| `version-too-new` (B-123)                   | `core.gate.version-too-new.title`          | portal | `status`          | `license_required` |
| `version-too-old`                           | `core.gate.version-too-old.title`          | –      | `update apply`    | `license_required` |
| `needs-activation` (refused)                | `cli.gate.needs`                           | –      | `activate, login` | `license_required` |
| `expired`, `revoked` (refused)              | `core.gate.<status>.title`                 | –      | `activate, login` | `license_required` |
| `check: throws` or `unknown-status` (B-125) | `core.codes.sync-failed.message`, `.title` | –      | none              | `license_required` |

The table's cases and rules:

- **Refusals.** A refusal is ▲ with exit 4. The message line is gone, because a fix row always
  follows (UK-46 #15).
- **Mount filter.** Fix verbs are filtered by `mounted`. If none is left, the link row is the
  fix, so a refusal never has zero rows (UK-46 #1). `portal: false` turns `link: portal` into
  `link: contact`: `status.contact` with the developer's name.
- **`fail`.** The command doesn't run. It shows ✗ with what happened, exits 4 (fail closed) and
  has no fix row.
- **`--json`.** Rows keep the same `result` line.

New rows (72 become 85):

- 8 `check` rows (2 × tty × json);
- 3 `portal: false` rows (entitlement, channel, too-new);
- 2 `mounted` rows (too-old without `update apply`; needs-activation with `["status"]`).

New outcomes:

- situation `status-channel-not-entitled`;
- `status-version-too-new` and `status-channel-not-entitled` give `fix: []`, `link: "portal"`,
  so `status` is no longer a loop.

`checkCli` changes:

- a refusal has `fix` or `link`;
- `fail` is ✗ with exit 4 and no fix;
- copy keys may be kit keys (found in `kitEn`);
- `mounted` verbs must be verbs.

The `vocabulary.cli.sections.gate` text is updated to match. If Package G has merged B-113, H1a
also adds the `update-apply-handoff` situation pinning G's exit code. H1a is the corpus owner.

### 4.2 H1b: component rows (B-122, B-126, fixture URLs)

- **StatusScreen/revoked** (`all`, now Sign in plus Use a different key). It gets a `mustNot`
  with `copy: ["common.signOut"]` and the invariant "offer Sign out on a device already signed
  out". Three new rows:
  - `capabilities.signIn: false`, which drops `welcome.signIn` and makes `differentKey` the
    primary;
  - `services: off("identity")`, the same;
  - `capabilities.keyEntry: false`, which drops `differentKey`.
- **Activate typing, parsed, cut-short and busy** keep `all`, which now carries the base. The five
  explicit `rejected` rows become base plus the refusal **message only**, for example
  `[...BASE, "core.activation.license-disabled.message"]`.
- **Fixture URLs (D8).**
  - `MANAGE_URL` (`:704`) and `FREE_DEVICE_URL` (`:731`) become
    `https://polaris.locker/#/p/tidewater/free-device?…`.
  - `GET_LICENSE.activateUrl` (`:801`) becomes `https://polaris.locker/activate?product=tidewater`.
  - These are the shapes `core/licensing/manageUrl.ts` and `identity/passthrough/choice.ts` build
    on `CUSTOMER_ORIGIN`.
  - No model reads the host (`ui-core/src/link.ts` is host-agnostic), so no runner logic changes.

## 5. SDKs and kits, in order

| Half | Who must follow     | Change                                                                                                                                                                                                                                                                                                                                                                                  | Runner that proves it                                                                                                                                                    |
| ---- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1a  | ui-core terminal    | `statusView` (`src/terminal.ts:529-549`): version-too-new and channel get `link: "portal"` instead of the undrawable `status.switchChannel` row                                                                                                                                                                                                                                         | `packages/ui-core/test/terminal.test.ts`                                                                                                                                 |
| H1a  | Node terminal kit   | `cli/gate.ts`: new `refusalFor`; link row through `portalUrl(client)` (contact when it has none); catch around all of `gateCall`/`runGate` (client build included) with a `_fail_closed` twin; unknown status means fail, never "revoked". `cli/flows.ts` StatusScreen branch draws the link                                                                                            | `test/cli/cliContract.test.ts`, `cliGate.test.ts`; goldens `gate-refused-*`, `status-screen-{version-too-new,channel-not-entitled}` (`PKEY_UPDATE_GOLDENS=1`)            |
| H1a  | Python terminal kit | `cli/gate.py` `_refusal` to the same table; unknown status means fail; `_fail_closed` draws ✗ with no `status` row. `ui/terminal/screens.py:186-191`: too-new and channel draw the link; the `update --channel <name>` row goes (it isn't a verb)                                                                                                                                       | `tests/cli/test_cli_contract.py`, `test_cli_gate.py`; goldens `scenes/gate-*`, `status-screen-*` (`PKEY_GOLDEN=record`); `terminal-parity.json` (`PKEY_UPDATE_PARITY=1`) |
| H1b  | ui-core             | `models/gate.ts:277-284`: revoked copy is `[...head, signIn && "welcome.signIn", key && "signin.key.differentKey"]`, where `signIn = caps.signIn && on("identity")` (Welcome's predicate) and `key = caps.keyEntry`; primary is Sign in, else the key. `models/activate.ts`: `BASE` merged into typing, parsed, cut-short, rejected and busy; a rejected refusal keeps only its message | `test/uiMatrix.test.ts`, `decisions.test.ts:75` (primary is now `welcome.signIn`)                                                                                        |
| H1b  | React               | `kit/adapt.ts`: delete `adaptStatus` and `adaptActivate`'s base and title rules, keeping only its drawing-only danger tone (D7); update the `component.tsx` call sites                                                                                                                                                                                                                  | `test/kitMatrix.test.tsx`, `kitGate.test.tsx`, `kitDrive.test.tsx`, `kitPolish.test.tsx`                                                                                 |
| H1b  | elements            | `src/views.ts` `withBase`: delete the StatusScreen case and Activate's base and title-filter lines (keep `activate.submit`, `common.back` and the tone). `test/matrix.test.ts`: delete `leftOutFor`'s Activate and StatusScreen branches, `signInOffered` and both revoked special cases (`:208-225`, `:233-237`)                                                                       | `test/matrix.test.ts`, `uk04Fix.test.ts`; `pnpm ui:report` (React vs elements, no drift)                                                                                 |
| H1b  | Swift               | `PolarisKeyUICore/States/GateFamily.swift:193`, `ActivateFamily.swift`. Drawing: `Kit/Screens/GateScreens.swift:170-177` puts `welcome.signIn` first in `fixes`; `Kit/PolarisKeyGate.swift:165` routes `welcome.signIn` to sign-in                                                                                                                                                      | `Tests/PolarisKeyUICoreTests/UIMatrixTests.swift`                                                                                                                        |
| H1b  | Kotlin              | `ui-core/.../KitGateStates.kt:130`, `KitActivationStates.kt`. Drawing: Compose `ui/src/androidMain/.../PolarisKitScreen.kt` routes Sign in on StatusScreen                                                                                                                                                                                                                              | `:ui-core:test` (`UIMatrixPresentationTest.kt`); Compose only in the Android CI lanes                                                                                    |
| H1b  | Godot               | `ui/model/gate.gd:243-245`, `ui/model/activate.gd`. Drawing: check `ui/gate/gate_controller.gd`; it may not draw StatusScreen from the model yet (miner B5), in which case it's model-only                                                                                                                                                                                              | `tests/suite_ui_core.gd` (mirror)                                                                                                                                        |
| H1b  | Python              | `ui/core/ui_gate.py:240-242`, `ui/core/ui_activate.py`. The Qt layout is key-driven (`qt/layout.py` already treats `signIn` as a control); check that Qt routes Sign in on StatusScreen (`qt/kit.py`, after G)                                                                                                                                                                          | `tests/test_ui_gate_matrix.py`, `test_ui_activate_matrix.py`, `test_ui_contract.py`                                                                                      |

Everyone else reads only the new `UI_MATRIX_VERSION`. The cli family is N/A outside Node and
Python (`ui.cli.contract`). `features.json` and every `parity.json` are unchanged.

**Specs and docs:**

- `docs/design/UI-KITS.md:989`: StatusScreen revoked becomes ("Sign in", "Use a different key");
- `:554`: the gate paragraph gains the link row and fail-closed;
- `build/ui/frameworks/terminal-{node,python}.mdx`: a failed check exits 4; a refusal the license
  can't fix links to the product's page.

## 6. Worker

None: no route, migration, table, transcript or generated Worker page.

Out of scope, recorded as follow-ups (D8):

- the transcript harness runs without `CUSTOMER_ORIGIN`, so recorded links say `key.plrs.im`
  (only `locker-refusal-links.json` shows `polaris.locker`);
- the same holds for the Worker email snapshots: `portalNotices`, `lockerMail`,
  `customerEmailHtml` and `licenseCreateDelivery`.

## 7. Rollout and commit order

There are no flags, and the ship order is H1b then H1a; both must land before the v0.9.15 tag.

- **H1b first.** It doesn't depend on G.
- **H1a after Package G merges.** H1a edits G-owned `cli/flows.ts` and
  `ui/terminal/screens.py`. G must not touch `cli/gate.ts` or `cli/gate.py`.
- **H2 after both.**

Each half lands in one merge, with commits in this order:

1. Generator, copy, regeneration and version bump:
   - `tools/ui-matrix.ts` and its test;
   - `components.json` or `en.json` plus the locale packs;
   - `pnpm gen brand`, `pnpm gen corpus`, `pnpm gen constants` and the hand constants;
   - `pnpm gen docs-reference`.
2. ui-core.
3. Web kits (H1b) or the Node kit (H1a).
4. One commit per native port (H1b) or the Python kit (H1a), each with its goldens re-recorded
   and the reason in the message.
5. Specs and docs.

## 8. Decisions for the lead (each with a recommendation)

- **D1 Split.** H1a (cli), H1b (components plus URLs), and B-127/B-128 to H2. Recommended. H2's
  scope gains:
  - B-127: a `cloudSync.canReview` input; Review only when the host handles it. A signed-out
    error becomes a new `cloudSync.signedOut` line plus `cloudSync.signIn`, in a neutral tone.
    The conflict line is trimmed to "Some changes conflict." ui-core `settings.ts:302-319` and
    Godot `settings.gd:293-310` change.
  - B-128: flip `signin.handoff.noBrowser` from body to title. Swift already draws it as the
    heading. There's no new key.
- **D2 Version.** One bump to 4, shared by both halves. Recommended.
- **D3 Entitlement refusal title.** A new `cli.gate.notIncluded`, "Your license doesn't include
  {command}" (recommended; the person has a license), rather than the ledger's `cli.gate.needs`.
  `cli.gate.needs` stays for needs-activation only. Expired, revoked and the version and channel
  refusals keep their own core titles ("a distinct License expired refusal").
- **D4 Link target.** The kit's `portalUrl`, as G's B-115 leaves it. When there is none, Contact
  {developer}. Recommended. If G ships no "no portal" path, H1a drops the 3 `portal: false` rows
  and records them as a follow-up.
- **D5 Failed check.** ✗, exit 4, no fix row. Recommended: it's a failure, not a refusal (DL6).
  Python changes from ▲ plus `status`.
- **D6 Revoked.** Sign in first when sign-in is offered, Use a different key when key entry is
  on, never Sign out. Keep the core message (H2 rewords it).
- **D7 Activate base.** Typing, parsed, cut-short, rejected and busy (React's set) all carry it.
  Tone stays unpinned: ui-core says neutral, and the web kits keep danger for a refused key. H2
  settles it.
- **D8 URLs.** Change only the three ui-matrix constants. Leave the rest:
  - `sync-scenarios.json` `SIGN_IN_URL`: an echo of the server; changing it would bump
    `syncScenariosVersion` in every SDK;
  - transcripts and Worker snapshots: a follow-up that sets `CUSTOMER_ORIGIN` in the harness
    env;
  - SDK unit fixtures: opaque strings;
  - developer-visible previews and examples (`PolarisKeyUICore/PreviewStates.swift`,
    `examples/ui/*/fixtures.ts`): a NAME follow-up.
  - Keep `iss`, the feed URLs and the problem `type` docs links on `key.plrs.im`: they're wire
    or developer-facing.

**Risks:**

- **Native screens with hard-coded layouts.** A screen with a fixed key order (Swift `fixes`) or a
  hard-coded Activate title can double a title or miss Sign in. Mitigation: look at each kit's
  screen in one screenshot per state.
- **Compose is tested only in the Android lanes.** Run it on `heavy.sh` or rely on CI.
- **Locale values are machine translations.** They need the H2 or I-08 translation review.
- **The generated file conflicts with any other corpus owner.** The ledger names H1 as the only
  one.

## 9. Acceptance

```sh
pnpm gen --check                      # corpus (+ Godot mirror), brand, constants, docs-reference
mise exec node@22 -- pnpm --filter @polaris-key/ui-core test
mise exec node@22 -- pnpm --filter @polaris-key/elements test
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm --filter @polaris-key/node test test/cli
mise exec node@22 -- pnpm --filter @polaris-key/tools exec vitest run ui-matrix.test.ts
pnpm ui:lint && pnpm ui:report        # no React/elements drift
( cd sdks/python && .venv/bin/python -m pytest -q tests/cli tests/test_ui_gate_matrix.py tests/test_ui_activate_matrix.py tests/test_ui_contract.py )
( cd sdks/swift && swift test --filter PolarisKeyUICoreTests )
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :ui-core:test )
sdks/godot/tools/run_tests.sh
rg -n "adaptStatus|leftOutFor|signInOffered" packages/sdk-react/src packages/elements   # none
rg -n "key\.plrs\.im/(activate|#/p/)" conformance/corpus/v2/ui-matrix.json              # none
```

Then run `$PKEY_LEAD/gate.sh` once, scoped to the branch.
