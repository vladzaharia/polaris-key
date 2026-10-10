# P4-19 Content-key delegation for data-only packs

| Field       | Value                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v3)                                                                                                                                                                         |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                   |
| Depends on  | [P4-13](P4-13-revocation-floors-decision.md)                                                                                                                                           |
| Unblocks    | [P4-25](P4-25-delegation-python-swift.md), [P4-26](P4-26-delegation-godot.md)                                                                                                          |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                  |
| Plan mode   | yes: `program/plans/P4-19.md` is written and approved before any code                                                                                                                  |
| Gates       | plan mode; corpus (`releaseRecordCases`, mirrors, generated `corpus.mdx`); threat model; in practice every SDK verifies the new chain; rule 9 if `.pkey/release` declares content keys |
| Human input | approval of the plan (merging the plan PR); nothing else (the corpus uses test keys)                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                              |

## Goal

A product's release key can delegate a **content key** that may sign pack release records only
for data-only pack types and only under a pack-id prefix. The delegation is a CI-signed record
that the Worker cannot forge. Every SDK accepts a pack record signed by a content key only
through a valid, unrevoked, unexpired delegation from a pinned release key, and only within its
scope. Content keys can never sign app records, revocations, delegations or script-capable types.
A content team can then publish events, localisation and data without code-release power.

## Why

README decision 15: "The release key by default. Allow a delegated content key for data-only
types, so content can ship without code-release power." The trust model keeps two signers and
never lets the Worker ship code or a poisoned pack
([README §3.3](../../README.md#33-trust-model-two-signers-two-documents)). Delegation must keep that
property while widening who may publish data
([CONTENT §12](../../CONTENT.md#12-security); [notes/E8 §5.8](../../notes/E8-content-delivery.md#58-signing-and-trust),
TUF-style delegation).

## Read first

- `AGENTS.md`, `CLAUDE.md` (plan mode), `program/plans/README.md`, `docs/security/THREAT-MODEL.md`
  (§3 trust boundaries, AT-3 "Ship malicious code to every installed client").
- [README §3.3](../../README.md#33-trust-model-two-signers-two-documents) (release key row: "optionally
  delegating a content key limited to data-only pack types"),
  [§3.12](../../README.md#312-what-dicerolls-pkey-would-look-like-illustrative) (illustrative
  `contentKeys`), [§11](../../README.md#11-decisions-needed) decision 15.
- [CONTENT §12](../../CONTENT.md#12-security) and [§4.2](../../CONTENT.md#42-initial-type-registry)
  (which types can carry scripts).
- [notes/E8 §5.8](../../notes/E8-content-delivery.md#58-signing-and-trust).
- The approved plans for P3-01, P4-01 and P4-13; the v4 contract; the record-verification code in
  `client-core`, Python, Swift and Godot (P3-04 to P3-08); `tools/sign-corpus.ts`
  (`releaseRecordCases`); P2-02's publisher policy and P2-06's `pkey release` commands.

## Scope

**In:**

- The plan, `program/plans/P4-19.md`.
- Contract: a delegation record, proposed as a `pkey-release+jws` with `kind: delegation`, and the
  verification chain for delegated pack records. README §3.3 says packs add no document types, so
  a new `kind` in the existing record is preferred over a new `typ`.
- Corpus: `releaseRecordCases` for delegation (below) and the mirrors.
- SDKs: the chain in `client-core` (Node, React), Python, Swift and Godot.
- Worker: ingest checks delegated records against their delegation (defence in depth; clients stay
  authoritative); delegation records are fetchable by hash like any record; revocation of a
  delegation through P4-13's `kind: revocation`.
- CLI: `pkey release delegate` (signs with the release key) and signing a pack publish with a
  content key.
- Threat model: a delegation branch under AT-3 and the new trust boundary.

**Out** (and where it belongs instead):

- Key custody for real products (GitHub Environments, KMS): an operator task, covered by README
  decision 3.
- Publisher-policy changes that let a second CI workflow publish only packs under a prefix: if P2-02's
  policy cannot express that, record it as a follow-up to P2-02 rather than widening this package.
- Console display of delegations (not scheduled).

## Design notes

- **From P3-01's approved plan** (`plans/P3-01.md` §8): `kind: delegation` is a reserved record
  kind (verified, never acted on in v4), and `.pkey/release` `contentKeys` is a warning until this
  package lands.
- **Delegation body** (proposed; the plan freezes it). E8 §5.8 sketched
  `{keyid, packIdPrefix, types[], dataOnly: true}`; README §3.12 sketched
  `scope: {kinds: [pack], dataOnly: true}`; CONTENT §12 says "data-only types and a pack-id
  prefix". Reconcile as
  `{kind: "delegation", kid, publicKey, packIdPrefix, types[], notBefore, expiresAt, seq}`.
- **Allowed types.** Never `godot.pck` or `godot.zip`: they can carry scripts, so they always need
  the release key (CONTENT §12, E8 §5.8). This means Diceroll's event PCKs stay release-signed and
  only their `data.json` part can be delegated. Candidates are `l10n.table`, `data.json`,
  `audio.bank` and `ml.model`. `files.tree` and `custom.*` are open questions for the human,
  because a tree or a game-defined handler may load code; recommend excluding both unless the
  delegation also requires the SDK's data-only directory check.
- **Chain.** Pack record `kid` ∈ pinned release keys → accept, as today. Otherwise find the
  delegation (plan decides: referenced by hash from the pack record, or listed by hash in the
  feed; recommend a hash reference in the pack record so the chain does not depend on the Worker),
  verify it against a **pinned release key** (the SDKs' separate `pinnedReleaseKeys` input from
  P3-01, never the Worker's trust set), check it is unexpired and not revoked, and check the
  pack record's `packId` starts with `packIdPrefix` and its `type` ∈ `types`. One level only: a
  content key cannot delegate.
- **What a content key may never sign:** app records, revocations, delegations, and pack types
  outside the delegation. Each is a negative corpus case.
- **Revoking a delegation** is a `kind: revocation` naming the delegation record's hash (P4-13).
  Packs already signed under it are then rejected unless re-signed.
- **What a compromise buys** (threat model): a stolen content key can publish data within its
  prefix and types until revoked or expired, for example offensive or malformed data that
  handlers must reject safely. It cannot ship code, change app records or condemn releases. The
  Worker still cannot forge a delegation. A compromised Worker can withhold a delegation's
  revocation, as it can withhold any revocation today.
- **Manifest.** README §3.12 puts `contentKeys` in `.pkey/release`, and P3-01's plan reserves that
  field for this package beside `releaseKeys`. The manifest is unsigned, so it can only tell the
  Worker and CI what to expect, never grant trust. If the plan keeps it, it is a rule-9 change
  (validator rule, mutation-table entry, schema, `validation-codes.mdx`).
- **Wire version.** A new `kind` inside `pkey-release+jws`. If v4 SDKs reject unknown kinds, old
  clients simply never accept delegated packs, which is safe; the plan states whether that needs a
  `PROTOCOL_VERSION` change.
- **Corpus concurrency.** Only one corpus-touching package may be in flight (program README §5);
  coordinate with P4-10 and P4-13.

## Steps

1. Write `program/plans/P4-19.md` (all nine sections), with the open questions above for the
   human: allowed types, where the delegation is referenced, and manifest declaration. Set
   `awaiting-approval` and stop.
2. After approval: contract and `shared-protocol` types; the corpus cases and mirrors.
3. SDKs in wave order (`client-core` → Python → Swift → Godot).
4. Worker ingest checks, the CLI commands, the threat model; the green gate.

## Acceptance criteria

- [ ] `program/plans/P4-19.md` is merged (human approval) before any code lands.
- [ ] `releaseRecordCases` include: a valid delegated `data.json` pack; a delegated `godot.pck`
      (rejected); a pack id outside the prefix (rejected); a delegation signed by an unpinned key
      (rejected); an expired delegation (rejected); a revoked delegation (rejected); a content key
      signing an app record, a revocation or another delegation (each rejected).
      `pnpm gen corpus --check` is clean, mirrors included.
- [ ] The cases pass in `conformance/runners/node`, pytest, `swift test` and the Godot runner.
- [ ] Worker tests: a delegated record within scope is ingested; one outside scope is refused.
- [ ] `pkey release delegate` and a content-key publish have CLI tests.
- [ ] `docs/security/THREAT-MODEL.md` has the delegation branch and boundary.
- [ ] The green gate passes (`AGENTS.md`).
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm gen corpus --check
mise exec node@22 -- pnpm conformance
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- release
mise exec node@22 -- pnpm --filter @polaris-key/cli test
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift test )
```

## Hand-off

- Content teams (Diceroll's events and localisation) publish with the content key through the
  same `pkey release publish` path.
- Any later SDK (X-01, P6-05) implements the same chain against the same cases.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-19 done`.

## Plan amendments (P4-10)

The approved [`plans/P4-10.md`](../plans/P4-10.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Plan amendments (P4-13)

The approved [`plans/P4-13.md`](../plans/P4-13.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Plan amendments (P4-19)

The approved [`plans/P4-19.md`](../plans/P4-19.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Hand-off from P4-14

P4-14 (the blob collector) landed first. `CatalogRevocation.kind` already exists as
`"record" | "delegation"` in `core/hooks.ts`, and `core/blobGc.ts` `livePackReleases` ignores every
entry whose kind is not `record`. **This package must** exclude the releases a delegation
revocation yanks from the collector's live rules (a) pins and holds, (e) rollouts and (f) outlet
listings, and add a test for it (plan P4-19 §8.5: "releases yanked by a delegation revocation are
no live GC reference").

## Corrections from implementation

Recorded by the implementer; the code is the fact where this brief, the plan and the code differ.

- **`dataOnlyCases` has 76 cases, not 54.** The plan's 54; nine path-normalisation cases (`..`, a
  leading or inner `.`, an empty segment, a trailing `/` or `/.`, a leading `/`, a backslash, a
  `res://` scheme); one tail-bound case (`tail-bound-eocd-outside-accepted`, which pins
  `DATA_ONLY_TAIL_BYTES` the way the whitespace cases pin the head bound, its 65,557-byte tail
  written compactly as `tailFill`); and Amendment A1's twelve (below).
- **Budget.** The content source set (`content/` plus `plan-matrix.json`) was 4,638,353 B with the
  first 64 cases, over P4-10's 4.6 MB target (an earlier version of this note wrongly said it was
  inside it). With the tail-bound case's tail written as `tailFill` and Amendment A1's cases it is
  4,555,403 B (`content/` 3,936,133 B, `plan-matrix.json` 619,270 B): under the 4.6 MB target and
  the 5 MB budget.
- **`dataOnlyRefusal` checks rule 1 itself.** A path that fails the files index's path rules (not
  already normalised: nothing Godot's `simplify_path()` would change) is refused with rule
  `extension`, so the rule holds even where `checkPaths` was not run first (the lesson of P4-08).
  Which files are sniffed is decided by content (the head magics, the tail, and A1's text rule by
  extension class), never admitted by extension alone.
- **Amendment A1 (data-only hardening, lead-approved 2026-10-02; `plans/P4-19.md`).** Client-core,
  CLI and corpus only; the Worker's ingest stays extension-only.
  - A full 64-byte head window that is all whitespace (after a BOM), or that cuts a refused head
    (a prefix of a magic, or `extends`/`class_name` whose following byte lies beyond the window),
    is refused (`content`): Godot's text-resource loader and the GDScript tokenizer skip any
    amount of leading whitespace. `head-bound-whitespace-accepted` became
    `head-bound-whitespace-refused` (it expects `content`); `head-bound-all-whitespace-refused`, `head-bound-short-whitespace-accepted` and
    `head-word-straddle-refused` are added.
  - Text files (`json`, `csv`, `tsv`, `po`, `txt`) pass rule 5 over their whole decoded bytes
    (`dataOnlyTextRefusal`): invalid UTF-8 or a NUL, any of P4-08's script markers (`GDScript`,
    `CSharpScript`, `ScriptExtension`, `script/source`, `source_code`) in the text or in the text
    with every backslash removed, or a `\u` escape not followed by exactly 4 hex digits, a `\U` escape not followed by exactly 6 (VariantParser's form), or either decoding below 0x80 (an escape that could spell ASCII; escapes of non-ASCII characters, surrogate halves included, pass, because Python's `json.dumps` and .NET's `System.Text.Json` write one for every non-ASCII character), is `content`. Ordinary text that mentions a marker (a string "Learn GDScript", a JSON key `source_code`) is refused too: publishers must rename such keys or reword such text. `dataOnlyRefusal` gains
    a fourth argument, the whole file; a text file without it is refused. Cases with a whole-file
    `content` field: `text-object-script-refused`, `text-escaped-marker-refused`,
    `text-u-escape-refused`, `text-u-escape-nonascii-accepted`, `text-u-escape-malformed-refused`,
    `text-big-u-escape-nonascii-accepted`, `text-big-u-escape-ascii-refused`,
    `text-marker-png-ignored` and `text-invalid-utf8-refused`.
  - The engine's `noop` plan (a delegated release reusing an install that already holds the same
    payload) now re-sniffs that install's files instead of trusting how they were first admitted.
- **A feed `revocations[].kind` that is a string but not a vocabulary token** makes the member
  unusable, like a non-string `kind` (the plan named only the two outer cases). The member's
  `record`-uniqueness check counts entries that are later dropped for a forward `kind`.
- **`PackJournal.delegation?`** joins `PackInstall.delegation?`, so a delegated install resumes
  after a restart instead of re-planning. Both are optional; `PACK_STATE_VERSION` stays 1.
- **The engine's delegated surface** is "a release that is neither the stamp's pin or hold for
  that pack nor a stored revocation's replacement" (§2.4). So `ensure()` (the stamp's pins) never
  takes the delegated path; `ensureReleases()` and `estimateReleases()` (feed targets) do.
- **Where delegated installs live.** The storage ports root every committed payload at
  `<store>/<packId>/<payloadSha256>/` (Node `packages/sdk-node/src/packs/storage.ts`, `commit`;
  React OPFS `store/<packId>/<payloadSha256>/`, `packages/sdk-react/src/packs/opfs.ts`). A
  delegated pack id is its own directory, so it never overlaps another pack's tree; it shares a
  directory only with an install of the same pack and the same payload digest, which the `noop`
  re-sniff covers.
- **`runUpdateCheck`'s content input gains `delegated`**, the engine's `delegatedReleases()`
  (record hash → pack and delegation hash: stored and running delegated installs plus delegated
  feed targets verified in the process). Step 11's delegation relevance and the decision-input
  expansion read it. A stored revocation whose target is a known delegation has its replacement
  ignored.
- **The delegations read route returns each delegation's `jws` and `version`.** The CLI reads a
  stored delegation there (behind the publisher token) for both the content-key publish and
  `pkey release revoke --delegation <sha256>`, never from the record route, so both work whatever
  the product's release metadata access.
- **`gen constants` gains a GDScript naming rule.** `dataOnlyExtension`'s `json` maps to `JSON`,
  which shadows Godot's native `JSON` class (a parse error that broke the Godot runner). The
  GDScript renderer now writes a member whose upper-snake name is one of Godot's all-caps native
  class or built-in type names (`AABB`, `IP`, `JSON`, `OS`, `RID`, `UPNP`) with a trailing
  underscore (`PKeyConstants.DataOnlyExtension.JSON_`); every other language keeps `JSON`. A
  generator test pins it.
- **Python, Swift and Godot** list `packs.delegation` as `planned` (P4-25, P4-25, P4-26) in their
  `parity.json`; their generated constants carry the new limits and enums.

Proposed follow-ups (not in this package):

- P2-02: a second publisher entry scoped to packs under a prefix, so content CI need not run the
  release workflow (plan §8.2 risk 6).
- P4-25 and P4-26 port Amendment A1 with the rest of `dataOnlyRefusal` (the four-argument form and
  the `content` and `tailFill` case fields).
