# UIM-05 plan: kit gaps the matrix pins (too new keeps Try again, the paywall hands off, offline activation in two numbered steps)

The KP-web spec pass (staged at `a143ee0a7`) left three places where `docs/design/UI-KITS.md` and
the shipped kits disagree and only a `ui-matrix.json` or kit-copy change can settle them
(`_lead/lead-followups.md`, KP-web line). Status: **awaiting approval**. Nothing is implemented.
Judged at `integ/next-stage` `a143ee0a7`; the approved DENY-01 plan (`a09460f7f`, filed as I-37c)
touches none of the files below except the shared version line.

**Proposed work-package row** (not added to `workpackages.json`; see D8 for the id):

| Field         | Value                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| id            | `UIM-05`, filed as **`UK-64`** with `planRef: "UIM-05"` (D8)                                                                            |
| title         | Kit gaps the matrix pins: version-too-new keeps Try again, Paywall not-available hands off to the portal, OfflineActivation's two steps |
| phase / lane  | `UK` / `parity`                                                                                                                         |
| role          | `pkey-implementer` (step A), then `pkey-sdk-porter` (steps B1, B2) on the same branch                                                   |
| estimateWeeks | `[0.4, 0.6]`                                                                                                                            |
| deps          | `I-37c` (shares `uiMatrixVersion` 5, D1); KP-web (done). KP-python and KP-compose may add gaps (§8.3)                                   |
| planMode      | `true`                                                                                                                                  |
| gates         | `plan-mode`, `corpus`, `drift-gate`, `all-sdks`, `ui-snapshots`, `docs-links`                                                           |
| humanInputs   | D1–D8 below                                                                                                                             |
| refs          | `plans/UIM-05.md`; UI-KITS DL4, DL5, DL6, DL8, DL14, §4.1; `plans/H1-kit-contract-fixes.md` (the Activate-base precedent)               |

## 0. The gaps

| Gap                       | Spec (`docs/design/UI-KITS.md`)                                                                                                                                                                     | `ui-matrix.json` today                                                                                                                                                               | Kits today                                                                                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Version too new         | DL6 (l. 207–209): "Every blocking state has an action that can change its outcome … A fix the kit cannot reach is named in words, and Try again stays." DL4: a lone action is the primary           | Both `StatusScreen/version-too-new` rows pin title, message and the range line: no control, no action                                                                                | React and elements draw a dead end. Swift (`GateScreens.swift:222`), Compose (`PolarisGate.kt` Message screen) and Godot (`gate_controller.gd` `controls_for`) add Try again outside their models                                                                 |
| 2 Paywall not available   | §4.1 Paywall (l. 1001): "Web checkout waits for the owner's `commerce: go`; until then 'not available here' hands off to the portal"                                                                | `Paywall/not-available: the web waits for checkout` pins `paywall.notAvailable` only; `vocabulary.inputs.offers` is `{available, purchased?}`                                        | elements adds `paywall.title` and `paywall.portal` when `offers.url` is set (`views.ts:723-730`, `review.test.ts:642`); React, Swift, Kotlin and Godot follow the matrix                                                                                          |
| 3 OfflineActivation steps | §4.1 (l. 990): "Two numbered actions: 1 send the request (the code with Copy, and a QR), 2 load the response (file, drop or paste), then the verdict." DL14: a QR for an offline-activation request | `default` lists the whole form; `loaded`, `rejected-signature` and `done` list only their delta. No key names the request QR (`a11y.qr` reads "QR code that opens the sign-in page") | elements re-adds the form in `withBase` (`views.ts:762-792`) and labels its QR `a11y.qr`; React draws only the paste box. Godot draws "1 Send this code" from its own table (`pkey_ui_copy.gd:134`); Swift hard-codes "Request code" (`PolarisKitCopy.swift:118`) |

## 1. Summary

- **No wire change.** `PROTOCOL_VERSION` stays 4 and `corpusVersion` 2. The only corpus file is
  the unsigned, generated `ui-matrix.json` and its Godot mirror. It rides I-37c's
  `uiMatrixVersion` **5**: one bump for both packages (D1).
- **Version too new keeps Try again** as its one control and primary (action `retry`, D2).
- **Paywall not-available hands off** through `paywall.portal` when the host passes a valid
  `offers.url`, under `paywall.title` (D3). A missing or non-https link shows no control.
- **OfflineActivation carries its two-step form in every state** (H1b's Activate-base precedent).
  The kit draws the step numbers; the existing sentences are the steps. A new `a11y.qrRequest`
  names the request QR, the product line goes (DL5), and Done gets a title and a button (D4–D7).
- **Catalog:** one new key, one reworded key, one deleted key, four state lists. No new
  argument and no new action.

## 2. Contract

`WIRE-CONTRACT-V4.md`, `shared-protocol`, `shared-jws` and `client-core` are untouched. No
route, header, error code, signed shape or JSON body changes. `offers.url` is a kit input the
host passes, like the ui-core input that already has it (`ui-core/src/input.ts:333`). It is
validated by the opener every link passes (`ui-core/src/link.ts`, client-core `isManageUrl`).

**Already deployed:** Workers are unaffected. Apps keep their kit until they take the next SDK.

## 3. Catalog

`shared-catalog` and `shared-manifest` aren't touched (rule 9 doesn't apply). Kit copy changes:

**`packages/brand/kit-copy/components.json`** (state lists; `componentsVersion` stays 1):

- `StatusScreen.version-too-new`: add `common.tryAgain`.
- `Paywall.not-available`: `[paywall.title, paywall.notAvailable, paywall.portal]`.
- `OfflineActivation`, with `BASE = [offlineActivation.title, offlineActivation.request,
offlineActivation.copyCode, a11y.qrRequest, offlineActivation.loadHint, offlineActivation.loadFile,
offlineActivation.paste, offlineActivation.dropHint, offlineActivation.submit]`:
  - `default`: `BASE` (`offlineActivation.product` out, `a11y.qrRequest` in);
  - `loaded`: `BASE` + `offlineActivation.codeCopied` + `offlineActivation.empty`;
  - `rejected-signature`: `BASE` + `core.codes.bundle-jws-rejected.message` (the title goes);
  - `done`: `[offlineActivation.title, offlineActivation.done, common.done]`.

**`en.json` and the eight packs** (`kitCopyVersion` stays 1; every pack keeps `reviewed: false`):

| Key                          | Change   | en (role)                                                            | de · fr · es · pt-BR                                                                                                                                                                                                                                                                                               | it · ja · ko · zh-Hans                                                                                                                                                                                                                                 |
| ---------------------------- | -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `a11y.qrRequest`             | new      | "QR code with the request code" (`a11y`)                             | QR-Code mit dem Anforderungscode · Code QR contenant le code de demande · Código QR con el código de solicitud · Código QR com o código de solicitação                                                                                                                                                             | Codice QR con il codice di richiesta · リクエストコードのQRコード · 요청 코드가 담긴 QR 코드 · 包含请求代码的二维码                                                                                                                                    |
| `offlineActivation.loadHint` | reworded | "Load the activation file you get back, or paste its text." (`body`) | Laden Sie die Aktivierungsdatei, die Sie zurückerhalten, oder fügen Sie ihren Text ein. · Chargez le fichier d’activation que vous recevrez en retour, ou collez son texte. · Carga el archivo de activación que recibas, o pega su texto. · Carregue o arquivo de ativação que você receber ou cole o texto dele. | Carica il file di attivazione che ricevi o incollane il testo. · 返送されたアクティベーションファイルを読み込むか、そのテキストをペーストしてください。 · 받은 활성화 파일을 불러오거나 그 내용을 붙여넣으세요. · 载入你收到的激活文件，或粘贴其文本。 |
| `offlineActivation.product`  | deleted  | was "Product: {product}"                                             | deleted in all eight                                                                                                                                                                                                                                                                                               | deleted in all eight                                                                                                                                                                                                                                   |

The `loadHint` packs only lose their "then" word; the rest of each sentence is unchanged. Notes
change on `offlineActivation.request` ("step 1"), `loadHint` ("step 2; the kit's number marker
carries the order") and `paywall.portal` (also the not-available hand-off). `common.tryAgain`,
`paywall.title` and `paywall.portal` already exist in nine locales.

Regenerate with `pnpm gen brand`, which writes the web, Node, Python, Swift
(`Localizable.xcstrings`, `kit-copy.json`), Kotlin (`composeResources` ×9) and Godot (`.po`,
`.pot`) tables. `conformance/parity/copy.*.json` is unchanged.

## 4. Corpus

Generator `tools/ui-matrix.ts`, test `tools/ui-matrix.test.ts`. Write with `pnpm gen ui-matrix`
and `pnpm gen corpus` (which also writes the mirror `sdks/godot/tests/corpus/v2/ui-matrix.json`).
The drift gate is `pnpm gen corpus --check`. Regenerate after a rebase; never hand-merge.

**Version (D1).** These are changed rows, a changed input member and changed state lists, so
the file needs a new version. I-37c bumps 4 → 5 after the v0.9.15 tag; UIM-05 rides the same 5
and adds its line to the header history. If UIM-05 merges first, it does the bump instead and
I-37c keeps 5. The bump touches `UI_MATRIX_VERSION` (`tools/ui-matrix.ts:48`), the test's pin
(`:50`), the hand constants (`ui-core/src/vocabulary.ts:7`, Godot `ui/model/vocabulary.gd:7`),
`pnpm gen constants` and `contribute/corpus.md:107`. Header line:

> Version 5 (I-37c, UIM-05): SignInHandoff `failed` and the `login` denied and failed outcomes;
> StatusScreen/version-too-new keeps Try again; Paywall/not-available hands off to a valid
> `offers.url`; OfflineActivation carries its two-step form in every state, the request QR's own
> label and no product line.

**Rows** (`+` is a new row; copy is listed unsorted, the file sorts it):

| Row                                                                              | Input                                                                      | Copy                                                     | Actions | Must not                                                                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `StatusScreen/version-too-new: a maximum, never a generic error`                 | unchanged                                                                  | title, message, `status.allowedMax`, `common.tryAgain`   | `retry` | unchanged                                                                                          |
| `StatusScreen/version-too-new: a range`                                          | unchanged                                                                  | title, message, `status.allowedRange`, `common.tryAgain` | `retry` | –                                                                                                  |
| + `StatusScreen/version-too-new: Try again stays when no range is known`         | `gate: {status: "version-too-new"}`                                        | title, message, `common.tryAgain`                        | `retry` | –                                                                                                  |
| `Paywall/not-available: the web waits for checkout`                              | unchanged (no `url`)                                                       | `paywall.title`, `paywall.notAvailable`                  | –       | states `offers`, `purchasing`; copy `paywall.portal`                                               |
| + `Paywall/not-available: hands off to the portal`                               | `{platform: WEB, entitlement, offers: {available: false, url: PORTAL}}`    | + `paywall.portal`                                       | –       | –                                                                                                  |
| + `Paywall/not-available: a link that is not https is never offered`             | the same, `url: "http://tidewater.example/buy"`                            | `paywall.title`, `paywall.notAvailable`                  | –       | copy `paywall.portal`; invariant "open a link that is not https (DL14)"                            |
| `OfflineActivation/default`                                                      | unchanged                                                                  | `all` = `BASE`                                           | –       | –                                                                                                  |
| + `OfflineActivation/default: the request QR on a phone too`                     | `{platform: IPHONE, capabilities: {offlineActivation: true}, offline: {}}` | `BASE`                                                   | –       | –                                                                                                  |
| `OfflineActivation/loaded: …copied`, `…not yet an activation`, `…nothing loaded` | unchanged                                                                  | `BASE` + their delta (`codeCopied`; none; `empty`)       | –       | unchanged                                                                                          |
| `OfflineActivation/rejected-signature`                                           | unchanged                                                                  | `BASE` + `core.codes.bundle-jws-rejected.message`        | –       | states `done`; copy `offlineActivation.done` (§4.1 "treat a loaded file as a verified activation") |
| `OfflineActivation/done`                                                         | unchanged                                                                  | `all` (title, done, `common.done`)                       | –       | –                                                                                                  |

`PORTAL` reuses `GET_LICENSE.activateUrl` (`https://polaris.locker/activate?product=tidewater`,
the page the Worker's `choice.ts` builds). The presentation-absent twin follows `default`.
`EXTRA_MUST_NOT` gains Paywall's DL14 invariant (the test holds the table). Counts: gate +1,
activate +1, paywall +2 over I-37c's file. `vocabulary.inputs.offers` becomes: "{available,
purchased?, url?}: url is the https page that sells the offer outside the app (a store page or
the product's Polaris Locker page), from the integrator or the server; the hand-off shows only
when the opener accepts it (DL14)." `actions`, `actionKeys` and every other family are unchanged;
`paywall.portal` stays a host control like `paywall.upgrade`, so no action is added.

Then `pnpm gen docs-reference` (`reference/protocol/corpus.mdx` counts).

## 5. SDKs and kits, in order

Step A then B1 and B2, one branch, one merge (D8). Every runner below runs every row; none skips.

| Step | Kit                       | Model change                                                                                                                                                                                                                                                                                                                                           | Drawing change                                                                                                                                                                                                                                                                                                                             | Proof (tests, baselines)                                                                                                                                                                                         |
| ---- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | ui-core (every JS kit)    | `models/gate.ts:315-322`: `common.tryAgain`, primary. `models/settings.ts:244-250`: title, message, `paywall.portal` only when `linkVerdict(offers.url, platform, "purchase").url`, primary and `link` set then. `models/activate.ts:297-354`: `BASE` in every non-done state; rejected keeps the message; done adds title and `common.done` (primary) | –                                                                                                                                                                                                                                                                                                                                          | `test/uiMatrix.test.ts`; `decisions.test.ts` `:86` (`refusal("common.tryAgain")`), `:130-140`, `:336`                                                                                                            |
| A    | elements                  | –                                                                                                                                                                                                                                                                                                                                                      | `src/views.ts`: delete the `withBase` `Paywall` (`:723-730`) and `OfflineActivation` (`:762-792`) cases; the `own` list (`:237`) and `offlineSteps` (`:1929`) key the QR on `a11y.qrRequest`                                                                                                                                               | `test/matrix.test.ts` (`LEFT_OUT` loses `offlineActivation.product`, `:186-191` simplified), `review.test.ts:642`; no elements baselines exist                                                                   |
| A    | React                     | –                                                                                                                                                                                                                                                                                                                                                      | `kit/views.tsx:145`: the two numbered steps (marker, sentence, code with Copy and the QR; paste, Load file, drop hint), as the elements draw them. `kit/parts.tsx:724` `qrCode` takes its key. `drive.tsx`: Try again re-checks (`:133` exists); `paywall.portal` opens `offers.url` through `links.ts`                                    | `test/kitMatrix.test.tsx`, `kitPolish`, `kitGate`; re-record `test/visual/__screenshots__/{StatusScreen.version-too-new, Paywall.not-available, OfflineActivation.*}` (24 PNGs, `test:visual`); `pnpm ui:report` |
| B1   | Swift                     | `PolarisKeyUICore/States/GateFamily.swift:212-218`, `SettingsFamilies.swift:151` (`KitOffers.url` added, `KitLinks.valid`), `ActivateFamily.swift:241-280`                                                                                                                                                                                             | `Kit/Screens/GateScreens.swift:222`: draw Try again from the model's line, not a constructed one. `PolarisOfflineActivation.swift`: step markers; the QR's label `a11y.qrRequest`; drop the "Product:" and "Request code" lines (`PolarisKitCopy.offlineProductLabel`, `requestCodeLabel` removed). `PaywallView` already draws from lines | `Tests/PolarisKeyUICoreTests/UIMatrixTests.swift`; snapshots `status-screen-version-too-new-*`, `paywall-not-available-*` (`examples/ui/swiftui/run.sh`)                                                         |
| B1   | Kotlin, Compose           | `ui-core/.../KitGateStates.kt:145-149`, `KitSettingsStates.kt:131`, `KitActivationStates.kt:171-215`                                                                                                                                                                                                                                                   | `ui/.../PolarisKitScreen.kt`: OfflineActivation's two steps and `PolarisQrCode` (`PolarisSignIn.kt:598`) labelled `a11y.qrRequest`. The gate's Message screen keeps its Try again                                                                                                                                                          | `:ui-core:test` (`UIMatrixPresentationTest.kt`); Roborazzi `matrix/{statusScreen-version-too-new, paywall-not-available, offlineActivation-*}` (`:ui:recordRoborazziDebug`, Android lane)                        |
| B2   | Godot                     | `ui/model/gate.gd:271`, `settings.gd:244`, `activate.gd:275-330`                                                                                                                                                                                                                                                                                       | `ui/offline/pkey_offline_dialog.gd:239-247`: catalog keys in place of `offline_step_send`, `offline_step_load`, `offline_request`, `offline_product`, `offline_load_hint` (`pkey_ui_copy.gd:133-140`); the QR also on phones (`:194`, D7). `gate_controller.gd` already offers retry                                                       | `tests/suite_ui_core.gd` (mirror); `tests/ui/snapshots/offline.txt` (`-- --pkey-test ui update`)                                                                                                                 |
| B2   | Python Qt                 | `ui/core/ui_gate.py:269`, `ui_activate.py:292-345`. No Paywall model: `ui.paywall` is `planned` (UK-12), a typed N/A                                                                                                                                                                                                                                   | `ui/qt/layout.py` and `kit/KitScreen.qml`: the two steps and a QR from the terminal's QR matrix                                                                                                                                                                                                                                            | `tests/test_ui_gate_matrix.py`, `test_ui_activate_matrix.py`, `test_ui_contract.py`; Qt snapshots `statusscreen-version-too-new`, `offlineactivation-*` (`PKEY_UPDATE_SNAPSHOTS=1`)                              |
| –    | Node and Python terminals | None: the `cli` family is unchanged, and `statusView` and `offline-request` already draw neither the product line nor `loadHint`                                                                                                                                                                                                                       | None                                                                                                                                                                                                                                                                                                                                       | Goldens stay byte-identical (`test/cli`, `tests/cli`, `terminal-parity.json`)                                                                                                                                    |

`features.json` and every `parity.json` are unchanged. Node's `ui.*` rows stay `planned` (UK-06);
ui-core's runner covers them.

**Specs and docs:** UI-KITS §4.1 (OfflineActivation: the kit numbers the steps, the request QR
wherever it fits, phones included; Paywall: the hand-off needs a valid `offers.url`);
`build/ui/components/{offline-activation,paywall,status-screen}.mdx`; the CHANGELOGs (§7).

## 6. Worker

None: no route, migration, table, transcript or generated Worker page.

## 7. Rollout and commit order

No flags. UIM-05 ships with I-37c in the first release after v0.9.15 (D1). Commits, in rule 2's
order (contract: none):

1. Catalog: `components.json`, `en.json`, the eight packs, `pnpm gen brand`.
2. Corpus: `tools/ui-matrix.ts` and its test, `pnpm gen ui-matrix`, `pnpm gen corpus`,
   `pnpm gen docs-reference` (and the version files if UIM-05 bumps).
3. ui-core, then elements, then React (step A).
4. Swift, Kotlin and Compose (B1); Godot, Python (B2). Each commit re-records its baselines and
   says why.
5. Specs, docs and CHANGELOGs.

**For hosts:** an override of `offlineActivation.product` stops showing. Swift loses
`PolarisKitCopy.offlineProductLabel` and `requestCodeLabel`, and Godot's `PKeyUiCopy` loses the
five `offline_*` keys above: the 0.9 line removes rather than deprecates. A host that passes
`offers.url` now gets the hand-off in every kit (the elements already drew it).

## 8. Decisions for the lead

| #   | Question                    | Options                                                                                                                                         | Recommendation                                                                                                                                                          |
| --- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Version                     | A. Ride I-37c's 5, after v0.9.15. B. Land in v0.9.15 inside the unreleased 4 (I-37c still bumps to 5)                                           | **A**, as the lead directed: one bump. If a tag ships 5 between the two, the later one bumps to 6                                                                       |
| D2  | Version too new             | A. Try again, the lone action and primary. B. A and a portal link, as the cli gate has (H1a). C. Leave it                                       | **A.** DL6's own words. B needs a server-supplied product link in the gate input; DL14 forbids making one up. File B as a follow-up when the license status carries one |
| D3  | Paywall hand-off            | URL: `offers.url`, validated as `purchase`. Label: A. reuse `paywall.portal` "Buy in your browser". B. a new key ("Open Polaris Locker")        | **A**, with `paywall.title` as the heading (one heading per screen). The elements ship it. On the web the label is still true (a new tab)                               |
| D4  | Step copy                   | A. The kit's number marker; the existing sentences are the steps; `loadHint` loses "Then". B. Two step-heading keys plus the sentences          | **A.** B says "send" and "load" twice (DL8). A visible number is a formatted integer, not copy; the web uses `<ol>`                                                     |
| D5  | OfflineActivation base      | The form in every non-done state; rejected keeps only the message; done gets the title and Done                                                 | **Yes**, H1b's Activate precedent. Rejected's error sits under Load file (DL7), and done stops being a dead end                                                         |
| D6  | `offlineActivation.product` | A. Delete the key (en and eight packs). B. Keep it in the list                                                                                  | **A.** DL5: the name appears once. The elements, React and both terminals already leave it out                                                                          |
| D7  | Where the request QR shows  | A. Wherever it fits, phones and tablets included (ui-core's `qrAllowed`). B. Not on a handheld (Godot today)                                    | **A.** An offline device can't send the code; another phone scanning it is the point. DL14's "never on a phone" is about sign-in. DL3 lets the QR give way first        |
| D8  | Id and split                | `UIM` fails the id pattern. A. `UK-64`, `planRef: "UIM-05"`, one branch with steps A, B1, B2 (about an hour each), one merge. B. Three packages | **A.** The runners fail on any row a port lacks, so the steps can't merge apart                                                                                         |

### 8.1 Found while planning (not in scope)

- **StatusScreen/expired** diverges: the matrix pins Renew and Use another license; Swift adds Try
  again (`GateScreens.swift:222`) and Compose leads with Reconnect. Expired's message says
  "Connect to the internet or renew". Recommendation: settle it with the KP-python and
  KP-compose findings (§8.3).
- **`a11y.qr`** ("QR code that opens the sign-in page") also labels DeviceLimit's TV QR, which
  opens `manageUrl` (ui-core, Swift `DeviceFamilies.swift:73`, Kotlin `KitDeviceStates.kt:69`,
  Godot `devices.gd:84`, Python `ui_devices.py:96`). Recommendation: the same slot.

### 8.2 Risks

- Native screens with fixed layouts (Swift `fixes`, Godot's legacy offline table) can draw a key
  twice or miss one. Check one screenshot per changed state.
- Compose is proven only in the Android lane (`heavy.sh` or CI).
- Locale values are machine translations under the packs' existing `reviewed: false`.
- `ui-matrix.json` conflicts with I-37c. Regenerate after merging it; never hand-merge.

### 8.3 Room for the KP-python and KP-compose gaps

A gap either pass reports joins this plan as an amendment before step A's corpus commit. It
brings the same five things: the spec text, the current rows and keys, the proposed rows and
keys with nine locales, the ports, and the baselines. It rides version 5 too. After that commit,
it becomes UIM-06 on the same version, if it lands before the release.

## 9. Acceptance

```sh
mise exec node@22 -- pnpm gen --check     # corpus (+ Godot mirror), ui-matrix, brand, constants, docs-reference
mise exec node@22 -- pnpm --filter @polaris-key/tools exec vitest run ui-matrix.test.ts
mise exec node@22 -- pnpm --filter @polaris-key/brand test
mise exec node@22 -- pnpm --filter @polaris-key/ui-core --filter @polaris-key/elements --filter @polaris-key/react test
mise exec node@22 -- pnpm --filter @polaris-key/react test:browser
mise exec node@22 -- pnpm ui:lint && mise exec node@22 -- pnpm ui:report
( cd sdks/python && .venv/bin/python -m pytest -q tests/test_ui_gate_matrix.py tests/test_ui_activate_matrix.py tests/test_ui_contract.py tests/ui tests/cli )
( cd sdks/swift && swift test --filter 'UIMatrixTests|KitRulesTests' )
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :ui-core:test )   # Compose: :ui:verifyRoborazziDebug in the Android lane
sdks/godot/tools/run_tests.sh
mise exec node@22 -- pnpm --filter @polaris-key/docs lint:docs && mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
rg -n "offlineActivation\.product|offline_step_send|requestCodeLabel" packages sdks --glob '!**/CHANGELOG.md'   # none
```

The reviewer checks that the Node and Python terminal goldens are byte-identical and that no
kit still adds a key outside its model (`withBase` has no `Paywall` or `OfflineActivation`
case). Then `$PKEY_LEAD/gate.sh` once, scoped to the branch.

## 10. Briefs this plan changes (applied by the lead on approval)

- **New `UK-64`** (`planRef: "UIM-05"`): the row above, with a brief at
  `wp/UK-64-kit-matrix-gaps.md`.
- **`I-37c`**: a note that UIM-05 shares `uiMatrixVersion` 5 and merges after it.
- **KP-python and KP-compose** hand-offs: report matrix or catalog gaps into §8.3, not into a
  new plan.
