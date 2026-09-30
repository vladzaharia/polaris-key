# S-07 Spike: re-check dated platform policies before connector work

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | S: Spikes                                                                                                                                                                                                                                                                                                                                                                                        |
| Size        | 0.25–0.5 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                          |
| Depends on  | none                                                                                                                                                                                                                                                                                                                                                                                             |
| Unblocks    | none in the graph; informs [D-01](D-01-diceroll-now.md), [P2b-03](P2b-03-availability-keys.md), [P2b-05](P2b-05-storefront-feeds.md), [P4-03](P4-03-ci-patch-artifacts.md), [P5-02](P5-02-asc-connector.md), [P5-03](P5-03-play-connector.md), [P5-04](P5-04-msstore-connector.md), [P5-06](P5-06-kotlin-aar.md), [P6-01](P6-01-commerce-bridge.md) and [P6-03](P6-03-update-funnel-autohalt.md) |
| Role        | `pkey-spike-runner`                                                                                                                                                                                                                                                                                                                                                                              |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                               |
| Gates       | none beyond `pnpm format` on the files it adds                                                                                                                                                                                                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                        |

## Goal

A research note, `notes/S-07-policy-recheck.md`, re-verifies every dated policy fact the research
relies on against its primary source, and is written as a checklist that a later work package can
re-run. For each fact it records: the claim as the research states it, where it is stated, the
source checked (URL, retrieval date, the page's own "last updated" date), the exact quote, a
verdict (unchanged, changed, or could not verify), and the briefs affected.

## Why

The research is dated 2026-09-29/30 and several of its facts had deadlines that same week.
[README §12](../../README.md#12-risks-and-open-questions) lists them under "Policy drift" and asks for a
re-check at implementation time; [README §1](../../README.md#1-scope-method-and-confidence) names the
most time-sensitive. They decide what connectors may do (P5-02–P5-04), how commerce works (P6-01),
whether downloaded packs may carry scripts (P4-03, P4-08), and what Diceroll must register now
(D-01). Some were read through a summarising fetch tool and are flagged for re-verification in the
notes themselves ([notes/E3 §G](../../notes/E3-windows-linux-web.md#g-unverified--conflicting-items-and-confidence),
[notes/E2 §G](../../notes/E2-android.md#g-open--unverified-items-spot-check-before-building)).

## Read first

- `AGENTS.md` and `.claude/agents/pkey-spike-runner.md`.
- [README §1](../../README.md#1-scope-method-and-confidence), [§3.8](../../README.md#38-distribution-distribution-service) (connectors), [§3.10](../../README.md#310-commerce-and-entitlements), [§4](../../README.md#4-per-platform-playbooks) (policy columns), [§12](../../README.md#12-risks-and-open-questions).
- [notes/E1 §A3](../../notes/E1-apple.md#a3-app-review-guidelines-relevant-to-downloaded-content-text-of-june-8-2026-revision), [§A5](../../notes/E1-apple.md#a5-eu-dma-japan-brazil-alternative-distribution), [§E5](../../notes/E1-apple.md#e5-uploading-versioning-review-and-testflight-server-side-automation); [notes/E2 §A4](../../notes/E2-android.md#a4-play-policy), [§B1](../../notes/E2-android.md#b1-android-developer-verification-status-at-2026-09-29), [§G](../../notes/E2-android.md#g-open--unverified-items-spot-check-before-building); [notes/E3 §0](../../notes/E3-windows-linux-web.md#0-ten-findings-that-change-the-design), [§A1](../../notes/E3-windows-linux-web.md#a1-microsoft-store), [§B2](../../notes/E3-windows-linux-web.md#b2-flatpak--flathub), [§G](../../notes/E3-windows-linux-web.md#g-unverified--conflicting-items-and-confidence); [notes/E9 §2.4](../../notes/E9-runtime-building-blocks.md#24-android-developer-verification-dated).

## Scope

**In** — the facts to re-check. Rows 1–15 are policies, fees and deadlines; rows 16–18 are API
facts that the connector briefs asked this spike to confirm. Fetch each source yourself; the notes'
source lists give full URLs.

| #   | Fact as the research states it                                                                                                                                                                                                                                                                                                                                        | Stated in                                  | Primary source to read                                                                                                                                           | Affects                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | Android developer verification: enforcement from **2026-09-30** for installs from participating stores (Google Play, HONOR, OPPO, Galaxy Store, Palm Store, V-Appstore, GetApps) in Brazil, Indonesia, Singapore and Thailand; global in **2027**; direct sideloads not yet in scope                                                                                  | README §1, §4.2, §12; E2 §B1; E9 §2.4      | `developer.android.com/developer-verification`, its `/guides` and `/guides/faq`                                                                                  | D-01, P2b-03, P2b-05, P5-06               |
| 2   | Registration mechanics: $25 fee (waived for Limited Distribution, up to 20 devices); key-ownership proof via a `verificationToken` in `adi-registration.properties`; the Developer Console API takes OAuth web-server flow only; the advanced flow's 24-hour wait                                                                                                     | E2 §B1                                     | `developer.android.com/developer-verification/guides` and `/guides/developer-console-api`                                                                        | D-01, P2b-03                              |
| 3   | F-Droid hosts upstream developer-signed packages beside its own (2026-09-18); F-Droid 2.0 shipped 2026-09-24 (secondary sources)                                                                                                                                                                                                                                      | E2 §B1                                     | `f-droid.org/en/news/`                                                                                                                                           | P2b-05, D-03                              |
| 4   | Apple EU unified terms from **2026-10-01**: a 5% Core Technology Commission replaces the Core Technology Fee; the Initial Acquisition and Store Services fees end; broader marketplace eligibility; no EU entity needed (DPLA updated 2026-08-18)                                                                                                                     | README §1, §4.1, §12; E1 §A5               | `developer.apple.com/support/dma-and-apps-in-the-european-union/`; the Developer Program License Agreement                                                       | P2b-05 (PAL source), P5-02, D-05          |
| 5   | Alternative marketplaces in Japan (iOS 26.2+) and Brazil (iOS 26.5+); AltStore PAL serves EU, JP and BR; the Japan and Brazil business terms were **not** verified (pages returned 404)                                                                                                                                                                               | E1 §A5                                     | the DPLA attachments; Apple's alternative-marketplace pages; `faq.altstore.io/developers/distribute-with-altstore-pal.md`                                        | P2b-05, README §4.1                       |
| 6   | App Review Guidelines, revision of **June 8, 2026**: 2.5.2 and DPLA 3.3.1(B) (downloaded code), 3.1.1 and 3.1.3(b) (IAP; cross-platform items), 4.2.3(ii) (size disclosure), 2.2 (TestFlight: no paid betas, 90-day builds), 2.4.5 (Mac App Store)                                                                                                                    | README §0.4, §3.10, §4.1, §4.3; E1 §A2–§A3 | `developer.apple.com/app-store/review/guidelines/` (check the "Last Updated" date and each clause's text); the DPLA                                              | P4-03, P4-08, P6-01, D-05                 |
| 7   | Play Device and Network Abuse: no self-update outside Play; no downloaded dex, JAR or `.so`; the interpreter exception; `REQUEST_INSTALL_PACKAGES` restricted                                                                                                                                                                                                         | README §4.2; E2 §A4                        | `support.google.com/googleplay/android-developer/answer/9888379` and `/answer/12085295`                                                                          | P4-03, P4-08, P5-06, D-01                 |
| 8   | Play fee programmes: US (effective 2025-10-29; alternative billing and links 2025-12-09; reporting and fees from **2026-10-01**); "Expanded billing choice" from **2026-06-30** (US, EEA, UK: 10% service fee on the first $1M, 5% billing fee with Play Billing), new programmes **2026-09-30**, wider rollout per secondary sources; EEA external offers 2025-08-19 | README §1, §3.10, §12; E2 §A4              | `support.google.com/googleplay/android-developer/answer/15582165` and `/answer/10281818`; `android-developers.googleblog.com/2026/06/play-expanded-billing.html` | P6-01                                     |
| 9   | Play Billing Library 7 must be migrated by **2026-08-31** (extension to 2026-11-01); latest listed 9.1.0 (2026-06-18)                                                                                                                                                                                                                                                 | E2 §A4                                     | `developer.android.com/google/play/billing/release-notes` and the deprecation FAQ                                                                                | P5-06, P6-01, D-05                        |
| 10  | Target API 36 for new apps and updates from **2026-08-31** (extension to 2026-11-01); 16 KB page-size support, with updates blocked from **2027-02-01** (the note says this differs from earlier dates)                                                                                                                                                               | E2 §A4; README §5.10 (NDK r28+)            | `support.google.com/googleplay/android-developer/answer/11926878`; `developer.android.com/guide/practices/page-sizes`                                            | P5-06, D-01, D-03                         |
| 11  | Microsoft Store: `msstore` CLI and Action update only **free** products (docs dated 2026-08-30 and 2026-09-28); the first submission is manual; Store Policies v7.20 (2026-09-14): 10.2.5 (games ship as MSIX, Store-updated), 10.2.2 (no dynamic code), 10.2.9 (URL path for non-games only), 10.8.1 (Store purchases)                                               | README §1, §3.8, §4.4, §12; E3 §0, §A1     | `learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/overview`; `learn.microsoft.com/en-us/windows/apps/publish/store-policies`                       | P5-04                                     |
| 12  | Flathub's generative-AI policy: AI tools or agents must not open or automate submission pull requests or write their commit messages, and manifests must not contain AI-generated or AI-assisted content (extracted by a summariser, 2026-09-29)                                                                                                                      | README §4.5, §12; E3 §0 item 9, §G         | `docs.flathub.org/docs/for-app-authors/requirements` (read the raw page or its source repository)                                                                | P2b-05; anything touching Flathub         |
| 13  | Downloaded scripts in packs: the data-only rule for store builds rests on rows 6, 7 and 11; restate whether it still holds per store                                                                                                                                                                                                                                  | README §0.4 item 6, §3.7, §12              | rows 6, 7 and 11                                                                                                                                                 | P4-03, P4-08, outlet capabilities (P3-01) |
| 14  | winget rejects redirected installer URLs (`Validation-Indirect-URL`) and needs HTTPS, a publisher-domain match and a stable hash                                                                                                                                                                                                                                      | README §4.4; E3 §0 item 8, §A4             | the `microsoft/winget-pkgs` validation documentation                                                                                                             | P2b-04, P2b-05                            |
| 15  | Steam: digital unlocks through Steam DLC or the microtransaction API; "no third-party payments inside the Steam build" is from secondary sources                                                                                                                                                                                                                      | README §3.10, §4.7; E3 §B3, §G             | `partner.steamgames.com/doc/features/microtransactions` and `/doc/store/application/dlc` (partner-only pages: "could not verify" is an acceptable verdict)       | P6-01                                     |
| 16  | App Store Connect: API 4.x (4.5 latest listed), exactly 12 webhook event types, up to 10 webhooks per app, no webhook for phased release, review submissions or internal TestFlight; Apple-hosted Background Assets: 200 GB and 200 packs per app                                                                                                                     | README §3.8, §4.1; E1 §A1, §E5             | the ASC API release notes and `webhook-events` pages; ASC Help "Apple-hosted asset pack size limits"                                                             | P5-02, P5-08, S-01                        |
| 17  | Play Developer Reporting API: crash-rate and ANR-rate metric sets usable for auto-halt; the metric-set and metric names were **not** verified                                                                                                                                                                                                                         | README §3.8; E2 §A1                        | `developers.google.com/play/developer/reporting` (reference pages for the metric sets)                                                                           | P5-03, P6-03                              |
| 18  | Microsoft Store submission API for MSIX apps: submission status values, `packageRollout` fields and flight endpoints; the MSIX API page was referenced but not fetched                                                                                                                                                                                                | README §3.8; E3 §A1                        | the "Create and manage submissions" pages of the Microsoft Store submission API on `learn.microsoft.com`                                                         | P5-04                                     |

**Out** (and where it belongs instead):

- Changing any README decision; propose edits in the note instead (the lead routes them).
- Implementing anything a changed policy implies (→ the affected briefs above).
- Engine and library release facts (Godot, Sparkle, Velopack versions), unless a row above depends
  on them.

## Design notes

- **Primary sources only, read raw.** Apple documentation has JSON endpoints under
  `developer.apple.com/tutorials/data/documentation/…` (the method notes/E1 and notes/E9 used);
  Microsoft Learn pages link to their Markdown source; Flathub's docs have a source repository.
  Where a summarising fetch disagrees with the raw page, the raw page wins (notes/E9 method).
- **Quote, don't paraphrase,** for every verdict of "unchanged" or "changed". Put the quote in the
  note with its URL and retrieval date.
- **Evidence tags** as in the notes: [V] primary source read raw, [S] summary only, [I] inference.
- **Flathub row:** reading the policy is fine; do not open, comment on or automate anything on
  Flathub from this work package.
- **Re-runnable:** keep the table's shape so a connector package can re-run just its rows at its
  start. Recommend which rows each connector should re-run.
- If a fact changed, update the affected briefs' text in the same branch (as
  `.claude/agents/pkey-spike-runner.md` says) and list each edit in the note.

## Steps

1. For each row, fetch the primary source raw, record the page date, and quote the relevant text.
2. Give each row a verdict and, where changed, the new fact and the consequence.
3. Update affected briefs where a fact changed; propose README edits in the note.
4. Write the note's summary: what changed, what could not be verified, and what each connector
   package should re-check at its start.

## Acceptance criteria

- [ ] `notes/S-07-policy-recheck.md` exists with the provenance blockquote, question, short answer,
      method, results, recommendation, affected briefs and sources.
- [ ] All 18 rows have a verdict, a quote (or the reason none could be obtained), the URL, the
      retrieval date and the page's own date.
- [ ] Every changed fact names the briefs it affects; those briefs are updated in the same branch,
      or the note says why not.
- [ ] Proposed README edits are listed, not applied.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
mise exec node@22 -- pnpm format
```

## Hand-off

D-01 takes rows 1, 2, 7 and 10; P2b-03 and P2b-05 rows 1–5, 12 and 14; P5-02 rows 4, 6 and 16;
P5-03 rows 8, 9 and 17; P6-01 rows 8, 9 and 15; P5-04 rows 11 and 18; P4-03 and P4-08 row 13.
Each of those packages re-runs its rows if more than a month has passed. Set the status with
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set S-07 done`.
