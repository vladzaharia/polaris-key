# D-02 Diceroll: adopt the Godot SDK for config, licensing, identity and update checks

| Field       | Value                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | D: Diceroll adoption (vladzaharia/diceroll); stage "After P1"                                                                                                                                                                     |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                              |
| Depends on  | [P1-12](P1-12-godot-release.md)                                                                                                                                                                                                   |
| Unblocks    | none in the graph; [D-03](D-03-diceroll-after-p3.md) builds on the registered product and the installed SDK                                                                                                                       |
| Role        | `pkey-godot-engineer`                                                                                                                                                                                                             |
| Plan mode   | no                                                                                                                                                                                                                                |
| Gates       | `pkey validate` clean in the Diceroll repo; Diceroll's CI; no Polaris Key gate (no change there)                                                                                                                                  |
| Human input | none in the graph. Needed in practice: a platform admin links the Diceroll repository in the console (registration mints the product key); and, for the web build, its origins added to the CORS allowlist once P0-05 has shipped |
| Repo        | `vladzaharia/diceroll`                                                                                                                                                                                                            |

> **Re-verify first.** Diceroll paths below come from [notes/A4](../../notes/A4-diceroll-mapping.md)
> (Diceroll `4e78bb6`, 2026-09-29); this brief was written without access to the Diceroll
> repository. Confirm each path, and find where balance values and optional features live today
> (notes/A4 does not list them), before changing anything.

## Goal

A tagged Diceroll build uses the Godot SDK (`addons/polaris_key/`, published by P1-12) for:

- **managed config:** balance tuning values and kill switches set from the console;
- **licensing:** a free-tier licence auto-issued on first run, which a later sign-in claims, and a
  supporter tier with an entitlement;
- **identity:** device-code sign-in with a QR code;
- **update checks:** the SDK's check, in report-only mode beside Diceroll's own updater.

The game still boots and plays offline with no licence. **Diceroll deletes nothing at this step**;
its updater still ships binaries and packs ([README §13](../../README.md#13-diceroll-adoption-path)).

## Why

This is the report's first Diceroll milestone after P1: remote tuning and kill switches, supporter
tiers and a native sign-in for games are what Polaris Key already does well
([README §2.1](../../README.md#21-already-fits)), and P1 brings them to Godot
([README §5](../../README.md#5-the-godot-sdk)). Running the SDK in a real game before D-03 also tests
it where it matters, and the report-only update check gathers evidence that Polaris Key's release
resolution agrees with Diceroll's own decisions before D-03 hands updates over.

## Read first

- In the Polaris Key repo: `AGENTS.md`; the skills `.claude/skills/authoring-pkey-manifests/SKILL.md`
  and `.claude/skills/adding-a-catalog-entry/SKILL.md`; the Godot SDK docs page and install steps
  P1-12 publishes (see its hand-off); `products/djdl/product.json` as a complete example (tiers,
  `oidc.provider: platform`); `packages/shared-manifest/schemas/v1/product.schema.json`
  (`autoIssue`, `tiers`, `devices.registration`).
- Research: [README §5.1](../../README.md#51-shape-and-api), [§5.3](../../README.md#53-transport-persistence-device-identity), [§5.4](../../README.md#54-managed-config-in-a-game), [§5.8](../../README.md#58-ui-kit-and-pkeyboot), [§6.1](../../README.md#61-developer-adopter), [§13](../../README.md#13-diceroll-adoption-path); [CONTENT §15](../../CONTENT.md#15-diceroll-mapping) (the `extras.diceSkins` entitlement).
- Diceroll: `project.godot` (autoloads; `Updater` is first), `ui/modals/settings_panel.gd`,
  `ui/modals/dev_menu.gd` (`register_section`), `game/boot/`, `game/update/update_policy.gd`
  (channels and `build_info()`), [notes/A4 §1.7](../../notes/A4-diceroll-mapping.md#17-channels-and-the-dev-menu-override).

## Scope

**In:**

- `.pkey/product.yaml`, `.pkey/schema.yaml` and `.pkey/release.yaml`, scaffolded with
  `pkey init --product diceroll --name "Diceroll" --modules licensing,config,releases,oidc` and
  validated until clean.
- **Catalog** (`adding-a-catalog-entry`): a small set of real balance values found in the game's
  code, as `config` entries; one boolean kill switch per risky feature; `flag` entries for the
  supporter entitlement `extras.diceSkins` and for `channels` (beta access).
- **Product:** tiers `free` and `supporter`; `autoIssue: { enabled: true, tierId: free, mode: both }`
  (keyless enrolment on first run plus the sign-in claim); `oidc.provider: platform` for
  device-code sign-in; Release and Update enabled for the update check.
- **Game:** the addon installed as P1-12 documents; `res://polaris_key.tres` (outside `addons/`)
  with product, base URL and pinned trust keys fetched and checked by the editor dock; the
  `PolarisKey` autoload registered **after** Diceroll's `Updater`, which must stay first
  ([notes/A4 §1.1](../../notes/A4-diceroll-mapping.md#11-components-and-where-they-live)).
- Tuning values read through `PolarisKey.config.get_value(key, fallback)` or
  `PKeyConfigBinding.bind_property`; kill switches checked at each feature's entry point; the
  supporter reward gated by `PolarisKey.license.is_entitled("extras.diceSkins")`.
- Settings: a sign-in row (`PKeySignInDialog`: user code, QR, open or copy link) and a licence status
  row. Dev menu: the SDK's section registered through `DevMenu.register_section`; COPY DIAGNOSTICS
  gains device id, licence status and the SDK's update-check result.
- **Update check, report-only:** call `PolarisKey.update.check` (P1-08) after the title shows,
  without connecting its `update_available(check)` signal to any prompt; show its result
  in the dev menu and diagnostics; log when it disagrees with Diceroll's `UpdatePolicy.decide()`.
  Diceroll's updater stays the only thing that prompts or downloads.
- Tests in Diceroll's suite for: offline boot with defaults, a kill switch honoured, the entitlement
  gate, and config fallback when the SDK has no cached document.

**Out** (and where it belongs instead):

- Replacing or deleting the updater; the SDK's build stamp (→ [D-03](D-03-diceroll-after-p3.md)).
- Packs and `PKeyBoot` (→ [D-04](D-04-diceroll-after-p4.md)).
- Selling the supporter tier in stores (→ [D-05](D-05-diceroll-after-p6.md), P6-01).
- Edge-mint recipes, unless the game already calls a third-party API with a key.

## Design notes

- **Decision made here:** the report says "adopt … update checks" without saying which system
  prompts. Two prompting systems would contradict each other, so the SDK check is report-only until
  D-03.
- **Offline first.** No licence gate blocks play; the free licence is issued in the background and
  `not-applicable` passes `PKeyGate` ([README §5.8](../../README.md#58-ui-kit-and-pkeyboot)). Kill
  switches default to "feature on" in the schema, so an offline build behaves normally.
- **Management states:** kill switches are operator policy (`enforced`, per the catalog skill); use
  `hidden` for tuning values the player should not see in settings.
- **Web:** there is no stable device anchor, so keyless enrolment is impossible and each storage
  clear is a new device ([README §5.3](../../README.md#53-transport-persistence-device-identity)).
  Skip enrolment on web. The web build also needs CORS, which is P0-05's and not a dependency of
  P1-12: if P0-05 has not shipped, leave the web build on defaults and say so.
- **Release truth:** Diceroll's GitHub releases include the rolling `channels` release, which
  today's Release would ingest as a version ([README §0.4](../../README.md#04-findings-that-should-change-plans-now)
  item 2). P0-02 adds the tag filter; configure it in `.pkey/release` with the field name P0-02
  ships. If P0-02 has not landed, keep Release off and skip the update check.
- `clientScoped` secrets can be extracted from a `.pck`; put nothing secret in the catalog for the
  game ([README §5.3](../../README.md#53-transport-persistence-device-identity)).
- Terminology: device, tier, product (AGENTS rule 4).

## Steps

1. Re-verify the Diceroll paths; find the tuning values and features for the catalog.
2. Scaffold and validate `.pkey/`; ask the human to link the repository; run `pkey doctor`.
3. Install the addon and configure `res://polaris_key.tres`; wire config, kill switches and the
   entitlement; add settings and dev-menu rows.
4. Add the report-only update check and its disagreement log.
5. Add tests; export desktop, Android and web builds; test online and offline.

## Acceptance criteria

- [ ] `pkey validate` exits 0; the product is linked (human-confirmed); `pkey doctor` against
      `https://key.plrs.im` passes (the command is in Verify).
- [ ] Exported builds boot and play with the network off and no cached documents.
- [ ] A tuning change and a kill-switch flip made in the console reach a running build on its next
      sync; a test covers each with a recorded config document.
- [ ] First run auto-issues a free licence; device-code sign-in with QR claims it; a supporter
      licence unlocks the reward (tested with a fixture licence).
- [ ] The dev menu shows the SDK section, and COPY DIAGNOSTICS includes device id, licence status
      and the SDK update-check result.
- [ ] The updater's six suites still pass unchanged; nothing is deleted.

## Verify

```sh
# In the Diceroll repository:
pkey validate
pkey doctor --base-url https://key.plrs.im --product diceroll
# Diceroll's test suites, as ci.yml runs them
```

## Hand-off

D-03 relies on: the registered product with Release and Update enabled, the installed SDK and
`res://polaris_key.tres`, and the report-only comparison log, which shows whether Polaris Key's
resolution matches Diceroll's decisions on real releases. Deletes nothing. The lead sets
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set D-02 done` in the Polaris
Key repo when the Diceroll PR merges.
