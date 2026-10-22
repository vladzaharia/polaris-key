# DISC-01 plan: the product page link comes from discovery, and is left out while Locker is off

Follow-up to B-115 (`_mockups/review/stabilization/bug-ledger.md`, a recorded GAP), UK-45 review m11
and the S5 audit's B3 (`assets-labels-audit.md`). Status: **awaiting approval**. Nothing is
implemented. Judged at `integ/next-stage` `41d60cc00`; line numbers are from there.

**Proposed work-package row** (not yet in `workpackages.json`; the lead files it on approval):

| Field         | Value                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| id            | `LK-18`, with `planRef: "DISC-01"` (`DISC-01` fails the schema's id pattern; D9)                                                      |
| title         | Discovery `core.portal`: the terminal kits' product page link from the customer origin, left out while the product's portal is off    |
| phase / lane  | `LK` / `sdk`                                                                                                                          |
| role          | `pkey-implementer` (Worker, contract, corpus, client-core, Node, Python; no Swift, Kotlin or Godot code)                              |
| estimateWeeks | `[0.4, 0.7]`                                                                                                                          |
| deps          | `LK-17`, `UK-51`, `HA-13` (all done)                                                                                                  |
| deferred      | "after the v0.9.15 tag" (stabilization: no new features before it; B-115 is a GAP)                                                    |
| planMode      | `true`                                                                                                                                |
| gates         | `plan-mode`, `drift-gate`, `corpus`, `all-sdks`, `threat-model`, `rule-10`, `docs-generated`, `docs-links`, `ui-snapshots`, `workerd` |
| humanInputs   | D1–D9 (§10)                                                                                                                           |
| refs          | `plans/DISC-01.md`; ledger B-115; S5 audit B3; WIRE-CONTRACT-V4 §5.3, §5.5, §12.6, §12.9; `plans/HA-12.md` (the precedent)            |
| brief         | `wp/LK-18-portal-link-discovery.md` (the lead writes it from this plan)                                                               |

## 0. The gap, precisely

Two SDK functions build a customer link. Every other kit shows only links the server or the
integrator supplied (DL14: "a kit never makes up a URL"); a repo-wide search finds no other
`/activate?product=` builder.

| SDK    | Builder                                                                      | Callers                                                                                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node   | `portalUrl()`, `packages/sdk-node/src/cli/flows.ts:650-658`                  | `portalRows()` (:667) from `statusFlow` (:561) and `gate.ts` `linkRows()` (:134); the `unauthorized` link in `outcomeRows()` (:719, called at :968 and :1042); `refusalFor(…, hasPage)` (`gate.ts:274-280`, `hasPage` = "the client names a product") |
| Python | `portal_url()`, `sdks/python/src/polaris_key/ui/terminal/screens.py:155-164` | `screens.gate()` (:224, contact row when `None`); `cli/gate.py:195` and `_refusal(…, has_page)` (:88); `ui/terminal/flows.py:257`; `textual_app.py:278-281` `page_url()` (Manage)                                                                     |

Both apply one rule: the response's own link wins (Node only), the default base
`https://key.plrs.im` maps to `CUSTOMER_ORIGIN_DEFAULT`, and any other base keeps its own host,
then `/activate?product=<slug>`. That breaks twice:

1. **Wrong host.** On any base but the default one (a custom API domain, a proxy with a path
   prefix, a self-hosted Worker whose `CUSTOMER_ORIGIN` names another host), the link names the
   API host. It works only where that host 301s `/activate` (LK-17) and the base has no path.
2. **Dead link.** With the product's portal off (`portal.enabled`, ST-14), the link is printed
   anyway, to a page that has nothing for the product.

The Worker knows both facts: `customerOrigin()` (`core/hosts.ts`) and `portalEnabled()`
(`core/licensing/manageUrl.ts:127`). It already uses them for `manageUrl` (§5.3 rule 2) and
`accountPortal` (§12.6). But discovery tells a client neither for a product with Identity off, and
with Identity on it only implies them (`accountPortal` present).

## 1. Summary

- **Wire.** Discovery's `core` block gains one unsigned member, `portal`. It is
  `{"enabled":false}` while the product's portal is off, else
  `{"enabled":true,"activate":"<customer origin>/activate?product=<slug>"}`. `PROTOCOL_VERSION`
  stays 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2 and `CACHE_VERSION` 3. No signed shape, `typ`,
  claim, route, header or error code changes.
- **client-core** gains `@polaris-key/client-core/portal`: `parsePortal` and `portalLink` (the
  response's link, then discovery, then the legacy guess). Python ports it.
- **Terminal kits** (Node, Python) draw the link from `portalLink()`. `null` draws "Contact
  {developer}" (`status.contact`, already the rule where no page is known). The legacy guess is
  today's rule, so against an older Worker nothing changes.
- **Corpus.** A new `portal-matrix.json` (`portalMatrixVersion` 1), two `cli.outcomes` rows, and
  `uiMatrixVersion` 6 (D5). One new transcript, `discovery-portal.json`. Eight transcripts' recorded
  discovery bodies gain the member, and nothing else changes.
- **Deployed builds** ignore the member and keep the links they print today.

## 2. Contract

### 2.1 Where the fields go (D1)

| Option                                                        | Signed | Version effect                                                                                                                         | Verdict                                                                                                                                                                |
| ------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Discovery `core.portal`**                                | no     | none. Every shipped parser keeps unknown members (HA-12, CM-29 and I-09 added members the same way)                                    | **Recommended.** Every SDK fetches discovery before it holds a licence, which is when the link matters                                                                 |
| B. Trust manifest member (`pkey-trust+jws`)                   | yes    | §2.3 says "unchanged in shape": a new top-level signed member is rule 2's bump to 5, with trust corpus cases and Swift's typed decoder | No. Offline bundles embed the manifest and would freeze the portal state for their life. Signing adds nothing: the Worker that serves discovery holds the product keys |
| C. Config document (`pkey-config+jws`)                        | yes    | bump; per device                                                                                                                       | No. It needs a device token and Config on; the link is needed before activation                                                                                        |
| D. Licence `profile` (open object, SP-54's no-bump precedent) | yes    | none                                                                                                                                   | No. Only a licensed device holds one, and the link serves devices with no usable licence                                                                               |
| E. Derive from Identity's `accountPortal`                     | no     | none; no Worker change                                                                                                                 | No. A product with Identity off says nothing, and the client would build the path                                                                                      |

### 2.2 WIRE-CONTRACT-V4: a new §5.7, "The product page link (`core.portal`) [C]"

Pinned by `portal-matrix.json` and `discovery-portal.json`.

```jsonc
"core": { …, "portal": { "enabled": true, "activate": "https://polaris.locker/activate?product=djdl" } }
"core": { …, "portal": { "enabled": false } }
```

1. **Presence.** Every discovery from a Worker that ships §5.7 carries `core.portal`, last in
   `core` (after `presentation`). `enabled` is the product's `portal.enabled` (default on), read
   once per document, so §12.6's `accountPortal` is present exactly when `enabled` is true. While
   it is false, the member is `{"enabled":false}` and nothing else.
2. **`activate`** is `<origin>/activate?product=<slug>`, `<origin>` the customer origin of §12.9.
   It is omitted when no origin is usable or the URL exceeds `MANAGE_URL_MAX_LENGTH` (2048).
3. **Parse** (`parsePortal(core)`). If `core` is not an object, `portal` is not an object, or
   `enabled` is not a boolean, the result is `null` ("unknown"). `enabled: false` gives
   `{enabled:false}`, and other members are ignored. `enabled: true` gives
   `{enabled:true, activate}`: `activate` is the member if it passes §5.3 rule 4 (`isManageUrl`),
   else `null`. Unknown members are ignored. The member never refuses discovery.
4. **Resolution** (`portalLink({served, portal, baseUrl, product})`), first match:
   1. `served`, the response's own link (a refusal's `manageUrl`), if it passes rule 4;
   2. `portal` is `{enabled:false}`, or `{enabled:true, activate:null}`: `null`. This is the fail
      closed of D8: never the legacy guess, because the Worker has answered;
   3. `portal.activate`;
   4. `portal` is `null` (an older Worker, or never discovered): the legacy link. Its origin is
      `CUSTOMER_ORIGIN_DEFAULT` when the base with trailing slashes removed is `"https://" + ISSUER`,
      else that base. Then `/activate?product=` and the slug, percent-encoded (a `PRODUCT_SLUG_RE`
      slug needs none). It is kept only if it passes rule 4; with no product, the result is `null`.
5. **Source.** The member comes from this session's discovery, else the last one persisted (D3). A
   successful discovery always replaces it, and an absent member clears it.
6. **What a client may add: nothing.** Never `#key=`: `withManageKey` is for a refusal's own link
   only, so a discovery-supplied host never receives a key. A client opens the link only on a user
   action or prints it (§5.3 rule 6). A terminal wraps it in OSC 8 only when it is https (DL14).

Other edits:

- §12.6 gains: `accountPortal` ⇔ `core.portal.enabled`.
- §12.9 rule 1's list gains `core.portal.activate`.
- §9 gains a paragraph: every counter unchanged, plus `portalMatrixVersion = 1` and
  `uiMatrixVersion = 6`, with the deployed-build story of §7.
- §10 gains a line: "`core.portal` is parsed as a whole. An invalid `activate` is no link, never
  repaired and never replaced by a guess."
- The header's "Amended for …" sentence gains DISC-01.

### 2.3 Packages

- **`shared-protocol`**: `core.ts` gains
  `export type ProductPortal = { enabled: false } | { enabled: true; activate?: string }`, beside
  `ProductPresentation` (:514). There is no new constant: it reuses `MANAGE_URL_MAX_LENGTH`,
  `CUSTOMER_ORIGIN_DEFAULT` and `ISSUER`.
- **`shared-jws`**: no change.
- **`client-core`**: a new `src/portal.ts` exports `parsePortal`, `portalLink` and the normalised
  `ParsedPortal = {enabled:false} | {enabled:true; activate: string | null}`. It adds the
  `./portal` export and a README row, and reuses `isManageUrl` from `./manage`.
  `test/portal.test.ts` runs `portal-matrix.json`.

## 3. Catalog and manifests

None. There is no validator rule (rule 9 does not apply), no schema, no setting (`portal.enabled`
exists) and no env var (`CUSTOMER_ORIGIN` exists).

## 4. Corpus and transcripts

- **`conformance/corpus/v2/portal-matrix.json`** (new, ASCII, `portalMatrixVersion` 1) is built
  by a new `tools/portal-matrix.ts`. Its generator-local reference imports nothing it checks, as
  `tools/presentation-matrix.ts` does. `tools/portal-matrix.test.ts` holds the restated
  limits equal to the protocol's. The wiring is one `CORPUS_TARGETS` entry in
  `tools/sign-corpus.ts`, the `corpus` family's inputs in `tools/generators.ts`, and
  `PORTAL_MATRIX_VERSION` from `tools/gen-sdk-constants.ts`.
  - `parseCases` `{name, core, expect}`: no `core`; no member; a member that is a string, array
    or `null`; `enabled` missing, `"true"` or `1`; off; off with an `activate` (ignored); on with a
    valid link; on with no link; and on with an `activate` that is `http://` to a public host,
    `http://localhost:8787` (kept), userinfo, `\` in the authority, whitespace, 2049 characters,
    `javascript:` or a number; unknown members.
  - `linkCases` `{name, served, portal, baseUrl, product, expect}`: a valid `served` beats an
    off member; an invalid `served` falls through; off; on with a `null` link; on; and the four
    legacy rows: the default base with and without a trailing `/`, a custom https base, and a base
    with a path. Then a public `http://` base (`null`), a loopback base, and an empty product.
- **`ui-matrix.json`**: `tools/ui-matrix.ts` appends two `cli.outcomes` rows,
  `status-version-too-new, no product page` and `status-channel-not-entitled, no product page`.
  Their situations are `status-version-too-new-no-page` and `status-channel-not-entitled-no-page`,
  the stub discovery says `{"enabled":false}`, and they expect `link: "contact"`.
  `CliOutcomeExpect.link` widens to `"portal" | "contact"`. The vocabulary's `contact` text becomes
  "where the kit resolves no product page (§5.7)". `UI_MATRIX_VERSION` becomes 6 (D5): run
  `pnpm gen constants`, and edit the two hand constants, `packages/ui-core/src/vocabulary.ts` and
  `sdks/godot/addons/polaris_key/ui/model/vocabulary.gd`.
- **Transcripts.** `packages/worker/test/transcripts/scenarios/discovery.ts` gains
  `discoveryPortal`, which records `discovery-portal.json` (features `["ui.cli.portal"]`). It
  discovers with the portal on, getting `https://key.plrs.im/activate?product=djdl` because the
  recording world leaves `CUSTOMER_ORIGIN` unset. It then turns the portal off and discovers
  again, getting `{enabled:false}`. Each step expects `portal`, the parsed member.
  `boot-cold-register`, `discovery-capabilities`, `discovery-presentation`, `discovery-identity`,
  `identity-disabled`, `locker-discovery-identity`, `packs-chunk-range` and `release-fetch-gated`
  regenerate with the member in their recorded bodies; their steps and expectations do not change.
  All six SDKs replaying those eight transcripts green proves every shipped parser tolerates the
  member.
- **Mirrors.** The Godot mirrors (`sdks/godot/tests/corpus/v2/`, `sdks/godot/tests/transcripts/`)
  are written by the generators. Swift reads the checkout.
- **Lists.** AGENTS.md rule 1 and `contribute/corpus.md` ("The files", "Never hand-edit") gain
  `portal-matrix.json`.
- **Drift gate:** `pnpm gen corpus --check`, `pnpm gen transcripts --check`, `pnpm gen --check`.

## 5. SDKs, in order

| #   | SDK                         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Must pass                                                                                                                                                                                                                      |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | client-core                 | §2.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `test/portal.test.ts`; Node runner `conformance/runners/node/portal.test.ts` (`@pkey-feature ui.cli.portal`)                                                                                                                   |
| 2   | Node                        | `discovery.ts`: `DiscoveryCore.portal?`. `client.ts`: `portal(): ParsedPortal \| null`. A new `core/portal.ts` persists `portal.json` (`{v:1, product, baseUrl, portal}`) under the presentation store's directory, written atomically and re-parsed on load; a file that names another product or base, or does not re-read to itself, is deleted (D3). `cli/flows.ts`: `portalUrl()` becomes `portalLink(client, served?)` returning `string \| null`; `portalRows()` draws the contact row on `null`; `outcomeRows()` draws the `unauthorized` link only when non-null; `ensurePortal()` (D4). `cli/gate.ts`: `hasPage` = `portalLink(client) !== null` | `test/cli/portalUrl.test.ts` (rewritten over `linkCases`); `cliContract.test.ts` (the two situations); `cliMount.test.ts` (`portal: false` realised by an off member); the transcript replayer; the cli goldens stay unchanged |
| 3   | Python                      | `core/portal.py` (`parse_portal`, `portal_link`); `client.py`: `portal()`, plus `portal.json` beside the presentation cache (none without a cache dir); `screens.portal_url()` resolves through `portal_link`; `cli/gate.py`, `ui/terminal/flows.py` and `textual_app.page_url()` follow; `ensure_portal()` (D4)                                                                                                                                                                                                                                                                                                                                           | `tests/test_portal_matrix.py`; `tests/test_transcripts.py` (`portal` expectation); `tests/cli/test_cli_contract.py`, `test_cli_gate.py`                                                                                        |
| —   | React, Swift, Kotlin, Godot | No code. A typed N/A on `ui.cli.portal` (`reason: runtime`, the same runtimes and wording as `ui.cli`): each ships a widget kit that shows only server or integrator links (`manageUrl`, `freeDeviceUrl`, `verificationUri`, `renewURL`, `deviceCodeUrl`). The Python Qt kit, Electron and `packages/server` build no customer link either                                                                                                                                                                                                                                                                                                                 | The `uiMatrixVersion` 6 constant check, and the eight regenerated transcripts unchanged in outcome                                                                                                                             |

**Parity:** `conformance/parity/features.json` gains `ui.cli.portal` (family `ui`, service
`core`). Its proof is `{corpus: portal-matrix.json}` and `{transcript}`, and its `allowedNa` is
`ui.cli`'s. `packages/sdk-node/parity.json` and `sdks/python/parity.json` mark it `implemented`,
and the other four mark it `na`. Run `pnpm gen parity` (D6).

## 6. Worker

- **`core/licensing/manageUrl.ts`** gains `portalMember(env, fallbackOrigin, product, on)`. It
  returns `ProductPortal`, built on `customerOrigin()`, so `test/customerOrigin.test.ts` (customer
  paths only on that origin) keeps passing.
- **`core/discovery.ts`** reads `portalEnabled(db, slug)` once and emits `core.portal` last. It
  passes the answer on a new `DiscoveryContext.portalOn` (`core/registry.ts`), and Identity's
  fragment (`services/identity/index.ts:140`) reads that instead of reading the setting a second
  time. That is one D1 read, and `accountPortal` and `core.portal` can never disagree.
- **No new route, migration, table (`TABLE_OWNERS`), setting or env var.** Rule 10: the OpenAPI
  `DiscoveryDocument` schema and the `allFiveEnabled` example gain `core.portal`, and
  `routeCoverage` is unaffected.
- **Caching.** Discovery stays `public, max-age=300` with no ETag (HA-12 Q4). A portal switched off
  disappears from a device's link within 300 s of its next discovery. An offline device keeps its
  persisted member until it rediscovers, and the page it opens then says the product is not
  available there.
- **Tests:**
  - `test/discoveryGolden.test.ts` and its fixture: three products gain the member, and the header
    gains a DISC-01 paragraph;
  - `test/identityAccount.test.ts`: `accountPortal` ⇔ `core.portal.enabled`;
  - `test/customerHost.test.ts`: `activate` on `CUSTOMER_ORIGIN` when it is usable;
  - `test/surfaces.test.ts`.
- **Docs:**
  - THREAT-MODEL, under "The customer host and the hard cutover": the source list gains
    `core.portal.activate`, plus one row (§8).
  - Hand-edited pages: `build/ui/frameworks/terminal-node.mdx` (the "product page link" sentence),
    `terminal-python.mdx` (`manage_url`'s "the page the client resolves") and
    `features/sign-in/customer-portal.md` ("The activate link").
  - Generated: `pnpm gen docs-reference` (corpus reference), `pnpm gen registry-docs`
    (`generators.mdx` inputs) and `pnpm gen parity` (`parity.mdx`).

## 7. Rollout

The work goes in one change, in this order: contract, protocol, corpus and transcripts,
client-core, Node, Python, Worker. The deploy order is free, because either side alone changes
nothing a person sees. There is no flag.

| Build                           | Behaviour                                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shipped SDK, new Worker         | Ignores `core.portal` and prints today's link. On `key.plrs.im`, `/activate` 301s to `polaris.locker` (LK-17). A portal-off product keeps its dead link in old builds; nothing can change a shipped build |
| New SDK, old Worker (no member) | `parsePortal` gives `null`, and the legacy guess is byte-identical to today's link                                                                                                                        |
| New SDK, new Worker             | The Worker's customer-origin link, or "Contact {developer}" while the portal is off                                                                                                                       |
| New SDK, discovery unreachable  | The persisted member, else the legacy guess                                                                                                                                                               |
| Worker rolled back              | The next successful discovery has no member and clears the persisted one, so links go back to the legacy guess                                                                                            |

## 8. Security

- **Who can set the link.** Discovery comes from the build's own base URL over TLS. That is the
  party that already supplies `manageUrl`, `signInUrl`, `verificationUri` and `freeDeviceUrl`,
  which every kit opens behind a button. A hostile or compromised Worker can already point
  customers at any https host through those, so `core.portal` gives it nothing new. Signing would
  not help either, because that Worker holds the product keys (option B).
- **What every client enforces:**
  - §5.3 rule 4: https, or http to loopback only; no userinfo, no `\`, whitespace or control
    character; at most 2048 characters. This is the rule behind ui-core's `linkVerdict` and
    `validLink` and the terminals' `safeLink`.
  - An invalid link is no link. It is never repaired and never replaced by the legacy guess (D8).
  - A client never appends `#key=` to the link, so a discovery-named host never sees a key.
  - The terminal prints the whole URL, so the host is visible, and never opens it by itself.
  - A persisted member that names another product or base, or does not re-parse to itself, is
    deleted.
- **No host allowlist** (D7). The THREAT-MODEL row states the trust equivalence above.

## 9. Out of scope

- **The device-code page fallback** (`DEVICE_CODE_PAGE`/`TV_CODE_PAGE`: ui-core `signIn.ts:34`,
  Python `ui_signin.py:63`, Kotlin `KitPresentation.kt:555`, Swift `ActivateFamily.swift:299`,
  Godot `sign_in.gd:25`). The server's `verificationUri` wins and is already on the customer host
  (§12.9 rule 1). The constant shows only when a start answer lacks one.
- **`openAccount()`** (I-10a, I-10b) keeps reading `accountPortal`. No brief changes.
- **Widget kits defaulting Renew or Manage to `core.portal.activate`.** That is a UX decision of
  its own (D6).

## 10. Decisions for the human

| #   | Question                                    | Options                                                                                                                                                                                 | Recommendation                                                                                                                                                    |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Where the fields live                       | A. discovery `core.portal`; B. trust manifest; C. config doc; D. licence `profile`; E. derive from `accountPortal` (§2.1)                                                               | **A**: no bump, and present before activation                                                                                                                     |
| D2  | Shape                                       | A. the full `activate` link plus `enabled`; B. a bare `origin` plus a `portal` boolean, with clients building paths                                                                     | **A**: the Worker builds every customer URL (§12.6's "never builds one"); the client builds one only as the legacy guess                                          |
| D3  | Persist the member                          | A. `portal.json` beside the presentation cache; B. this session only                                                                                                                    | **A**: an offline `status` still hides a dead link                                                                                                                |
| D4  | Pinned builds (`expectedServices`)          | A. a screen that draws the link loads discovery first when the session has none, pinned or not (best effort, the client's deadline); B. pinned builds never discover there              | **A**: one cacheable GET, only on refusal screens. The capability map it installs comes after the decision, and the process ends there                            |
| D5  | `uiMatrixVersion`                           | A. 6, because the outcomes rows gain a situation set-up and a `contact` value; B. stay at 5 as appended rows                                                                            | **A**: the house rule ("a changed row, input member or rule bumps it"; DENY-01 did the same). If another package takes 6 first, take the next                     |
| D6  | Parity scope                                | A. `ui.cli.portal`, with typed N/A on the widget-kit runtimes; B. `core.portal` in all six SDKs, with React, Swift, Kotlin and Godot planned under an `LK-18b` that ports `parsePortal` | **A**: no consumer exists outside the terminals. A later widget-kit or `openAccount()` package adds `core.portal` and runs the same file                          |
| D7  | Host restriction                            | A. rule 4 only; B. also require the link's host to be the base's host, `polaris.locker` on the default base, or one an integrator lists                                                 | **A**: B guards only against a compromised Worker, which already controls `manageUrl`. It would also break self-hosters and make a display constant a trust input |
| D8  | Portal on, but `activate` invalid or absent | A. no link ("Contact"); B. the legacy guess                                                                                                                                             | **A**: DL14 fails closed, and the Worker has answered                                                                                                             |
| D9  | Id and timing                               | A. `LK-18` (Locker family), `planRef: "DISC-01"`, deferred until after the v0.9.15 tag; B. `UK-64` (terminal family)                                                                    | **A**                                                                                                                                                             |

## 11. Acceptance

```sh
mise exec node@22 -- pnpm gen --check                     # corpus, transcripts, constants, parity, docs-reference, registry-docs
mise exec node@22 -- pnpm build && mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm --filter @polaris-key/client-core test portal manage
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test portal transcripts presentation
mise exec node@22 -- pnpm --filter @polaris-key/worker test discoveryGolden identityAccount customerHost customerOrigin surfaces routeCoverage transcripts
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd && mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/node test cli
mise exec node@22 -- pnpm --filter @polaris-key/ui-core test uiMatrix
( cd sdks/python && .venv/bin/python -m pytest -q tests/test_portal_matrix.py tests/test_transcripts.py tests/cli tests/test_ui_contract.py )
( cd sdks/swift && swift test --filter 'UIMatrix|Transcript' )
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :ui-core:test :conformance:test )
sdks/godot/tools/run_tests.sh
mise exec node@22 -- pnpm parity:check && mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm lint && mise exec node@22 -- pnpm format
```

Done means four things:

- Each kit's `status` on a portal-off product draws "Contact {developer}". Shown for the Node and
  Python kits, at 80 columns, dark and light.
- On a `CUSTOMER_ORIGIN` world, the link names the customer host.
- Against a Worker without the member, the link is byte-identical to today's.
- Ledger row B-115 is closed with the commit.
