# Polaris Key documentation: the plan (2026-10-08)

**What this is.** The plan for first-class Polaris Key documentation, written against `main` at
`3b29a678c`. Owner's brief: "first class documentation, thorough but not overly so". Later
request: "consumer facing documentation… Both should use the same documentation site, and the
site itself should be made to look like it's integrated into Polaris Key's main branding system".
Revised the same day after an editor's review; §11 logs what changed.

Inputs:

- Five research passes covering eleven doc sites: Cloudflare, Vercel, Supabase, Firebase,
  Stripe, Clerk, RevenueCat, Sentry, Tailscale, Diátaxis, and consumer help centres (Apple,
  Steam, Notion, Discord, Spotify, Adobe, Paddle).
- Four audits of `packages/docs`: content, consolidation fit, consumer help and visual design.
- The DX consolidation plan (`docs/research/2026-10-07-dx-consolidation/`).

| File                               | For                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `README.md` (this file)            | principles, page types, the site's structure, code samples, every page's fate, work packages, help, design                      |
| [`style-guide.md`](style-guide.md) | how every page is written: voice, the Help voice, copy rules, words, code, admonitions, images. The only home for writing rules |

**In one paragraph.** One Starlight site at `key.plrs.im/docs` gets three doors:

- **Help** is public. It serves people using an app built on Polaris Key, who never chose
  Polaris Key.
- **Developers** is for anyone building apps. It is public (D2).
- **Operate** is for console operators and platform admins. Contributor pages sit inside it.

Each door has its own sidebar and search scope, and one rule decides which door owns a page
(§3.1), so nobody wades through another audience's pages. Help is task-first. Each message an app
or the portal shows has its own anchor, so readers arrive from the portal's Help links, from an
app's "Get help", from emails and from search on the exact words they saw.

Developer pages put each SDK's two integration paths, **Drop-in UI kit** and **Your own UI**,
side by side as equal lanes. Code is generated or compiled in each SDK's own CI lane, never
pasted. The first-product path starts in the console, and a fresh reader runs it end to end
before the docs promise how long it takes. The console's Integration page deep-links into the
right lane for the right SDK.

Every page has a declared type with a length budget. Reference pages are generated. A page lands
in the same PR as the behaviour it describes. The site renders the console's own components
(`packages/admin/src/ui`), so docs, console and portal share one header feel, one nav, the same
tabs, pills, callouts, code frames and tables, both themes and one theme choice. Twelve batches,
split into 28 packages of about ten pages or one engineering concern each, deliver it. A skeleton
package lands first, so every other package can start at once.

---

## 0. Decisions this plan needs, and the answers it assumes

| #   | Decision                                                                                                                                                                                                                                                 | Answer assumed                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Who                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| D1  | Consumer help on the same docs site, public. This reverses AGENTS.md rule 11 ("there is no public docs origin") for `/docs/help/`, `/docs/access/` and the landing page. It amends integration.md C-51 and I-19 ("customer help moves into the portal"). | **Yes**: the owner's request of 2026-10-08. Rule 11's text and C-51 are amended in DOC-03b (§10).                                                                                                                                                                                                                                                                                                                                                                                  | Owner (given)                                                                                                       |
| D2  | Who reads the developer docs (Start, Build, Features, Reference).                                                                                                                                                                                        | **Anyone: the developer sections are public** (owner decision, 2026-10-08, superseding the lead's members-only call). Operate → Console stays member-only; Operate → Platform, Contribute and the runbook stay admin-only. Every page's source is already public in the MIT repo, so the gate hid nothing; it only stopped integrators following the console's links into the docs. Public developer pages are indexable and in the sitemap, and `llms.txt` can cover them (§3.9). | Owner (2026-10-08)                                                                                                  |
| D3  | The two integration paths: recommend one?                                                                                                                                                                                                                | **No.** They are equal lanes with a comparison table and no "Recommended" badge (owner direction, 2026-10-07). The console offers the kit first, because it renders a snippet; the docs give both equal depth.                                                                                                                                                                                                                                                                     | Owner (given)                                                                                                       |
| D4  | Polaris Key support and privacy addresses (`[[OWNER: support email]]` in `docs/legal/help.md`).                                                                                                                                                          | Owner step, **required before Help goes public** (DOC-03b's switch). A reader locked out of their account, or asking for a copy of their data, has nobody else to ask. Until the address exists, Help stays member-only, as the users pages are today. If the owner wants Help public sooner, the owner accepts that gap and the lead records it.                                                                                                                                  | Owner step (owner-steps checklist)                                                                                  |
| D5  | Publish the privacy policy and terms (`docs/legal/privacy.md`, `terms.md`).                                                                                                                                                                              | They publish only after counsel signs off. Until then, Help has a plain "Your data and privacy" page with no legal claims.                                                                                                                                                                                                                                                                                                                                                         | Owner step                                                                                                          |
| D6  | Translate Help?                                                                                                                                                                                                                                          | English in 0.9. Message titles in the translated copy catalogs are indexed as search aliases from the start (§7.5). The top 15 articles go into the kit-copy locales later (P3, §7.6).                                                                                                                                                                                                                                                                                             | Lead                                                                                                                |
| D7  | Where the docs' components come from.                                                                                                                                                                                                                    | **The console's own `ui/`** (`packages/admin/src/ui`). Static components render at build time with no client JavaScript; interactive parts use class constants the console components export and use themselves (§8.2). No new brand stylesheet, and the mockup kit is not extracted.                                                                                                                                                                                              | Lead, under delegated authority. DOC-02a records it in components.md §7 and BRAND.md §2, lead-approved in plan mode |
| D8  | Reserve the product slug `help`.                                                                                                                                                                                                                         | **Yes.** `/help` and `<baseUrl>/help/code/<id>` would otherwise collide with a product slugged `help`. DOC-03b adds it to `RESERVED_PRODUCT_SLUGS` and the schema. The lead confirms no registered product uses it before the alias goes live.                                                                                                                                                                                                                                     | Lead                                                                                                                |

---

## 1. Principles

1. **Three doors, one site, one look.** Help, Developers and Operate share one build, the
   console's own components and one theme choice. Each door has its own landing page, sidebar,
   search scope and header links. A reader in one door never meets another door's sidebar. One
   rule decides which door owns a page (§3.1).
2. **One task per page; one home per concept.** A page does one job: route, teach, guide, explain
   or look up. A concept is explained once. Everywhere else gets one sentence and a link (the
   EXPERIENCE.md rule "one home per concept" applied to prose). Restating a rule list on a second
   page is a defect: the audits found coherence rules described four different ways.
3. **Truth comes from the source.** These are generated and checked with `--check`: reference
   tables, the console tour, roles, channels, error codes, the CLI and Action reference, the
   upgrade table, install snippets, SDK snippets, and the message titles in Help. Anything that
   cannot be generated is compiled or validated in CI. A path that promises a result is run end to
   end by a fresh reader. A page about new behaviour lands **in the PR of the package that ships
   it**. Until then the page states what is true today.
4. **Both integration paths are equal lanes.** Every SDK and every feature that touches the app
   shows **Drop-in UI kit** and **Your own UI** at the same depth: setup, the code, the states to
   handle, the check. Neither is a footnote of the other.
5. **Start from the reader's situation and their words.** A consumer arrives with the text their
   app showed, so the heading is that text verbatim, and its anchor is the message's id. A
   developer arrives from Integration with an SDK in mind, so the link preselects it. An operator
   arrives from a console page, so the page is named after that screen.
6. **Thorough through links, not length.** Overview → how-to → reference is the depth. Each page
   type has a word budget (§2), extras sit after the working path as "Optional:", and related
   links are three to five, chosen by hand. Nothing is published that nobody can use: no
   placeholder pages, no spec pages for components no kit ships.
7. **Types are enforced, not decorative.** Frontmatter declares `type`. A lint checks each type's
   skeleton: a how-to has numbered steps, an overview has no code, Help has no developer words.
   The doors and access tiers come from directories, and a test pins them.
8. **Readable by people and agents.** Server-rendered text. The primary answer never sits only
   inside a tab or a collapsible. Tab sets flatten into labelled sections in a Markdown export
   (P3).

---

## 2. Page types

Diátaxis supplies the four kinds (tutorial, how-to, explanation, reference). Polaris Key adds:

- **Overview**, the routing type. A decision page ("Choose your integration") is an Overview with
  a comparison table in place of the cards;
- two consumer types: **Help article** and **Help messages**;
- an operator **Runbook**;
- **Troubleshooting**, kept separate, because people arrive from an error, not a menu.

`type` in frontmatter names one of them. DOC-03a's lint checks the skeleton. The budgets live
here and nowhere else.

| Type                | Diátaxis            | Title pattern                                                                                                                | Intro                                                                                                      | Prerequisites                              | Steps                                                                                                                                                                                           | Code                                                                         | Result                                                                                                                                                                                           | Next steps                                                                                      | Budget                                                    |
| ------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Overview**        | (routing)           | The noun: "Licensing", "Help", "Swift"; a decision page starts "Choose…"                                                     | One paragraph: what it is, who it is for, a **Requires** line (features, role)                             | none                                       | none                                                                                                                                                                                            | none (an SDK overview may show its one install line, scope routing included) | Cards: Get started (1–2), How-to guides, Concepts, Prebuilt UI, Reference, Troubleshooting, each a name plus one line. A decision page: options as columns, criteria as rows, one "You are…" row | Related features (at most 3)                                                                    | one screen; ≤ 250 words outside the cards or table        |
| **Quickstart**      | tutorial            | "Your first product", "Swift quickstart"                                                                                     | What you will have at the end, in one sentence. A duration only once a fresh reader has measured it (§6.2) | Numbered: role, tool versions, files       | Numbered H2s ("1. Create the product"). Each ends with **You should see…** (output, screen, Verified)                                                                                           | Generated or included, titled, both lanes where a screen appears             | "What you built", 2–3 lines                                                                                                                                                                      | **If it isn't working** (≤ 5 links, the first to Troubleshoot your integration), then 3–5 cards | ≤ 8 steps; ≤ 900 words of prose                           |
| **How-to**          | how-to              | An imperative verb phrase, no "How to": "Add licensing to your app"                                                          | One sentence on what you achieve, then the **Requires** line (feature, role, SDK version)                  | Bulleted, each linked                      | Numbered, one action each, tagged where it runs (**Console**, **App**, **Server**, **CLI**), exact UI labels in bold, full commands; then "Optional:" steps                                     | SDK picker plus lane tabs when the app is involved                           | **Check it works**: Verified on Integration, expected output                                                                                                                                     | **If it isn't working** (≤ 5 links), then 3–5 next links                                        | ≤ 10 steps per phase; ≤ 1,200 words                       |
| **Concept**         | explanation         | A noun phrase you could prefix with "About": "Release tracks"                                                                | A one-line definition                                                                                      | none                                       | none                                                                                                                                                                                            | Short illustrations only                                                     | Why it exists, how it behaves, a Tidewater example, edge cases                                                                                                                                   | The how-tos that use it, its reference                                                          | ≤ 1,500 words                                             |
| **Reference**       | reference           | The thing: "Error codes", "pkey CLI"                                                                                         | What it covers and **what it is generated from**                                                           | none                                       | none                                                                                                                                                                                            | One example per entry                                                        | A quick table first, then entries in a fixed order (name, type, default, required, constraints, since); never collapsed or tabbed                                                                | none                                                                                            | generated: complete; hand-written: ≤ 3,000 words per page |
| **Troubleshooting** | how-to (from error) | "Troubleshoot licensing", "Troubleshoot your integration"                                                                    | One line                                                                                                   | none                                       | Each H2 is the symptom or the verbatim error (≤ 70 characters; anchor = code), then **Cause**, **Fix**, **Check it works**                                                                      | Only in the fix                                                              | Entries ordered by how often they happen                                                                                                                                                         | A link to the error reference                                                                   | ≤ 150 words per entry; split past ~10 entries             |
| **Help article**    | how-to (consumer)   | The task in the reader's words ("Move your license to a new computer") or the exact on-screen title ("Device limit reached") | One sentence on what this helps with; an **Important** callout for what can't be done or who can do it     | "Before you start": the device, your email | For destructive actions, **What happens when you…** first. Then branches by situation, easiest first, ≤ 7 steps each, exact labels in bold                                                      | none (values such as a checksum command are allowed)                         | **Check it worked**; **Undo** when possible                                                                                                                                                      | **Still need help?**: one sentence and a link to **Get help with an app**                       | ≤ 600 words                                               |
| **Help messages**   | troubleshooting     | The group: "Messages about devices"                                                                                          | One line                                                                                                   | none                                       | Each H2 is the exact on-screen title from the copy catalog (anchor = the message id, §7.1), then the message as the app shows it, **Why you see this** (1–2 plain sentences) and **What to do** | none                                                                         | none                                                                                                                                                                                             | Still stuck?                                                                                    | ≤ 120 words per entry                                     |
| **Runbook**         | how-to (operator)   | An imperative: "Rotate the KEK", "Recover a locked-out console"                                                              | When to use it, the impact, **Role required**                                                              | Access, tools                              | Exact commands; **Verify**; **Roll back**; **Escalate**                                                                                                                                         | Shell                                                                        | The verify step                                                                                                                                                                                  | The incidents index                                                                             | one procedure; ≤ 1,500 words                              |

A **changelog entry** is data, not a page. Its frontmatter has `date`, `version`, `type` (feature,
fix, breaking, removed, security), `services[]`, `sdks[]` and, for a removal or rename,
`replaces: [{ old, new, surface, sdk }]` (`surface` is one of `sdk`, `manifest`, `cli`, `action`,
`console`). The body is at most 150 words. A removal names its replacement and carries **Action
required**. It links the how-to. Entries are rendered globally, per feature and per SDK, and the
`replaces` rows build the upgrade table (§3.5).

**Frontmatter.** The `docsSchema` is extended in `src/content.config.ts`. Values are quoted
(AGENTS.md):

```yaml
---
title: "Add licensing to your app"
description: "Gate your app on a license, with the drop-in kit or with your own screens." # the one-sentence summary
type: "how-to" # overview | quickstart | how-to | concept | reference | troubleshooting | help | help-messages | runbook
services: ["license"] # service slugs from tools/services.json: the accent, the Requires chips and the search filters
sdks: ["node", "react", "python", "swift", "kotlin", "godot"] # shows the SDK picker; the console link test reads it
lanes: ["kit", "library"] # shows the lane tabs; the console link test reads it
lastReviewed: "2026-10-08" # required on hand-written pages; generated pages show their source instead
status: "shipped" # shipped | stub (DOC-03a's hidden placeholder, gone by the 0.9.x exit)
---
```

The audience and the access tier are **not** frontmatter. They come from the directory (§3.1),
so they cannot disagree with the gate. There is no `not-built` page status: a component or kit
nobody can use is a row in a generated table (§5, UI kits), not a page.

---

## 3. Information architecture

### 3.1 One site, three doors, three access tiers

| Door                                 | Paths                                                                 | Readers                                              | Access                                     |
| ------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| Landing                              | `/docs/`                                                              | anyone                                               | **public**                                 |
| Access page                          | `/docs/access/`                                                       | anyone sent from an Operate page                     | **public**                                 |
| **Help**                             | `/docs/help/…`; short alias `key.plrs.im/help/…`                      | people using an app built on Polaris Key             | **public**: no session, indexable, sitemap |
| **Developers**                       | `/docs/start/`, `/docs/build/`, `/docs/features/`, `/docs/reference/` | developers building on Polaris Key (console members) | **public** (D2)                            |
| **Operate**: Console                 | `/docs/operate/console/…`                                             | operators using the console                          | **member**                                 |
| **Operate**: Platform and Contribute | `/docs/operate/platform/…`, `/docs/contribute/…`                      | platform admins; contributors to Polaris Key         | **admin**: `can('platform.docs')` (ST-29)  |

**Which door owns a page.** Developers and Operate both serve console members, often the same
person, so the rule follows the subject, not the reader:

- **Features** own everything about one feature, its console screens included. Licenses, Tiers,
  Enrollment, Batches, Catalog, Profiles, Releases, Rollouts, Channels and the rest are
  documented in their feature's how-tos, and their console **Docs** buttons land there.
- **Operate → Console** owns only screens that span the product or several features: the console
  tour, **Create and set up a product** (the product's Settings and Services; it links Your first
  product for the steps rather than repeating them), Users, Presentation, Keys and secrets,
  Activity, Members and roles, and **Help a customer**.
- **Operate → Platform** owns the platform screens (Settings, Deployment, Operations, Store
  connections) and the runbooks.
- **Developers → Start and Build** own work that happens outside the console (SDKs, the CLI, CI,
  manifests) and the Integration page, which exists to connect an app (`build/integration`).

`nav-docs-targets.test.ts` (DOC-03a) checks every console item's Docs target against the rule: a
feature section's items point under `features/<feature>/`, and Core and Platform items point under
`operate/`. Three items follow their subject instead: **Core → Devices** points at Licensing,
**Platform → Package feeds** at Ship builds → Packages, and **Platform → Override migration** at
Managed config.

**How the split works** (DOC-03b):

- The build emits `dist/docs-access.json`, which maps path prefixes to tiers. The worker's
  `docs.ts` serves a public path with no session. It gates a member path on a console session and
  an admin path on `can('platform.docs')`.
- **No dead ends.** A reader without the right session who opens a gated page is sent to the
  public **access page** (`/docs/access/?returnTo=<path>`). It says who these pages are for and
  offers **Sign in** (the console sign-in, carrying `returnTo`) and **Using an app? Go to Help**.
  A member opening an admin page sees the same page with the admin wording.
- **Caching.** Public HTML is cacheable. Gated HTML stays `no-store`. The build records, for every
  file under `/_astro/`, the pages that reference it. CSS, fonts, layout JavaScript and anything a
  public page references are `public, immutable`. A file only gated pages reference (an imported
  image, a page's script chunk) takes the strictest tier among them and is served behind that gate
  as `private, immutable`.
- **Pagefind runs once per tier**: `pagefind/help` and `pagefind/developers` (both public),
  `pagefind/member` and `pagefind/admin`. The member and admin bundles sit behind their tier's
  gate. The search dialog loads the public bundles and calls `mergeIndex` for each gated bundle the
  reader can fetch. Gated text never reaches a public index.
- **The tier rule in `check:links`**: a public page links only to public pages, and a member page
  never links to an admin page. **One exception, in the page chrome only:** the landing's door
  cards may link to the gated door's overview (`/docs/operate/`), and the link carries the label
  "For console members". The lint allows exactly those
  components; any such link in page content fails. Gated pages carry `noindex`, and the sitemap
  lists public pages only.
- **`key.plrs.im/help` and `/help/*` redirect** (302) to `/docs/help/*`. This is a new worker path:
  an OpenAPI narrative row plus the `routeCoverage` table (rule 10). `help` joins
  `RESERVED_PRODUCT_SLUGS` and `$defs.slug.not.enum` in `product.schema.json`, with a row in the
  reserved-slug test (D8). The build also writes one redirect page per message id at
  `/docs/help/code/<id>/`, which forwards to the entry's anchor (§7.4). An id the docs do not know
  yet goes to the 404 page, which sends it to `/docs/help/messages/?code=<id>`.
- A public-content guard checks every page in `help/`: no code fences except values, no
  environment-variable names, no developer words (style guide §3).

### 3.2 The full sidebar

Each door renders only its own tree: a `Sidebar.astro` override picks the tree by path prefix.
In Developers and Operate, groups collapse and only the group holding the current page is open,
as in the console. Help groups are short and stay open. Items marked _(package)_ appear when that
package ships; before then they stay out of the sidebar.

```text
HELP  (public)                                    DEVELOPERS  (public)
Help home                                         START HERE
GET STARTED                                         Overview
  What is Polaris Key?                              Your first product
  Activate your app                                 Choose your integration
  Emails from Polaris Key                           How Polaris Key works
  Get help with an app                              Concepts and glossary
SIGN IN                                           BUILD
  Sign in to Polaris Key                            Install the SDKs and the CLI
  Your sign-in code didn't arrive                   Node     › Quickstart · Reference · Terminal kit
  Use a passkey                                     React    › Quickstart · Reference · UI kit
  Approve a sign-in on another device               Python   › Quickstart · Reference · Terminal kit
  Secure your account                               Swift    › Quickstart · Reference · SwiftUI kit
  Sign in with your work account (I-30)             Kotlin   › Quickstart · Reference · Compose kit
  Messages about signing in                         Godot    › Quickstart · Reference · Godot kit
YOUR LIBRARY                                        Drop-in UI kits › Overview · Theming ·
  Your library                                        Localization · Components
  Add a license with a key                          The .pkey manifest › Overview · Product ·
  Get free apps from Discover                         Catalog · Release · Distribution ·
  Find a lost license key                             Register from a repo · Editor setup
  What your license status means                    Web apps and CORS
  Remove an app from your library                   The Integration page (ST-41)
  Messages about your license key                   Test your integration
  Messages about your license status                Troubleshoot your integration
DEVICES                                             Go-live checklist
  Manage your devices                               Upgrade to 0.9
  Move your license to a new computer             FEATURES   (each with the fixed skeleton, §3.2.1)
  Device limit reached                              Licensing
  Activate a computer without internet              Managed config
  Messages about devices                            Ship builds
DOWNLOADS AND UPDATES                               Sign-in
  Download your app                                 Cloud Sync (one page until U-05)
  Check a download is genuine                       Commerce (CM-29)
  Install from AltStore, F-Droid, Obtainium       REFERENCE
    or Scoop                                        Overview
  Update your app                                   pkey CLI · GitHub Action · HTTP API · Routes
  Get beta versions (P2-08)                         Error codes · Validation codes · Settings
  Install packages with a personal token (F-33)     Config entry · Parity · SDK names (SP-35)
  Messages about downloads and updates              Channels (A-19) · Roles (ST-35)
PURCHASES                                           Compatibility and versions
  Restore a purchase                                What apps collect (technical)
  Refunds, billing and cancellations                Developer changelog
  Subscriptions and renewals (LX-41)                Protocol › Overview · Envelope · Trust ·
ACCOUNT AND PRIVACY                                   Discovery · Device principal · Errors on
  Your account and sign-in methods                    the wire · Cache and clock · License
  Bought with a different email or on Steam?          document · Config document · Bundles ·
  Delete your account                                 Packs · Fingerprint constants · Corpus
  Your data and privacy
  Choose what apps can see (I-34)                 OPERATE
  Sync your settings and saves (U-05, U-22)       CONSOLE  (console members)
  Messages about accounts                           Overview · Console tour (generated)
  Privacy policy · Terms (D5)                       Create and set up a product
MESSAGES                                            Users and accounts · Presentation
  All messages, A to Z                              Keys and secrets · Activity
  Other messages                                    Members and roles (ST-35)
                                                    Help a customer
                                                  PLATFORM  (platform admins)
                                                    Deploy Polaris Key · Operations runbook
                                                    Incidents · Platform settings · Email delivery
                                                    Store connections · Jobs · Security
                                                  CONTRIBUTE  (platform admins)
                                                    Overview · Setup · Layout · Architecture
                                                    Service model internals · Release truth store
                                                    Waves · Corpus · Releasing · Package feeds
                                                    Data model · Writing docs · AI agents in this repo
```

Each message group sits last in the task group it belongs to. **All messages, A to Z** is the one
index across them; **Other messages** holds connection, settings and "something went wrong"
messages, which belong to no task.

#### 3.2.1 Every feature has the same skeleton

`features/<feature>/` uses the owner-approved feature names: `licensing`, `managed-config`,
`ship-builds`, `sign-in`, `cloud-sync` and `commerce`. Each keeps its primary service's accent
through `section.ts`. Ship builds has sub-areas for releases, channels, updates, packages and
packs, each with its own service accent. The sidebar order never varies:

1. **Overview**: the Overview type. Its cards include **Prebuilt UI** (the kit components this
   feature uses) and **Reference** (the generated rows), which are links, not pages.
2. **Add <feature> to your app**: a how-to with the SDK picker and lanes. Integration links here.
3. **How-to guides**: one task each.
4. **Concepts.**
5. **Troubleshooting.**

A section with no pages is left out: a feature never shows an empty or near-empty page to keep
the shape. Fixing the order stops "Reference" and "Platform" from becoming junk drawers, as
Cloudflare's did, and teaches readers one layout.

Today `services.test.ts` ties one docs directory to each service slug. DOC-03a creates the
feature directories now and adds `src/lib/features.ts`, a map of feature → service slugs that a
test checks against `tools/services.json`. ST-38 replaces the map with `console.group` (an
acceptance line, §10), so the docs never wait on it.

### 3.3 How each audience finds its part at once

| Reader                | Arrives from                                                                                          | Lands on                                                                                                                               | When                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Consumer              | Portal footer, account menu or login card: **Help · Privacy · Terms** (PORTAL.md §3.2, SIGN-IN.md §3) | `/docs/help/`                                                                                                                          | P1 (DOC-06a)                                                         |
| Consumer              | A portal refusal, the Devices card, an empty library, the free-device flow                            | That article's anchor, from the portal's `helpLinks.ts` registry (§7.4)                                                                | P1 (DOC-06a)                                                         |
| Consumer              | A Polaris Key email footer; a security email's "Wasn't you?"                                          | `/docs/help/emails/#<notice-kind>`; `/docs/help/secure-your-account/`                                                                  | P1 (DOC-06b)                                                         |
| Consumer              | The public download page (`dl.plrs.im`)                                                               | `/docs/help/check-a-download/`                                                                                                         | P1 (DOC-06b)                                                         |
| Consumer              | A search engine, typing the message they saw                                                          | The message entry: its H2 is that message, and the page is indexed                                                                     | P1                                                                   |
| Consumer              | An app with its own UI that links its messages to Help                                                | `/docs/help/code/<id>/`, forwarded to the entry (the URL is listed in **States to handle**, §3.6)                                      | P1 (DOC-03b)                                                         |
| Consumer              | **Get help** on a kit's error, gate or activation screen                                              | `<baseUrl>/help/code/<id>`, forwarded to the entry                                                                                     | P2 (DOC-06c)                                                         |
| Developer             | The console **Integration** page, per feature and SDK                                                 | `/docs/features/<feature>/add-<feature>/?sdk=<sdk>&lane=<kit or library>` (§3.7)                                                       | P2 (ST-41)                                                           |
| Developer             | An SDK README on a registry                                                                           | `/docs/build/quickstart/<sdk>/`                                                                                                        | P1                                                                   |
| Developer             | `pkey help` or a CLI error                                                                            | `/docs/reference/cli/#<command>` or the matching how-to                                                                                | P3: the CLI prints no docs links today, and no package adds them yet |
| Developer or operator | A console page's **Docs** button (`nav.ts` `docs`, `docsLinks.ts`)                                    | The page the door rule gives (§3.1): the feature's how-to for a feature screen, the Operate page for a product-wide or platform screen | P1 (DOC-03a)                                                         |
| Operator              | NoAccessPage                                                                                          | **Members and roles**                                                                                                                  | P2 (ST-35)                                                           |
| Platform admin        | An alert or incident                                                                                  | `/docs/operate/platform/incidents/`                                                                                                    | P1                                                                   |
| Anyone without access | A link to a gated page                                                                                | `/docs/access/`                                                                                                                        | P1 (DOC-03b)                                                         |
| Contributor or agent  | `AGENTS.md`, `CONTRIBUTING.md`                                                                        | The repo stays the agent-readable source; `/docs/contribute/` for people                                                               | P1                                                                   |

The header is door-specific, which is how a consumer never meets developer navigation:

- **Help** pages show the lockup with a **Help** tag, **Search help**, **Your library ↗** (the
  portal) and the theme button. They have **no door tabs**. The only way across is the footer's
  "Building an app? Developer docs".
- **Developers** and **Operate** pages show the **Docs** tag, the door tabs (**Developers ·
  Operate · Help**), **Search the docs ⌘K**, **Developer changelog**, **Console ↗** and the theme
  button.

### 3.4 The landing page (`/docs/`, public)

- **H1** "Polaris Key docs", then one line: "Licensing, sign-in, config and delivery for apps and
  games." No counts.
- **Three doors** as equal cards, in plain words:
  - "I use an app that runs on Polaris Key": Help. "Activate, sign in, devices, downloads,
    refunds."
  - "I'm building an app with Polaris Key": Developers. "Your
    first product, start to finish." A duration is added only once the fresh-reader run (§6.2)
    has measured it.
  - "I run a Polaris Key console": Operate, labelled "For console members". "Products, licenses,
    customers, the platform."
- **Top help tasks**: six tiles (Activate your app, Device limit reached, Move to a new computer,
  Download your app, Your code didn't arrive, Refunds). A consumer who landed here by mistake is
  one click from the answer.
- Search, and the brand footer. No hero art, no stagger, no marketing line.

The **Developers overview** (`start/index`) adds:

- **Start with Your first product**, as the first card. It shows no install command: the first
  command a reader copies is in the install step, with the package scope routed first (§4);
- the six SDK chips, each linking its quickstart;
- **Latest changes**: the latest four developer changelog entries;
- "Set up your agent" (P3, after D2).

### 3.5 The getting-started paths

**Developers, one path.** **Your first product** merges `start/quickstart.md`,
`build/quickstart/index.md` and the general steps of `build/onboarding.md`. It starts in the
console, because that is the only route a new developer can finish alone.

- **0.9.x interim (P1, DOC-07a).** Written on today's console and CLI:
  1. **Console** Create the product: **Products → New product**. You should see the product's
     page and its slug.
  2. **Console** Turn on **License** under **Core → Services**.
  3. **CLI** Install the CLI and the SDK. Each package-manager tab routes the `@polaris-key` scope
     (or its ecosystem's equivalent) to `pkg.plrs.im` first, then installs (§4).
  4. **CLI** Generate the config: `pkey sdk --lang <sdk> --product <slug> --write`. You should see
     the file written and the pin fingerprints printed; compare them with the console.
  5. **App** Gate the app on a license: the kit lane or your own UI.
  6. **Console**, then **App** Issue a test license under **License → Licenses** and activate it.
     You should see the app unlock and the device appear under **Core → Devices**.

  `pkey doctor` is not a step yet: it validates a `.pkey/` directory first, which a console-first
  product does not have. It returns as the SDK's `doctor()` with SP-32. Keeping the manifest in a
  repo (`pkey init`, linking the GitHub App, resync) is **Register a product from its repo**, a
  how-to linked from Next steps.

- **Final (P2, SP-37).** It mirrors the wizard, as drawn in the reviewed mockup
  `sdk.docs-first-product`: **New product → `pkey sdk add` from Integration → `fromConfig()` then
  `boot()` → each feature in your lane → Verified**. Its code is generated by SP-33b.

After it, the reader goes to **Choose your integration** (§3.6), each feature's **Add <feature>
to your app**, **Test your integration** and the **Go-live checklist**. When something fails on
the way, **Troubleshoot your integration** (`build/troubleshooting`) covers the problems that cut
across features: discovery or the product returns 404, a pinned key doesn't match or its key id is
unknown, a signature isn't valid, the clock is off, browser apps hit CORS or cookie trouble, the
generated config file isn't found, an insecure base URL, a service that is off or unavailable,
registration closed, and plain network errors.

**Upgrading from 0.8.** 0.9 removes old names with no aliases (owner, 2026-10-07). **Upgrade to
0.9** (`build/upgrade-to-0-9`, P1, DOC-12a) is the one page to work through:

1. Widen the version range in each ecosystem (`^0.8` → `^0.9`, in package-manager tabs).
2. Run `pkey validate` in the product's repo. Each removed manifest field reports an error that
   names its replacement.
3. Apply the **Removed → Use instead** table for your SDK, the manifest, the CLI and the Action.
   It is generated from the changelog's `replaces` rows, and once SP-35 lands, from `api.json`'s
   removed rows; the page's SDK picker filters it.
4. Run `pkey doctor`, and the SDK's `doctor()` once SP-32 ships it.
5. Check Verified on Integration (from ST-41; before then, check that the app reaches its
   licensed state).

It is the one page exempt from the removed-names lint, so a search for an old word ("outlet",
"enrollment", "edge mint") lands on it. Every package that removes a name adds its `replaces` row
in the same PR (§10).

**Consumers.** Help home → **Activate your app**. It branches four ways: you have a key; you sign
in; the app is free; you bought it in a store (restore). Its first line says what Polaris Key is
in one sentence and links **What is Polaris Key?**.

**Operators.** Console tour (generated) → **Create and set up a product** → **Help a customer**.

### 3.6 The two lanes per SDK

**Choose your integration** (`start/choose-your-integration`, an Overview with a decision table).
It has two equal columns and no recommended badge (D3):

| Row             | Drop-in UI kit                                                                                                                        | Your own UI                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| You are…        | "…happy to show Polaris Key's screens, themed with your app's accent and icon"                                                        | "…drawing every screen in your own design system or engine" |
| You write       | One component or call per feature                                                                                                     | The calls plus a screen for every state                     |
| Handled for you | Every state, localization in the kit-copy locales, accessibility, phone layouts                                                       | Nothing; the page lists the states to handle                |
| You maintain    | Your theme                                                                                                                            | Your screens, as the SDK adds states                        |
| Available for   | A generated table per SDK and kit: shipped, recipe or not built yet (from `uiKits.ts`, trimmed to the must tier per owner decision 6) | Every SDK                                                   |

For Node and Python, the drop-in kit is a **terminal kit**, for command-line and terminal apps. A
server app uses the Your own UI lane's calls and **Verify on your server**.

Below the table, under "Other ways in", each with one line:

- the hosted customer portal (customers manage licenses, devices and downloads with no code from
  you);
- **Verify on your server** (`features/licensing/server-verification`);
- the HTTP API (a language with no SDK);
- the CLI and GitHub Action (CI).

**Per SDK** (`build/quickstart/<sdk>`). Install and Configure are shared. Then **Choose how your
app shows Polaris Key** offers two equal cards that set the `lane` choice. The first feature,
the license gate, appears in both lanes as tabs. Then Verify, and links to each feature's how-to
with `?sdk=<sdk>` preset. Lanes on today's shipped symbols:

| SDK    | Drop-in UI kit                       | Your own UI               |
| ------ | ------------------------------------ | ------------------------- |
| Node   | terminal kit (`terminal-node`)       | the client                |
| React  | `LicenseGate` and the kit components | the hooks                 |
| Python | terminal kit (`terminal-python`)     | the client                |
| Swift  | `PolarisKeyUI` (SwiftUI)             | `PolarisKey`              |
| Kotlin | the Compose kit                      | the client (coroutines)   |
| Godot  | the boot UI                          | the `PolarisKey` autoload |

**Per feature** (`features/<f>/add-<f>`). A page-level **SDK picker** sits in the content header,
not in a tab strip. Below it, one lane tab set (`syncKey="lane"`):

- **Drop-in UI kit**: the component, its props or options, what it calls underneath (the SDK
  methods and routes, as Vercel's Platform Elements pages do), and the theming link.
- **Your own UI**: the calls, then **States to handle**. Each state lists its catalog copy key and
  its Help URL (`/docs/help/code/<id>/`), so an app with its own screens can link its users to the
  right Help entry today, before the kits' own **Get help** link (P2). The list is generated from
  the component catalog (`packages/brand/kit-copy/components.json`) and the copy keys today, and
  from UK-02b's state fixtures once they land. It covers the device limit, the key-entry limit,
  `license_owned`, a release track not included, the version window and grace. The library lane
  cannot drift from what the kit handles.

Rules:

- **Equal depth.** Each lane has a setup delta, the code, the states and the check. The review
  checklist verifies it.
- **Never silent.** When an SDK has no kit for a feature, its kit tab shows "No <SDK> kit for this
  yet. Use your own UI." It links the recipe or the kit table's row, never a symbol that does not
  exist.
- **No nested tabs.** The SDK choice is a page control. Lanes are the only tab set around app
  code. Package-manager tabs appear only inside install steps.

### 3.7 How the console's Integration page links in

- ST-41's per-feature card renders the **kit** lane snippet for the chosen SDK, from SP-33's
  generator. Under it are three links:
  - **Build your own UI instead** →
    `/docs/features/<feature>/add-<feature>/?sdk=<sdk>&lane=library`
  - **<SDK> quickstart** → `/docs/build/quickstart/<sdk>/`
  - **Kit reference** → `/docs/build/ui/frameworks/<kit>/`
- A feature's **Not seen yet** state links **Troubleshoot your integration**.
- The links come from one generated table (`integrationDocs(feature, sdk, lane)`), registered in
  `docsLinks.ts`.
- The drift gate grows. `emit-slug-manifest.mjs` also emits each page's anchors and its `sdks`
  and `lanes` frontmatter (DOC-03a), and `docsLinks.test.ts` fails if the target page does not
  declare that SDK and lane.
- The picker reads `?sdk=` and `?lane=`, writes the choice to `localStorage`, and keeps it in the
  URL (`replaceState`). A shared link opens the same view.

### 3.8 Search

- `⌘K` opens one dialog. Results are grouped by door (**Help**, **Developers**, **Operate**).
  Each result shows its section path and a feature glyph.
- On Help pages, results are **Help only** by default, with a "Search all docs" chip (Developers is public; Operate joins for readers with its
  bundle).
- Guides rank above reference (Pagefind weights). `?q=` is linkable. Typing an error code or a
  message id jumps to its entry. A message's title in every translated copy catalog is indexed as
  an alias of its entry, so a reader who saw it in German still finds it.

### 3.9 Agents (P3)

- `.md` for every page, with tabs flattened into labelled sections.
- A **Copy page** button.
- `llms.txt` for Help and the developer door (both public, D2). AGENTS.md rule 11 stands for the
  gated Operate pages, and agents read the repo.

---

## 4. Code sample conventions

This section is the machinery: tab axes, where code comes from and what checks it. How code is
written (titles, formatting, comments, shell prompts) is in style guide §7, its only home.

**Tabs and sync.**

| Axis            | Labels                                                                 | Sync key  | Where                                                                      |
| --------------- | ---------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------- |
| SDK             | Node · React · Python · Swift · Kotlin · Godot                         | `sdk`     | page-level picker on pages with `sdks:`; persisted, and in the URL `?sdk=` |
| Lane            | Drop-in UI kit · Your own UI                                           | `lane`    | tab set around app code; `?lane=kit\|library`                              |
| Package manager | npm · pnpm · Yarn · Bun / uv · pip · Poetry / SwiftPM / Gradle / Godot | `pm`      | install steps only                                                         |
| Surface         | Console · CLI · HTTP                                                   | `surface` | steps that can be done more than one way (Firebase's console-as-a-tab)     |

- Labels make sense on their own once flattened. A missing variant is an explicit panel, never a
  dropped tab. Storage access is wrapped in `try`/`catch`, and the page renders correctly without
  it.

**Install steps route the scope first.** Our SDKs and the CLI are published only on
`pkg.plrs.im`. A bare `npm i @polaris-key/cli` fails against `registry.npmjs.org`, and if someone
else ever held that scope there it would install their package. So every install step, in every
package-manager tab, first routes the `@polaris-key` scope (or the ecosystem's equivalent: an
explicit uv or pip index for `polaris-key`, never `--extra-index-url`; the SwiftPM registry
scope; a Gradle repository filtered to `im.plrs.key`; the Godot feed) and only then installs.
`<InstallSteps sdk="…" />` renders both halves from the CLI's own `feedsSetup()`
(`packages/cli/src/feedSetup.ts`), the function behind `pkey feeds setup`, so the docs and the CLI
print the same lines. No page shows an install command without its routing line.

**Where code comes from.** Two sources. No hand-written SDK fence survives the 0.9.x exit:

1. **Generated**: `<Generated feature="licensing" sdk lane part="usage" />` renders SP-33's
   `renderUsage(feature, lang, lane)`. Goldens compile in every SDK lane (SP-33b's acceptance).
   This needs one amendment (§10): SP-33a and SP-33b take a `lane` argument, and SP-33a also
   writes the docs blocks.
2. **Included**: `<Snippet src="…" region="gate" />` reads between `// docs:start gate` and
   `// docs:end gate` (`#` comments in Python and GDScript), shows the source file name under the
   block (Firebase's practice), and hides setup lines outside the region. Sources, in order:
   - the examples tree that SP-36 builds in CI (`examples/*`);
   - until SP-36 covers a snippet, a **docs-snippets test target inside each SDK**, compiled by
     that SDK's own CI lane: `packages/sdk-node/test/docs-snippets/` and
     `packages/sdk-react/test/docs-snippets/` (type-checked by the package's suite),
     `sdks/python/tests/docs_snippets/` (imported by pytest), `sdks/swift/Tests/DocsSnippetsTests/`
     (built by `swift test` on macOS), a `docsSnippets` source set in `sdks/kotlin/core` (compiled
     by the Kotlin lane, so `suspend` calls sit in a real coroutine scope), and
     `sdks/godot/tests/docs_snippets/` (parsed by headless Godot). DOC-08a creates them.

**Other code is validated.**

| Block                                                   | Check                                                                                                                                                                                                 | Package               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `.pkey/*` manifests                                     | `validateManifestDocuments` on every manifest fence (this would have caught the config-only example that fails `pkey validate`)                                                                       | DOC-07b               |
| `pkey …` commands                                       | The command and its flags exist in `packages/cli/src/help.ts`                                                                                                                                         | DOC-03a               |
| HTTP                                                    | Method and path exist in the OpenAPI spec                                                                                                                                                             | DOC-03a               |
| SDK names, manifest fields and CLI forms removed in 0.9 | A removed-names lint over every page, reading the changelog's `replaces` rows, `api.json`'s removed rows and the validator's removed-field codes. `build/upgrade-to-0-9` and the changelog are exempt | DOC-12a (on at SP-35) |

**Placeholders and keys.**

- **One example product: Tidewater Studio (`tidewater`)** (SP-36, SP-37). DJDL and Diceroll
  appear only on pages about them.
- **The best placeholder is none.** From SP-32, app code reads `polaris-key.json` (the file
  Integration hands out), so slugs, base URLs and pins never appear in snippets.
- **Before SP-32**, `pkey sdk --write` generates the config file, and the snippet imports it.
- **A value only the reader has** is an `<angle-bracket placeholder>`, styled dim. Its block has
  **no Copy button**, and its footer says where to get the value (the reviewed `docs-first-product`
  rule: "Copy the full command from your product's Integration page").
- **Secrets never appear**, not even fake ones. Tokens come from environment variables
  (`PKEY_CI_TOKEN` in CI) or `pkey login` (from ST-34). Key formats are shown as patterns only in
  reference (`pkey_…`, `pkeyp_…`, `pkeyci_…`), with a **Safe to share** column (Stripe's key
  table).
- **Signed-in personalisation** (P3): a member can pick their product, and snippets fill in its
  public slug. Never a secret.

---

## 5. Every current page: keep, rewrite, merge, new, delete

**Priority.**

- **P1**: must-have for 0.9.x. The page is correct about today's behaviour, sits in its target
  home, and follows its type.
- **P2**: written in the PR of the consolidation package named under "Waits for". It is an
  acceptance line on that package, and the page never runs ahead of it.
- **P3**: later.

**Who does what.** DOC-03a performs every move, split, merge and delete below mechanically, with
every redirect and the `nav.ts` and `docsLinks.ts` updates, before any writing starts:

- a **move** keeps the content;
- a **merge** appends the secondary page's body to the target under its own H2, so nothing leaves
  the site before a writer joins it;
- a **split** puts the whole old page at the first target and a stub at each other target;
- a **delete** redirects to the named target.

The **Package** column names who then writes the content. "Waits for" lists only the package the
page's next change needs. All paths are under `packages/docs/src/content/docs/`.

**Home and Start here**

| Current                  | Action             | Becomes                                                                                                                                                                                                                                                     | Pri     | Waits for                      | Package          |
| ------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------ | ---------------- |
| `index.mdx`              | rewrite            | the public landing page (§3.4). DOC-02b owns its layout component (`Landing.astro`), DOC-07a its copy                                                                                                                                                       | P1      | —                              | DOC-07a, DOC-02b |
| `start/index.md`         | rewrite            | Developers **Overview**: no install command, no counts, no "A1 identifier flip"                                                                                                                                                                             | P1      | —                              | DOC-07a          |
| `start/concepts.md`      | rewrite (glossary) | **Concepts and glossary**: ST-37's word table first; design rationale and ticket ids move to `contribute/`; trimmed from 6.1k words                                                                                                                         | P1      | ST-37 (in flight; merge first) | DOC-07a          |
| `start/quickstart.md`    | merge, delete      | `start/first-product.md`                                                                                                                                                                                                                                    | P1 → P2 | SP-37 (final form)             | DOC-07a          |
| `start/service-model.md` | split              | the features summary and **the one coherence-rule table** (code × `pkey validate` and ingest, the enablement API, severity; tested against both validators) → `start/how-it-works.md`; parser, migration 0033 and the guard → `contribute/service-model.md` | P1 → P2 | ST-38 (requirement rule)       | DOC-07a, DOC-12b |
| `start/architecture.md`  | move               | `contribute/architecture.md`, with the layout block fixed                                                                                                                                                                                                   | P1 → P2 | P0-17, P0-19                   | DOC-12b          |

**For users → Help** (every page rewritten into the public Help area; §7 has the full article list)

| Current                    | Action          | Becomes                                                                                                                                                   | Pri     | Waits for                    | Package          |
| -------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------- | ---------------- |
| `users/index.md`           | rewrite         | `help/index.md` (Help home); the note for people who support customers moves to Operate → Help a customer                                                 | P1      | —                            | DOC-04a          |
| `users/activation.md`      | rewrite         | `help/activate.md`                                                                                                                                        | P1 → P2 | LX-38, LX-39                 | DOC-04a          |
| `users/portal.md`          | rewrite (split) | `help/sign-in`, `help/account`, `help/delete-account` (DOC-04b); `help/library`, `help/add-a-license` (DOC-05b)                                           | P1      | —                            | DOC-04b, DOC-05b |
| `users/devices.md`         | rewrite (split) | `help/devices`, `help/new-computer`, `help/device-limit`                                                                                                  | P1      | —                            | DOC-05b          |
| `users/updates.md`         | rewrite         | `help/update`                                                                                                                                             | P1 → P2 | P2-08 (beta)                 | DOC-05c          |
| `users/downloads.md`       | keep (split)    | `help/download`, `help/check-a-download`, `help/install-sources`                                                                                          | P1      | —                            | DOC-05c          |
| `users/troubleshooting.md` | rewrite         | `help/messages/*`                                                                                                                                         | P1      | —                            | DOC-05a          |
| `users/privacy.mdx`        | rewrite, move   | `help/your-data` (plain). The `docs/PRIVACY.md` render moves to `reference/what-apps-collect.mdx`, after REVIEW-NOTES §4's errors are fixed in the source | P1      | D5 for `help/privacy-policy` | DOC-04b, DOC-12b |

**Build on it** (top level and manifest)

| Current                          | Action          | Becomes                                                                                                                                                                | Pri     | Waits for                  | Package |
| -------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------- | ------- |
| `build/index.md`                 | rewrite         | the Build map; no counts ("seven surfaces", "sixth SDK" go)                                                                                                            | P1      | —                          | DOC-07b |
| `build/api.md`                   | rewrite, move   | `reference/http-api.md`: base URL, auth, error shape, versioning, pagination; no "skeleton", no "wire contract v3"                                                     | P1      | —                          | DOC-12b |
| `build/ci.md`                    | move            | `features/ship-builds/ci.md`; Node ≥ 22.13                                                                                                                             | P1 → P2 | A-25 (`channels: auto`)    | DOC-10a |
| `build/install-from-feeds.md`    | keep, move      | `build/install.md`, **Install the SDKs and the CLI**: scope routing first in every tab, generated from `feedsSetup()`, then the CLI and SDK installs                   | P1 → P2 | F-33, F-37 (private feeds) | DOC-07a |
| `build/offline.md`               | merge           | `features/licensing/offline.md`                                                                                                                                        | P1      | —                          | DOC-09a |
| `build/onboarding.md`            | merge, delete   | general steps → `start/first-product.md`; option tables → SDK reference. The DJDL cutover log is dropped: git keeps it                                                 | P1      | —                          | DOC-07a |
| `build/pack-transports.md`       | move            | `features/ship-builds/packs/transports.md`                                                                                                                             | P1 → P2 | P4-33                      | DOC-10c |
| `build/registering.md`           | rewrite, move   | `build/manifest/register.md`, **Register a product from its repo** (`pkey init`, linking the GitHub App, resync); seed SQL → `contribute/setup.md`                     | P1      | —                          | DOC-07b |
| `build/web-cors.md`              | keep, move      | `build/web-apps.md`, reconciled with the React quickstart on cross-origin use                                                                                          | P1 → P2 | SP-40                      | DOC-08b |
| `build/manifest/index.md`        | keep            | fix counts; link the one coherence-rule table                                                                                                                          | P1 → P2 | each field removal         | DOC-07b |
| `build/manifest/authoring.md`    | rewrite (split) | `manifest/product`, `manifest/catalog`, `manifest/release` (7.6k words, split by H2); "Deprecated spellings" removed (validation reference and the upgrade guide only) | P1 → P2 | each field removal         | DOC-07b |
| `build/manifest/distribution.md` | keep            | the short form                                                                                                                                                         | P1 → P2 | A-19, A-20                 | DOC-10b |
| `build/manifest/json-schema.md`  | keep            | **Set up your editor**                                                                                                                                                 | P1      | —                          | DOC-07b |

**Quickstarts and SDK reference**

| Current                                           | Action        | Becomes                                                                                                                 | Pri     | Waits for                      | Package |
| ------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------ | ------- |
| `build/quickstart/index.md`                       | merge, delete | `start/first-product.md`                                                                                                | P1      | —                              | DOC-07a |
| `build/quickstart/node.md`                        | rewrite       | both lanes (client, terminal kit); Node ≥ 22.13                                                                         | P1 → P2 | SP-33b (generated), SP-32a     | DOC-08a |
| `build/quickstart/react.md`                       | rewrite       | both lanes (hooks, `LicenseGate`); the cookie note goes with SP-40                                                      | P1 → P2 | SP-33b, SP-32a, SP-40          | DOC-08a |
| `build/quickstart/python.md`                      | rewrite       | both lanes (client, terminal kit)                                                                                       | P1 → P2 | SP-33b, SP-32a                 | DOC-08a |
| `build/quickstart/swift.md`                       | rewrite       | both lanes (`PolarisKey`, `PolarisKeyUI`)                                                                               | P1 → P2 | SP-33b, SP-32b                 | DOC-08a |
| `build/quickstart/kotlin.md`                      | rewrite       | both lanes; the Gradle dependency; the `suspend` calls in a coroutine scope (today's snippet does not compile)          | P1 → P2 | SP-33b, SP-32b                 | DOC-08a |
| `build/quickstart/godot.md`                       | rewrite       | both lanes (autoload, boot UI)                                                                                          | P1 → P2 | SP-33b, SP-32b                 | DOC-08a |
| `build/sdks/index.md`                             | rewrite       | the SDK table, plus the sub-client and verb table generated from parity (today's says "Distribution has no sub-client") | P1 → P2 | SP-35 (`api-names`)            | DOC-08a |
| `build/sdks/{node,react,python,swift,kotlin}.mdx` | keep          | README renders                                                                                                          | P1 → P2 | SP-37 (READMEs reference-only) | DOC-08a |
| `build/sdks/godot.mdx`                            | keep          | README render (15k words); split by H2                                                                                  | P2 → P3 | SP-37                          | DOC-08a |

**Recipes**

| Current                                | Action        | Becomes                                                                     | Pri     | Waits for    | Package |
| -------------------------------------- | ------------- | --------------------------------------------------------------------------- | ------- | ------------ | ------- |
| `build/recipes/index.md`               | delete        | redirect to `features/` (recipes live with their feature)                   | P1      | —            | DOC-03a |
| `build/recipes/attestation.md`         | move          | `features/licensing/attestation.md`                                         | P1      | —            | DOC-09a |
| `build/recipes/crash-tags.md`          | move          | `features/managed-config/crash-tags.md`                                     | P1      | —            | DOC-09c |
| `build/recipes/device-limit.md`        | move, rewrite | `features/licensing/device-limit.md`, in lanes; "SDK parity pass §3.1" goes | P1 → P2 | I-10a, I-10b | DOC-09a |
| `build/recipes/server-verification.md` | move          | `features/licensing/server-verification.md` (**Verify on your server**)     | P1      | —            | DOC-09a |
| `build/recipes/store-outlets.md`       | merge         | `features/ship-builds/channels/index.md` (its decision table)               | P1 → P2 | A-19         | DOC-10b |

**Drop-in UI kits** (`build/ui/`)

| Current                                                                                                                                                                                                                                                  | Action             | Becomes                                                                                                                                                                                                                                        | Pri     | Waits for            | Package |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------- | ------- |
| `build/ui/index.mdx`                                                                                                                                                                                                                                     | rewrite            | **Drop-in UI kits**: the kit lane's home. The kit table is trimmed to the must tier, with recipes and parked kits as rows. No symbol that does not ship (`<PolarisKeyGate>`, `<pk-gate>`, `run_gate` are rows marked not built yet, not prose) | P1      | —                    | DOC-08b |
| `build/ui/theming.mdx`                                                                                                                                                                                                                                   | keep               | present tense only                                                                                                                                                                                                                             | P1 → P2 | HA-13, HA-14         | DOC-08b |
| `build/ui/localisation.mdx`                                                                                                                                                                                                                              | keep, rename       | `build/ui/localization.mdx` (US spelling; redirect)                                                                                                                                                                                            | P1      | —                    | DOC-08b |
| `build/ui/recipes.mdx`                                                                                                                                                                                                                                   | delete             | redirect to `build/ui/frameworks/`, where recipe kits are rows; UK-31 adds a page when a recipe ships                                                                                                                                          | P1      | —                    | DOC-08b |
| `build/ui/components/index.mdx`                                                                                                                                                                                                                          | keep               | a generated status table: every component × kit (shipped or not built yet), from `components.json` and `uiKits.ts`, including the components no kit ships                                                                                      | P1      | —                    | DOC-08b |
| `build/ui/components/{about, account-and-license, activate, boot, device-limit, devices, grace-banner, offline-activation, polaris-key-gate, release-notes, settings, sign-in-handoff, sign-in, status-screen, update-progress, update-prompt}.mdx` (16) | keep               | a per-kit badge (shipped or not built yet); a tab per kit as each ships                                                                                                                                                                        | P1 → P2 | UK-04 … UK-12, UK-41 | DOC-08b |
| `build/ui/components/{channel-picker, cloud-sync-status, entitlement-gate, license-choice, paywall, toast, welcome}.mdx` (7)                                                                                                                             | delete             | redirect to the components index, where each is a "Not built yet" row. The specs stay in `docs/design/UI-KITS.md` and `components.json`; each page returns with the kit package that ships it                                                  | P1      | —                    | DOC-08b |
| `build/ui/components/_template.mdx`, `build/ui/frameworks/_template.mdx`                                                                                                                                                                                 | keep (unpublished) | templates gain the badge, the lanes and the "states to handle" block                                                                                                                                                                           | P1      | —                    | DOC-08b |
| `build/ui/frameworks/index.mdx`                                                                                                                                                                                                                          | rewrite            | must tier, recipes, parked (owner decision 6)                                                                                                                                                                                                  | P1      | —                    | DOC-08b |
| `build/ui/frameworks/compose.mdx`                                                                                                                                                                                                                        | keep               | thin today (147 words)                                                                                                                                                                                                                         | P2      | UK-09, UK-10         | DOC-08b |
| `build/ui/frameworks/{terminal-node, terminal-python}.mdx`                                                                                                                                                                                               | keep               | —                                                                                                                                                                                                                                              | P1      | —                    | DOC-08b |

**Wire → Reference → Protocol** (for SDK porters; console members)

| Current                         | Action | Becomes                                                                                                            | Pri | Waits for | Package |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ | --- | --------- | ------- |
| `build/wire/index.md`           | move   | `reference/protocol/index.md`; "a fifth SDK" goes; summarises WIRE-CONTRACT-V4 rather than pointing at a repo file | P1  | —         | DOC-12b |
| `build/wire/envelope.md`        | move   | `reference/protocol/envelope.md`                                                                                   | P1  | —         | DOC-12b |
| `build/wire/trust.md`           | merge  | `reference/protocol/trust.md`, the one trust page (with `services/core/trust.md`)                                  | P1  | —         | DOC-12b |
| `build/wire/cache-and-clock.md` | move   | `reference/protocol/cache-and-clock.md`                                                                            | P1  | —         | DOC-12b |
| `build/wire/bundles.md`         | move   | `reference/protocol/bundles.md` (wire only; the how-to is `features/licensing/offline`)                            | P1  | —         | DOC-12b |
| `build/wire/packs.md`           | move   | `reference/protocol/packs.md`                                                                                      | P1  | —         | DOC-12b |
| `build/wire/corpus.md`          | merge  | `contribute/corpus.md`; `reference/protocol/corpus.mdx` stays generated                                            | P1  | —         | DOC-12b |

**Services → Features: Core**

| Current                             | Action | Becomes                                                               | Pri | Waits for | Package |
| ----------------------------------- | ------ | --------------------------------------------------------------------- | --- | --------- | ------- |
| `services/core/index.md`            | merge  | `start/how-it-works.md` (the route table is in `reference/routes`)    | P1  | —         | DOC-07a |
| `services/core/device-principal.md` | move   | `reference/protocol/device-principal.md`                              | P1  | —         | DOC-12b |
| `services/core/device-trust.md`     | move   | `features/licensing/device-trust.md`                                  | P1  | —         | DOC-09a |
| `services/core/discovery.md`        | move   | `reference/protocol/discovery.md`, with no counts                     | P1  | —         | DOC-12b |
| `services/core/errors.md`           | move   | `reference/protocol/errors.md` (error body shapes; links error codes) | P1  | —         | DOC-12b |
| `services/core/fingerprints.md`     | move   | `features/licensing/fingerprints.md`                                  | P1  | —         | DOC-09a |
| `services/core/trust.md`            | merge  | `reference/protocol/trust.md`                                         | P1  | —         | DOC-12b |

**Services → Features: Licensing** (`features/licensing/`)

| Current                           | Action  | Becomes                                                                          | Pri     | Waits for    | Package |
| --------------------------------- | ------- | -------------------------------------------------------------------------------- | ------- | ------------ | ------- |
| `services/license/index.md`       | rewrite | **Overview**: no counts; the claim-on-sign-in wording taken from `enrollment.md` | P1 → P2 | LX-33        | DOC-09a |
| `services/license/model.md`       | keep    | holder states, every license has a tier, limits                                  | P1 → P2 | LX-33        | DOC-09a |
| `services/license/activation.md`  | keep    | reference: the activation pipeline                                               | P1      | —            | DOC-09a |
| `services/license/enrollment.md`  | merge   | `features/licensing/access.md`; P1 keeps it, with the one correct claim wording  | P1 → P2 | LX-36, P2-10 | DOC-09a |
| `services/license/policy.md`      | merge   | `features/licensing/access.md`                                                   | P2      | LX-36, P2-10 | DOC-09a |
| `services/license/document.md`    | move    | `reference/protocol/license-document.md`                                         | P1      | —            | DOC-12b |
| `services/license/relicensing.md` | keep    | —                                                                                | P1      | —            | DOC-09a |

**Services → Features: Managed config, Cloud Sync, Sign-in**

| Current                                | Action          | Becomes                                                                                                                                                                                                                                                                                    | Pri     | Waits for                     | Package |
| -------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ----------------------------- | ------- |
| `services/config/index.md`             | rewrite         | `features/managed-config/index.md`; no counts; "D-08" goes                                                                                                                                                                                                                                 | P1 → P2 | U-30                          | DOC-09c |
| `services/config/catalog.md`           | keep            | —                                                                                                                                                                                                                                                                                          | P1 → P2 | U-30, U-31, LX-34             | DOC-09c |
| `services/config/document.md`          | move            | `reference/protocol/config-document.md`                                                                                                                                                                                                                                                    | P1      | —                             | DOC-12b |
| `services/config/edge-mint.md`         | keep → rename   | `minted-tokens.md`, renamed in the PR that changes the console word                                                                                                                                                                                                                        | P1 → P2 | U-31                          | DOC-09c |
| `services/config/management-states.md` | keep → rename   | `visibility.md` (Editable, Read-only, Hidden); P1 removes the cancelled U-03 run's "until the migration" wording                                                                                                                                                                           | P1 → P2 | U-30, U-27                    | DOC-09c |
| `services/config/profiles.md`          | keep            | the five-layer chain                                                                                                                                                                                                                                                                       | P1 → P2 | U-27, U-28, U-29              | DOC-09c |
| `services/sync/index.md`               | rewrite         | `features/cloud-sync/index.md`, **one page**: a status line (what works today: declarations validate, enablement, the console's Data page; nothing syncs yet). The rest of the skeleton (synced settings, saves, one conflict vocabulary, the quota entitlement) arrives with the packages | P1 → P2 | U-01b, U-05, U-10, U-22, U-23 | DOC-09c |
| `services/identity/index.md`           | rewrite         | `features/sign-in/index.md`: the Polaris Key account; "D-14 … out of scope" and the count go                                                                                                                                                                                               | P1 → P2 | I-29, I-30, I-19              | DOC-09b |
| `services/identity/oidc.md`            | keep → rename   | `connections.md`                                                                                                                                                                                                                                                                           | P1 → P2 | I-30, I-31, I-32              | DOC-09b |
| `services/identity/device-flow.md`     | keep            | —                                                                                                                                                                                                                                                                                          | P1      | —                             | DOC-09b |
| `services/identity/sessions.md`        | keep            | —                                                                                                                                                                                                                                                                                          | P1 → P2 | SP-40                         | DOC-09b |
| `services/identity/portal.md`          | rewrite (split) | `features/sign-in/customer-portal.md` (what customers see, and the settings that change it) plus `reference/portal-api.md` (8.9k words today)                                                                                                                                              | P1 → P2 | I-29                          | DOC-09b |

**Services → Features: Ship builds** (`features/ship-builds/{releases,channels,updates,packages,packs}/`)

| Current                                      | Action          | Becomes                                                                                                                                                                   | Pri     | Waits for              | Package |
| -------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------- | ------- |
| `services/release/index.md`                  | rewrite         | `releases/index.md`. The example enables release, distribution and update (today's fails `update_requires_distribution`); the legacy mapping and chain rule are corrected | P1      | —                      | DOC-10a |
| `services/release/github-sync.md`            | keep            | —                                                                                                                                                                         | P1      | —                      | DOC-10a |
| `services/release/truth-store.md`            | move            | `contribute/release-truth-store.md`                                                                                                                                       | P1      | —                      | DOC-12b |
| `services/release/artifacts.md`              | keep            | —                                                                                                                                                                         | P1      | —                      | DOC-10a |
| `services/release/channels.md`               | keep → rename   | `releases/release-tracks.md`                                                                                                                                              | P1 → P2 | P2-08, P2-09           | DOC-10a |
| `services/release/packs.md`                  | rewrite (split) | `packs/index` (concept) and `packs/ship-a-pack` (how-to); byte formats → `reference/protocol/packs` (7k words today)                                                      | P1 → P2 | P4-33, P4-34           | DOC-10c |
| `services/release/compatibility.md`          | keep            | —                                                                                                                                                                         | P1      | —                      | DOC-10a |
| `services/distribution/index.md`             | keep            | `channels/index.md`, with store-outlets' decision table                                                                                                                   | P1 → P2 | A-19, A-22             | DOC-10b |
| `services/distribution/delivery.md`          | keep            | —                                                                                                                                                                         | P1      | —                      | DOC-10b |
| `services/distribution/rollouts.md`          | keep            | —                                                                                                                                                                         | P1 → P2 | A-24                   | DOC-10b |
| `services/distribution/availability.md`      | keep            | —                                                                                                                                                                         | P1 → P2 | A-20                   | DOC-10b |
| `services/distribution/app-store-connect.md` | merge (target)  | `channels/app-store.md`, with `admin/app-store.md`; rewritten in place as the channel page                                                                                | P1 → P2 | A-22, CM-21            | DOC-10b |
| `services/distribution/google-play.md`       | keep            | `channels/google-play.md`                                                                                                                                                 | P1 → P2 | A-22                   | DOC-10b |
| `services/distribution/microsoft-store.md`   | keep            | `channels/microsoft-store.md`                                                                                                                                             | P1 → P2 | A-22                   | DOC-10b |
| `services/distribution/steam.md`             | keep            | `channels/steam.md`                                                                                                                                                       | P1 → P2 | A-22                   | DOC-10b |
| `services/distribution/feeds.md`             | keep            | `channels/install-sources.md`, renamed with ST-37's word                                                                                                                  | P1      | ST-37                  | DOC-10b |
| `services/distribution/update-health.md`     | keep            | —                                                                                                                                                                         | P1      | —                      | DOC-10b |
| `services/distribution/commerce.md`          | keep → move     | `features/ship-builds/commerce.md` until CM-29, which moves it to `features/commerce/index.md` in its own PR                                                              | P2      | CM-29, CM-20 … CM-28   | DOC-10b |
| `services/distribution/package-feeds.md`     | rewrite (split) | `packages/index` (concept) and `packages/publish` (how-to); duplicates with `admin/feeds` and `contribute/package-feeds` removed (5.4k words today)                       | P1 → P2 | F-33, F-34, F-36, F-37 | DOC-10c |
| `services/update/index.md`                   | keep            | `updates/index.md`                                                                                                                                                        | P1 → P2 | P2-11, P2-12           | DOC-10a |
| `services/update/signed-feed.md`             | keep            | concept                                                                                                                                                                   | P1      | —                      | DOC-10a |
| `services/update/updater-feeds.md`           | keep            | —                                                                                                                                                                         | P1 → P2 | P2-11                  | DOC-10a |
| `services/update/appcast.md`                 | keep            | given a sidebar order                                                                                                                                                     | P1      | —                      | DOC-10a |
| `services/update/eligibility.md`             | keep            | given a sidebar order                                                                                                                                                     | P1      | —                      | DOC-10a |
| `services/update/godot-desktop.md`           | keep            | **Set up updates in a Godot desktop game**                                                                                                                                | P1      | —                      | DOC-10a |
| `services/update/sparkle.md`                 | keep            | **Set up Sparkle on macOS**; the copy in onboarding §6 removed                                                                                                            | P1      | —                      | DOC-10a |

**Administer → Operate, or the feature that owns the screen** (the door rule, §3.1). The
distribution console pages move **once**, to the path their final page keeps; the package that
changes the screen rewrites them in place.

| Current                           | Action              | Becomes                                                                                                                                                                                    | Pri     | Waits for                  | Package |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | -------------------------- | ------- |
| `admin/index.md`                  | rewrite             | `operate/index.md`; the page list is generated from the directory (today it lists 13 of 21)                                                                                                | P1      | —                          | DOC-11a |
| `admin/console-tour.md`           | rewrite (generated) | `operate/console/tour.mdx`, generated from `nav.ts` `SECTIONS` with a freshness test                                                                                                       | P1 → P2 | ST-44, ST-45 (regenerates) | DOC-11a |
| `admin/products.md`               | rewrite             | `operate/console/products.md`, **Create and set up a product**: the console reference for the product's Settings and Services; links Your first product for the steps; rationale moved out | P1 → P2 | ST-38, ST-42, ST-43        | DOC-11a |
| `admin/services-enablement.md`    | merge               | `operate/console/products.md`                                                                                                                                                              | P1      | —                          | DOC-11a |
| `admin/licenses-and-devices.md`   | move, fix           | `features/licensing/manage-licenses.md`: Batches and Settings added; "three pages" fixed                                                                                                   | P1 → P2 | LX-33 …                    | DOC-09a |
| `admin/users.md`                  | move                | `operate/console/users.md`                                                                                                                                                                 | P1      | —                          | DOC-11a |
| `admin/presentation.md`           | move                | `operate/console/presentation.md`                                                                                                                                                          | P1      | —                          | DOC-11a |
| `admin/secrets-and-keys.md`       | move, fix           | `operate/console/keys-and-secrets.md`; the intro's contradiction fixed                                                                                                                     | P1 → P2 | P0-28                      | DOC-11a |
| `admin/kek.mdx`                   | rewrite             | `operate/platform/runbook/`. `RUNBOOK.md` is rendered **by H2 section** (`<RunbookSection>`), one page each; the source file stays whole                                                   | P1      | —                          | DOC-11b |
| `admin/deploy.mdx`                | move                | `operate/platform/deploy.mdx`                                                                                                                                                              | P1 → P3 | (split by section later)   | DOC-11b |
| `admin/bundles.md`                | merge               | `features/licensing/offline.md`                                                                                                                                                            | P1      | —                          | DOC-09a |
| `admin/activity.md`               | move                | `operate/console/activity.md`                                                                                                                                                              | P1      | —                          | DOC-11a |
| `admin/security-pointers.md`      | move, fix           | `operate/platform/security.md`; points at V4, and "this section is last" goes                                                                                                              | P1      | —                          | DOC-11b |
| `admin/platform-settings.md`      | move                | `operate/platform/settings.md`                                                                                                                                                             | P1 → P2 | ST-09                      | DOC-11b |
| `admin/operations.md`             | move                | `operate/platform/jobs.md`                                                                                                                                                                 | P1      | —                          | DOC-11b |
| `admin/distribution-matrix.md`    | merge               | `features/ship-builds/channels/index.md`, as the section "The channel matrix"; A-21 rewrites the section when it retires the screen                                                        | P1 → P2 | A-21                       | DOC-10b |
| `admin/storefronts.md`            | move                | `features/ship-builds/channels/storefronts.md`; rewritten in place at A-21 and A-22, and moved with Commerce at CM-29                                                                      | P1 → P2 | A-21, A-22, CM-29          | DOC-10b |
| `admin/store-connections.md`      | move                | `operate/platform/connections.md`, titled "Store connections" until I-31 renames the screen                                                                                                | P1 → P2 | P0-28, I-31                | DOC-11b |
| `admin/app-store.md`              | merge               | `features/ship-builds/channels/app-store.md` (with `app-store-connect.md`)                                                                                                                 | P1 → P2 | A-22                       | DOC-10b |
| `admin/polaris-key-storefront.md` | move                | `features/ship-builds/channels/polaris-key.md`, the Polaris Key channel page; its Sales section is rewritten at PS-12 and A-22                                                             | P1 → P2 | PS-12, A-22                | DOC-10b |
| `admin/storefront-listing.md`     | merge               | `features/ship-builds/channels/polaris-key.md#listing`; rewritten at A-27                                                                                                                  | P1 → P2 | A-27                       | DOC-10b |
| `admin/feeds.md`                  | merge               | `features/ship-builds/packages/index.md`, duplicates removed                                                                                                                               | P1 → P2 | F-34                       | DOC-10c |

**For AI agents, Reference, Contribute**

| Current                                                  | Action              | Becomes                                                                                                                                                                            | Pri     | Waits for              | Package |
| -------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------- | ------- |
| `agents/index.md`                                        | move, fix           | `contribute/agents/index.md`; the "twenty-line" claim goes                                                                                                                         | P1      | —                      | DOC-12b |
| `agents/recipes.md`                                      | move                | `contribute/agents/recipes.md`                                                                                                                                                     | P1 → P2 | ST-34 (cookie recipes) | DOC-12b |
| `agents/conventions.md`                                  | move                | `contribute/agents/conventions.md`                                                                                                                                                 | P1      | —                      | DOC-12b |
| `reference/index.md`                                     | rewrite             | what each page is generated from; the Protocol section                                                                                                                             | P1      | —                      | DOC-12b |
| `reference/config-entry.mdx`                             | keep (generated)    | —                                                                                                                                                                                  | P1 → P2 | U-30                   | DOC-12a |
| `reference/corpus.mdx`                                   | move                | the generator's output goes to `reference/protocol/corpus.mdx`                                                                                                                     | P1      | —                      | DOC-12b |
| `reference/data-model.mdx`                               | move                | `contribute/data-model.mdx` (admin tier)                                                                                                                                           | P1      | —                      | DOC-12b |
| `reference/error-codes.mdx`                              | rewrite (generator) | each code gets what the person sees (copy title), meaning, HTTP status, retry, fix, its Help link and a link to Troubleshoot your integration where it applies; plan references go | P1 → P2 | SP-35 (SDK error type) | DOC-12a |
| `reference/fingerprint-constants.mdx`                    | move                | `reference/protocol/fingerprint-constants.mdx`                                                                                                                                     | P1      | —                      | DOC-12b |
| `reference/parity.mdx`                                   | keep                | —                                                                                                                                                                                  | P1      | —                      | DOC-12a |
| `reference/routes.mdx`                                   | keep                | programme ids removed from the OpenAPI descriptions (lint)                                                                                                                         | P1      | —                      | DOC-12a |
| `reference/settings.mdx`                                 | keep                | —                                                                                                                                                                                  | P1 → P2 | ST-09, LX-40           | DOC-12a |
| `reference/validation-codes.mdx`                         | keep                | each removed field's error names its replacement                                                                                                                                   | P1 → P2 | each removal           | DOC-12a |
| `contribute/{index, setup, layout, waves, releasing}.md` | keep                | `setup` gains the seed generator; `index` lists the moved internals                                                                                                                | P1      | —                      | DOC-12b |
| `contribute/corpus.md`                                   | keep (merge target) | absorbs `build/wire/corpus.md`; 22 internal refs trimmed                                                                                                                           | P1      | —                      | DOC-12b |
| `contribute/package-feeds.md`                            | keep                | duplicates with the feature page removed                                                                                                                                           | P1      | —                      | DOC-12b |

**New pages** (P1 unless marked). Help articles are listed in §7.1. DOC-03a creates a hidden stub
for each P1 page, carrying its planned anchors, so links across packages resolve from day one.

| New page                                                                                                                                                                                                                                                                                                                                            | Type                      | Pri     | Waits for                                  | Package                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------- | ------------------------------------------ | ---------------------------------- |
| `start/first-product.md`                                                                                                                                                                                                                                                                                                                            | quickstart                | P1 → P2 | SP-37, ST-43, SP-33b                       | DOC-07a                            |
| `start/choose-your-integration.md`                                                                                                                                                                                                                                                                                                                  | overview (decision table) | P1      | —                                          | DOC-07a                            |
| `start/how-it-works.md` (with the coherence-rule table)                                                                                                                                                                                                                                                                                             | concept                   | P1      | —                                          | DOC-07a                            |
| `access.md` (`/docs/access/`, public): who the gated docs are for, **Sign in**, **Go to Help**                                                                                                                                                                                                                                                      | overview                  | P1      | —                                          | DOC-03b                            |
| `build/test-your-integration.md`: test licenses, offline and grace, clock, `pkey doctor`                                                                                                                                                                                                                                                            | how-to                    | P1 → P2 | SP-36 (replay server), SP-32a (`doctor()`) | DOC-07b                            |
| `build/troubleshooting.md`, **Troubleshoot your integration** (§3.5)                                                                                                                                                                                                                                                                                | troubleshooting           | P1      | —                                          | DOC-07b                            |
| `build/go-live.md`: pins, signing, CI, Verified per platform, the support URL set in Presentation (so Help routes customers to you)                                                                                                                                                                                                                 | how-to                    | P1      | —                                          | DOC-07b                            |
| `build/upgrade-to-0-9.md`, **Upgrade to 0.9** (§3.5); its table fills as each removal lands                                                                                                                                                                                                                                                         | how-to                    | P1      | each removal (§10)                         | DOC-12a                            |
| `build/integration.md`, **The Integration page**: what Verified means and what earns it                                                                                                                                                                                                                                                             | how-to                    | P2      | ST-40, ST-41                               | (package)                          |
| `features/<each>/add-<feature>.md` for licensing, managed config, sign-in                                                                                                                                                                                                                                                                           | how-to (lanes)            | P1 → P2 | SP-33a/b (generated)                       | DOC-09a, DOC-09c, DOC-09b          |
| `features/ship-builds/index.md`                                                                                                                                                                                                                                                                                                                     | overview                  | P1      | —                                          | DOC-10a                            |
| `features/{licensing, sign-in, managed-config, ship-builds}/troubleshooting.md`                                                                                                                                                                                                                                                                     | troubleshooting           | P1      | —                                          | DOC-09a, DOC-09b, DOC-09c, DOC-10a |
| `features/licensing/{entitlements, add-ons, durations}.md`                                                                                                                                                                                                                                                                                          | concept and how-to        | P2      | LX-34, LX-35, LX-41, LX-43                 | (package)                          |
| `features/commerce/{index, offers-and-skus, purchases-and-refunds, storefronts}.md`                                                                                                                                                                                                                                                                 | mixed                     | P2      | CM-29, CM-20 … CM-28, A-33                 | (package)                          |
| `features/cloud-sync/{sync-settings, saves, troubleshooting}.md`                                                                                                                                                                                                                                                                                    | how-to                    | P2      | U-05, U-22                                 | (package)                          |
| `operate/console/help-a-customer.md`: a lost key, changed hardware, a refund or revoke, duplicate accounts, a transfer, **an activation file for a computer without internet**, **a compromised account**, erasure; a data export at I-11. Each task is 2–4 lines that link the feature how-to for the steps and the Help article the customer sees | how-to                    | P1      | I-11 (export task)                         | DOC-11a                            |
| `operate/console/members.md` (generated roles matrix)                                                                                                                                                                                                                                                                                               | how-to and reference      | P2      | ST-35                                      | (package)                          |
| `operate/platform/incidents.md`: products 404, KEK, a store connector failing, a rollout halted, a stale feed, email down                                                                                                                                                                                                                           | overview                  | P1      | —                                          | DOC-11b                            |
| `operate/platform/email.md`: sending domain, Apple private relay, limits, "We can't send email right now"                                                                                                                                                                                                                                           | runbook                   | P1      | —                                          | DOC-11b                            |
| `reference/cli.mdx` (generated from `help.ts`: every command, including `doctor` and `completion`, which no page mentions today)                                                                                                                                                                                                                    | reference                 | P1      | —                                          | DOC-12a                            |
| `reference/github-action.mdx` (generated from `actions/publish/action.yml`)                                                                                                                                                                                                                                                                         | reference                 | P1      | —                                          | DOC-12a                            |
| `reference/compatibility.md`: `PROTOCOL_VERSION` 4, SDK floors (Node ≥ 22.13, Python 3.9, Swift 6 …), `^0.8` → `^0.9`                                                                                                                                                                                                                               | reference                 | P1      | —                                          | DOC-12a                            |
| `reference/changelog/` (developer changelog collection, global, per feature and per SDK; the 0.9.0 break list)                                                                                                                                                                                                                                      | reference                 | P1      | —                                          | DOC-12a                            |
| `reference/what-apps-collect.mdx` (renders `docs/PRIVACY.md`)                                                                                                                                                                                                                                                                                       | reference                 | P1      | —                                          | DOC-12b                            |
| `reference/{api-names, channels, roles}.mdx` (generated)                                                                                                                                                                                                                                                                                            | reference                 | P2      | SP-35, A-19, ST-35                         | (package)                          |
| `reference/limits.md` (rendered from the settings registry)                                                                                                                                                                                                                                                                                         | reference                 | P3      | —                                          | —                                  |
| `contribute/writing-docs.md` (publishes `style-guide.md`)                                                                                                                                                                                                                                                                                           | reference                 | P1      | —                                          | DOC-12b                            |
| `start/ai-agents.md`                                                                                                                                                                                                                                                                                                                                | how-to                    | P3      | D2                                         | —                                  |

---

## 6. Work packages

### 6.1 Batches, packages and order

Twelve batches of related work, split into 28 packages. Each package is one engineering concern
or about ten pages of writing; the mechanical moves are all DOC-03a's, so no writing package
carries them. Each has one id, registered by the lead under existing phases. Suggested: ST for
DOC-02, DOC-03 and DOC-11; PX for DOC-04 to DOC-06; SP for DOC-07, DOC-08 and DOC-12; the
feature phases for DOC-09 and DOC-10.

**Order.** DOC-03a lands first and ships the contracts every other package needs: every target
path (moved content or a hidden stub with its planned anchors), every redirect, the frontmatter
schema, the MDX components with their final props (unstyled), the `help-messages.json` schema and
id format, and every lint with its debt ledger. After it:

- every writing package (DOC-04, DOC-05 and DOC-07 to DOC-12) starts at once, against the unstyled
  components;
- DOC-02a restyles those components on the console's `ui/`; DOC-02b and DOC-02c follow;
- DOC-03b builds the public access, and its **public switch** waits for D4 and for the Help
  packages (DOC-04a, DOC-04b, DOC-05a, DOC-05b, DOC-05c) to have no stubs left;
- DOC-06a and DOC-06b follow the public switch, because they put live links in front of
  customers;
- DOC-12a's error-code **Help** column waits for DOC-05a's message map; the rest of DOC-12a does
  not.

DOC-01 starts when the mockups' spacing workflow on `program/dx-mockups` has ended.

| Package                                         | Scope and pages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Sources of truth                                                                                                                                                                                                                                               | Depends on                                                      | Done, beyond §6.3                                                                                                                                                                                                                                                                                       | Days      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **DOC-01 Docs mockups** (design)                | A **docs** area in the mockups (§8.4): 11 screens, both themes, desktop and phone. `sdk.docs-first-product`'s header and type scale updated to §8.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | the mockup kit (`dx-mockups/docs/design/mockups/kit/`); console and portal baselines; `products.integration`, `portal.library`, `sdk.docs-first-product`; EXPERIENCE.md §2–5; BRAND.md; `copy.en.json` for exact titles                                        | the mockups spacing workflow has ended                          | `shoot.mjs --area docs --check`; three review lenses recorded in `designReview`; the lead rebuilds the mockups page                                                                                                                                                                                     | 2–3       |
| **DOC-02a Shared components**                   | §8.2: `ui/theme.css` split out of the console's `styles.css`; `@astrojs/react` renders the static components; `ui/classes.ts` constants; Expressive Code themes and frame; the table wrapper; DOC-03a's MDX components restyled on these; components.md §7 and the BRAND.md §2 line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `packages/admin/src/{styles.css,ui/*,lib/highlight.ts}`; `packages/brand/css/*`, `tokens.json`; components.md; EXPERIENCE.md §3                                                                                                                                | DOC-03a; D7 (plan mode)                                         | console and portal baselines unchanged (the split is a pure move); a test renders each listed component in the docs build; `docs-classes.test.ts` (§8.5); syntax-role contrast ≥ 4.5:1 on the code ground                                                                                               | 2–3       |
| **DOC-02b Chrome**                              | §8.3's overrides: header, door sidebars and the collapse rule, footer, pager, theme key and motion, phone menu, ToC, 404, `Landing.astro`, Help density                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | approved DOC-01 mockups; `PortalShell.tsx`; console `Sidebar`; `components/theme.tsx`                                                                                                                                                                          | DOC-01 review, DOC-02a                                          | no horizontal scroll at 390 px; built shots beside the console and portal baselines (§8.5); `pnpm ui:lint --html` on the built pages                                                                                                                                                                    | 2–3       |
| **DOC-02c Search**                              | The ⌘K dialog on the Pagefind JS API: merged tier bundles, grouped by door, `?q=`, code jump, Help-only default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | console `CommandPalette`; DOC-03b's bundles                                                                                                                                                                                                                    | DOC-02a, DOC-03b                                                | keyboard-only test; a gated bundle is never fetched without a session                                                                                                                                                                                                                                   | 1.5–2     |
| **DOC-03a Skeleton and contracts**              | Door directories and the sidebar data (§3.2); `src/lib/features.ts`; every move, split, merge and delete in §5, with every redirect; stubs (`status: "stub"`: hidden from the sidebar, search and sitemap, planned anchors as headings, a one-line pointer to the nearest live page); `nav.ts` and `docsLinks.ts` targets per the door rule, plus `nav-docs-targets.test.ts`; the frontmatter schema; the MDX components with final props, unstyled (§8.3, `PortalShot` and `InstallSteps` included); the `help-messages.json` schema and id format (§7.1); the lints (type skeletons, programme ids, counts, future tense, Help words, `pkey` commands, HTTP paths) with `lint-debt.json`; anchors and frontmatter in the slug manifest; AGENTS.md rule 4 (product and app, style guide §4) and "Where docs live" | `astro.config.mjs`, `src/content.config.ts`, `scripts/*`, `services.test.ts`, `docsLinks.ts`, `nav.ts`, `docsLinks.test.ts`, `tools/services.json`; AGENTS.md                                                                                                  | —                                                               | a test walks §5 and finds a redirect for every old path; no page's text changes except merge appends; the lints run site-wide and today's hits are in the ledger; `docsLinks.test.ts` and `check:links` pass                                                                                            | 2–3       |
| **DOC-03b Public access**                       | `docs-access.json` with asset tiers; the tiered gate; `/docs/access/`; three Pagefind bundles; the `/help` alias (OpenAPI row, `routeCoverage`); `/docs/help/code/<id>/`; `help` reserved (D8); sitemap, robots, `noindex`; the tier rule and its chrome exception in `check:links`; a THREAT-MODEL row; rule 11 and C-51 text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `packages/worker/src/docs.ts`, the router, OpenAPI; `shared-manifest/src/productSlug.ts`, `product.schema.json`; the ST-29 and ST-35 scopes                                                                                                                    | DOC-03a. The public switch: D4, and the Help packages stub-free | worker tests: Help returns 200 with no session; a member page sends a sessionless reader to `/docs/access/`; gated bundles and gated-only assets are refused; the reserved-slug test row; `gen:check` for the schema copy; the lead's check that no product uses `help`; a security review before merge | 2–3       |
| **DOC-04a Help: get started**                   | `help/index`, `what-is-polaris-key`, `emails`, `activate`, `contact` (**Get help with an app**, the one home for who to contact)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | portal pages; `identity/portal/{notices,email}.ts`; `docs/legal/help.md` (a draft skeleton, checked claim by claim); PORTAL.md; `copy.en.json`                                                                                                                 | DOC-03a                                                         | every UI label matches a portal string; the plain-language critic pass                                                                                                                                                                                                                                  | 1.5       |
| **DOC-04b Help: sign-in and account**           | `sign-in`, `code-didnt-arrive`, `passkeys`, `approve-a-sign-in`, `secure-your-account`, `account`, `join-accounts`, `delete-account`, `your-data`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `components/signin/*`, `AccountPage.tsx`, `account/SessionsCard.tsx`; worker `identity/card/*`, `identity/passkeys/*`, `identity/portal/{selfService,notices}.ts`; `docs/PRIVACY.md`, REVIEW-NOTES.md; SIGN-IN.md                                              | DOC-03a                                                         | as DOC-04a; owner placeholders tracked on the owner-steps checklist                                                                                                                                                                                                                                     | 2         |
| **DOC-05a Help: messages**                      | `help-messages.json` filled; `<HelpMessage>` renders catalog titles and indexes the translated titles as aliases; `helpMessages.test.ts`; the message pages (§7.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `conformance/parity/copy.*.json`; the portal's `errors.ts`; `components.json`                                                                                                                                                                                  | DOC-03a                                                         | every catalog key and portal error is in exactly one entry or the developer-only list; titles render from the catalog                                                                                                                                                                                   | 2         |
| **DOC-05b Help: library and devices**           | `library`, `add-a-license`, `discover`, `lost-key`, `license-status`, `remove-from-library`, `devices`, `new-computer`, `device-limit`, `offline-activation`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | portal Library, Discover, Product, Devices, `ActivateDialog.tsx`, `FreeDevicePage.tsx`; the 90-day dormant release; `keyReissueEnabled`; the kits' offline-activation screens and baselines                                                                    | DOC-03a                                                         | the plain-language critic pass                                                                                                                                                                                                                                                                          | 2         |
| **DOC-05c Help: downloads, updates, purchases** | `download`, `check-a-download`, `install-sources`, `update`, `restore-purchase`, `refunds`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `portal/downloads.ts`; `distribution/page/render.ts`; store origins; the kits' update screens                                                                                                                                                                  | DOC-03a                                                         | as DOC-05b                                                                                                                                                                                                                                                                                              | 1.5       |
| **DOC-06a Portal entry points**                 | `portal/helpLinks.ts`: the footer, account menu, login card, the Need help? fallback, Activate refusals, the Devices card, empty states                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | PORTAL.md §3.2; SIGN-IN.md §3; EXPERIENCE.md §5.2; `PortalShell.tsx`, `AccountMenu.tsx`, `LoginCard.tsx`, `HelpCard.tsx`, `errors.ts`; P0-36, P0-38                                                                                                            | DOC-03b's public switch                                         | `helpLinks.test.ts` against the slug and anchor manifest; portal baselines regenerated in one commit, coordinated by the lead with P0-36 and P0-38                                                                                                                                                      | 1.5–2     |
| **DOC-06b Worker entry points**                 | Email footers and per-notice links (security notices also link **Secure your account**); the download page footer; the Worker's HTML pages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `notices.ts`, `render.ts`, `brandHtml.ts`                                                                                                                                                                                                                      | DOC-03b's public switch                                         | email template tests                                                                                                                                                                                                                                                                                    | 1.5       |
| **DOC-06c Kits' Get help** (P2)                 | `help.link` in every kit-copy locale; an `error.helpUrl` row in `api.json`; each kit renders it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | kit-copy; `api.json`; UI-KITS.md                                                                                                                                                                                                                               | SP-39, SP-35                                                    | every kit's baselines show the link; every SDK lane passes                                                                                                                                                                                                                                              | (package) |
| **DOC-07a Start path**                          | Landing copy (`index.mdx` content); `start/index`, `first-product` (interim), `choose-your-integration`, `how-it-works` (with the coherence-rule table), `concepts`; `build/install`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `packages/cli/src/{help,sdkConfig,feedSetup}.ts`; the console's New product, Services, Licenses and Devices pages; `shared-manifest` and `core/services.ts` (both validators, for the table); `engines` (≥ 22.13.0); `sdk.docs-first-product`; the SP-37 scope | DOC-03a; ST-37 for `concepts`                                   | the **fresh-reader run** (§6.2) on Node and Swift; install steps rendered from `feedsSetup()`                                                                                                                                                                                                           | 2–3       |
| **DOC-07b Build basics**                        | `build/index`, `test-your-integration`, `troubleshooting`, `go-live`; `build/manifest/{index,product,catalog,release,register,json-schema}`; the manifest-snippet test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | the manifest validator; `packages/cli/src/{help,index}.ts`; `build/registering.md`; `conformance/parity/errors.json`                                                                                                                                           | DOC-03a                                                         | every manifest fence passes `validateManifestDocuments`                                                                                                                                                                                                                                                 | 2–3       |
| **DOC-08a SDK quickstarts**                     | Both lanes in all six quickstarts; the docs-snippets targets in each SDK (§4); `build/sdks/*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `packages/sdk-node`, `packages/sdk-react`, `sdks/{python,swift,kotlin,godot}`; `examples/*`; `conformance/parity/features.json`                                                                                                                                | DOC-03a                                                         | no hand-written SDK fence remains; each snippet target compiles in its SDK lane; joins DOC-07a's fresh-reader run                                                                                                                                                                                       | 2–3       |
| **DOC-08b UI kits and web apps**                | `build/ui/**` trimmed (owner decision 6) with badges and the generated status table; `<StatesToHandle>` data (copy key and Help URL per state); `build/web-apps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `kit-copy/components.json`; UI-KITS.md; `src/lib/uiKits.ts`; `packages/sdk-react`                                                                                                                                                                              | DOC-03a                                                         | every kit claim has a shipped package or a badge; no page exists for a component no kit ships                                                                                                                                                                                                           | 2         |
| **DOC-09a Licensing**                           | `features/licensing/**`: overview, add-licensing, model, activation, access, relicensing, offline, device-trust, fingerprints, attestation, device-limit, server-verification, manage-licenses, troubleshooting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `packages/worker/src/{core/licensing,services/license}`; `shared-manifest`; `conformance/parity/errors.json`; `enrollment.md` as the claim truth                                                                                                               | DOC-03a                                                         | every "until", "planned" or "will" removed or carried as a status; the P2 lines handed to their packages                                                                                                                                                                                                | 2–3       |
| **DOC-09b Sign-in**                             | `features/sign-in/**`: overview, add-sign-in, connections, device-flow, sessions, customer-portal, troubleshooting; `reference/portal-api`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `services/identity/**`; the portal's sign-in                                                                                                                                                                                                                   | DOC-03a                                                         | as DOC-09a                                                                                                                                                                                                                                                                                              | 2         |
| **DOC-09c Managed config and Cloud Sync**       | `features/managed-config/**`: overview, add-config, catalog, edge-mint, management-states, profiles, crash-tags, troubleshooting; `features/cloud-sync/index`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `services/config`, `services/sync`; `shared-manifest`                                                                                                                                                                                                          | DOC-03a                                                         | Cloud Sync states what works and that nothing syncs                                                                                                                                                                                                                                                     | 2         |
| **DOC-10a Releases and updates**                | `features/ship-builds/index`, `ci`, `releases/*`, `updates/*`, `troubleshooting`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `services/{release,update}`; `packages/cli/src/publish.ts`; `actions/publish/action.yml`                                                                                                                                                                       | DOC-03a                                                         | the release example passes the validator                                                                                                                                                                                                                                                                | 2–3       |
| **DOC-10b Channels**                            | `channels/*` (index with the decision table and the matrix section, delivery, rollouts, availability, App Store, Google Play, Microsoft Store, Steam, install sources, update health, storefronts, Polaris Key with listing); `features/ship-builds/commerce` until CM-29; `build/manifest/distribution`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `services/distribution`; `packages/cli/src/{distribution,channels}.ts`, `storefronts/`; the store adapters                                                                                                                                                     | DOC-03a                                                         | no "outlet" in prose (the code word only, in code spans)                                                                                                                                                                                                                                                | 2–3       |
| **DOC-10c Packages and packs**                  | `packages/{index,publish}` (with `admin/feeds` merged); `packs/{index,ship-a-pack,transports}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `packages/cli/src/{feeds,feedSetup,packPublish,transport}*.ts`; the worker's feeds                                                                                                                                                                             | DOC-03a                                                         | the duplicates with `contribute/package-feeds` removed                                                                                                                                                                                                                                                  | 1.5       |
| **DOC-11a Operate: console**                    | `operate/index`; `console/tour` (generated from `SECTIONS`), `products`, `users`, `presentation`, `keys-and-secrets`, `activity`, `help-a-customer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `packages/admin/src/console/nav.ts`, `lib/docsLinks.ts`; the settings registry                                                                                                                                                                                 | DOC-03a                                                         | the tour generator's `--check`; a test that each console Docs target names its screen                                                                                                                                                                                                                   | 2–3       |
| **DOC-11b Operate: platform**                   | The runbook by section (`<RunbookSection>`), `deploy`, `incidents`, `email`, `security`, `settings`, `jobs`, `connections`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `docs/RUNBOOK.md`, `docs/DEPLOYMENT.md`; the worker's email configuration                                                                                                                                                                                      | DOC-03a                                                         | each runbook page has Verify and Roll back                                                                                                                                                                                                                                                              | 2         |
| **DOC-12a Generators**                          | Error codes (the Help column after DOC-05a); CLI; GitHub Action; the changelog collection and views with `replaces`; **Upgrade to 0.9** and its table; compatibility; validation codes, settings, parity, routes and config entry kept current; the removed-names lint (on at SP-35)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `scripts/gen-reference.mjs`; `conformance/parity/{errors,copy.en}.json`; OpenAPI; `help.ts`; `action.yml`; AGENTS.md rule 3; the P0-42 and SP-37 scopes                                                                                                        | DOC-03a; DOC-05a for the Help column                            | every new generator has `--check` and a byte-compare test                                                                                                                                                                                                                                               | 3         |
| **DOC-12b Reference and contribute**            | `reference/index`, `http-api`, `protocol/*`, `what-apps-collect`; `contribute/**` (architecture, service-model internals, release truth store, data model, corpus, agents, setup with the seed SQL); `writing-docs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | the moved pages' sources; WIRE-CONTRACT-V4; `shared-protocol/src/core.ts`                                                                                                                                                                                      | DOC-03a                                                         | protocol pages point at V4                                                                                                                                                                                                                                                                              | 2         |

**Sizing.** About 52–65 engineer-days. DOC-03a and DOC-01 start now. The critical path is
DOC-03a (2–3 days), then the Help packages (about 2), then DOC-03b's switch and DOC-06a and
DOC-06b (about 2): roughly 6–8 working days, or about three weeks of wall time with the lanes run
in parallel. P2 work rides each consolidation package.

### 6.2 The fresh-reader run

DOC-07a and DOC-08a share one check of the start path. A fresh subagent with no repo context
follows **Your first product** from an empty directory, on Node and on Swift (macOS), against a
local worker or staging. It records the elapsed time and every step the page didn't mention.

- The writers fix the page and run a second fresh reader until a run finishes with no unmentioned
  step.
- The measured time appears on the landing card and the quickstart intro only then. Without a
  measured run, they say no time at all.
- At SP-37, the final path gets the same run.

### 6.3 What every package must meet

Writers run as `pkey-implementer` with `style-guide.md` attached. Reviews:

- `pkey-wp-reviewer` on every package;
- `pkey-ux-reviewer` in built mode on rendered pages, both themes and phone, for DOC-02a/b/c,
  DOC-04a/b, DOC-05a/b/c and DOC-07a;
- for Help, a **plain-language critic**: a fresh subagent with no repo context, reading as someone
  who never chose Polaris Key, citing `page#anchor` for every finding.

The test budget applies: run only the docs tests while writing, and the scoped gate once at
hand-off.

**Common definition of done:**

1. `mise exec node@22 -- pnpm --filter @polaris-key/docs build` passes. The regenerated
   `packages/worker/src/docsCsp.generated.ts` and the slug manifest are committed.
2. `gen:check`, `test`, `lint` and `check:links` pass, including the tier rule.
   `packages/worker/test/docsLinks.test.ts` passes.
3. The package adds no redirect: DOC-03a made them all. A P2 package that moves a page adds its
   own redirect and updates `nav.ts` and `docsLinks.ts` in the same change.
4. The package's pages are off `lint-debt.json`, which only shrinks: type skeletons, programme
   ids, counts, future tense, Help's word list, `pkey` commands and HTTP paths.
5. No page the package owns is still a stub.
6. Every code block is generated, included from a compiled snippet target, or validated (§4).
7. Every behavioural claim is verified against code. For rewritten pages, the PR lists
   claim → file:line.
8. Nothing describes unbuilt behaviour as shipped. P2 items are handed over as acceptance lines on
   their packages (§10), not written ahead.

---

## 7. Consumer help

### 7.1 The articles (public, `/docs/help/`)

Status: **P1** is written now against shipped behaviour. **P2** is written in the named package's
PR. Who to contact has one home, **Get help with an app**; every other page gives it one sentence
and a link.

| Article (title in the reader's words)                  | Covers                                                                                                                                                                                                                                                          | Message ids                                                               | Portal screenshots (baseline states)                                                   | Pri · package                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Help home**                                          | Search; six top tasks; categories by job; one line on who to contact, linking **Get help with an app**                                                                                                                                                          | —                                                                         | —                                                                                      | P1 · DOC-04a                                     |
| **What is Polaris Key?**                               | The service the app's developer uses for licenses, sign-in and downloads. It doesn't sell you the app and can't refund it. Why its name appears in emails, receipts and the browser                                                                             | —                                                                         | —                                                                                      | P1 · DOC-04a                                     |
| **Emails from Polaris Key**                            | The real sender addresses; one anchor per notice kind (a new device signed in, a license moved or assigned, accounts joined or separated, your license has a new key…); spotting phishing                                                                       | one per notice kind                                                       | —                                                                                      | P1 · DOC-04a                                     |
| **Activate your app**                                  | Four branches: a key, sign in, a free app, bought in a store (restore). The app's own button labels                                                                                                                                                             | `activation.ok`                                                           | `activate-enter`, `activate-confirm`, `activate-done`                                  | P1 → P2 (LX-38, LX-39) · DOC-04a                 |
| **Get help with an app**                               | **Who to contact**: the app's developer (refunds, billing, app bugs), the store (store purchases), Polaris Key (your account, sign-in, privacy). The app's **Need help?** card first; what to include; never send your full key                                 | —                                                                         | `product` (the Need help? card)                                                        | P1 (address: D4) · DOC-04a                       |
| **Sign in to Polaris Key**                             | The email code or link, Google, Apple, Steam, passkeys; "Confirm it's you"                                                                                                                                                                                      | `step_up_required`                                                        | `signin`, `signin-providers`, `signin-sent`                                            | P1 · DOC-04b                                     |
| **Your sign-in code didn't arrive**                    | Spam folder, resend timing and limits (from the code), Hide My Email relays, the security check                                                                                                                                                                 | `email_unavailable`, `turnstile_failed`, `rate_limited`                   | `signin-rate-limited`                                                                  | P1 · DOC-04b                                     |
| **Use a passkey**                                      | Add, use, remove; the last-method guard                                                                                                                                                                                                                         | `last_link`                                                               | `account-last-method`                                                                  | P1 · DOC-04b                                     |
| **Approve a sign-in on another device**                | A code on a TV, console or terminal; "Didn't start this? Cancel it"                                                                                                                                                                                             | —                                                                         | —                                                                                      | P1 · DOC-04b                                     |
| **Secure your account**                                | For "Wasn't you?" in a security email: sign out where you don't recognize a session (**Where you're signed in**), remove a sign-in method you don't recognize, remove unknown devices from your apps, then add a passkey                                        | `step_up_required`                                                        | `account`, `account-disconnect`                                                        | P1 · DOC-04b                                     |
| **Sign in with your work account**                     | Typing your work email takes you to your organization's sign-in                                                                                                                                                                                                 | —                                                                         | —                                                                                      | P2 (I-30)                                        |
| **Your library**                                       | What appears by itself (**Automatic grant**, a purchase, a key); **What's New** (the app's update notes, as the portal labels it); "Bought an app but don't see it?"                                                                                            | —                                                                         | `library-3`, `library-empty`, `product`                                                | P1 → P2 (LX-38) · DOC-05b                        |
| **Add a license with a key**                           | The **Activate license** dialog; `/activate` links from emails and apps; each refusal, with its own anchor                                                                                                                                                      | `license_owned`, `email_mismatch`, `key_entry_limit`                      | `activate-enter`, `activate-error-owned`, `activate-error-email`, `activate-entries`   | P1 · DOC-05b                                     |
| **Get free apps from Discover**                        | Add a free app; storefront pages; agreeing to the app's terms                                                                                                                                                                                                   | `terms_required`                                                          | `discover`, `discover-added`, `storefront-page`                                        | P1 · DOC-05b                                     |
| **Find a lost license key**                            | Only the last 4 characters are shown; your receipt; **Get a new key** where the developer offers it; signing in instead of a key                                                                                                                                | —                                                                         | `product-origin-key`                                                                   | P1 · DOC-05b                                     |
| **What your license status means**                     | Active, Offline, Expired, Suspended, Signed out, Update required, in the words the app shows                                                                                                                                                                    | `gate.*`                                                                  | `product-expired`                                                                      | P1 → P2 (LX-41) · DOC-05b                        |
| **Remove an app from your library**                    | What happens to your devices first; then the steps. Synced data joins at U-22                                                                                                                                                                                   | `not_removable`                                                           | `library-entry-remove`, `product-remove-license`                                       | P1 · DOC-05b                                     |
| **Manage your devices**                                | See and remove devices; renaming happens in the app; devices unused for 90 days free up by themselves                                                                                                                                                           | `device_list_failed`, `device_deauthorize_failed`, `device_rename_failed` | `product-remove-device`                                                                | P1 · DOC-05b                                     |
| **Move your license to a new computer**                | Branches: the old computer is still here; it's gone; reinstalling the same computer; changed hardware. **Check it worked**, **Undo**                                                                                                                            | `hardware_mismatch`                                                       | `device-limit`, `device-limit-done`                                                    | P1 · DOC-05b                                     |
| **Device limit reached**                               | The exact on-screen title; **Replace a device** in the app; freeing a device in the portal                                                                                                                                                                      | `device_limit`, `activation.device-limit`                                 | `device-limit`                                                                         | P1 · DOC-05b                                     |
| **Activate a computer without internet**               | The app shows a request code (and a QR code); send it to the app's developer; open the activation file they send back. What each activation-file message means                                                                                                  | the activation-file messages                                              | the kits' offline-activation screens (`<KitBaselines>`, "Your app may look different") | P1 · DOC-05b                                     |
| **Download your app**                                  | Downloads in your library and the app's public download page; picking your platform                                                                                                                                                                             | `download_auth_required`, `delivery_gate_missing`                         | `download-flow`, `product-package`                                                     | P1 · DOC-05c                                     |
| **Check a download is genuine**                        | SHA-256 commands for each operating system; signing keys                                                                                                                                                                                                        | —                                                                         | —                                                                                      | P1 · DOC-05c                                     |
| **Install from AltStore, F-Droid, Obtainium or Scoop** | The current downloads page content, kept                                                                                                                                                                                                                        | —                                                                         | —                                                                                      | P1 · DOC-05c                                     |
| **Update your app**                                    | In-app updates; store apps update through their store; staged rollouts; "Can't update here"; a rollback                                                                                                                                                         | `swap-refused`, `swap-failed`                                             | —                                                                                      | P1 · DOC-05c                                     |
| **Get beta versions**                                  | Beta access comes with your license                                                                                                                                                                                                                             | `channel_not_allowed`                                                     | —                                                                                      | P2 (P2-08)                                       |
| **Install packages with a personal token**             | **Account → Packages**, the combined setup                                                                                                                                                                                                                      | —                                                                         | `product-token` (until F-33)                                                           | P2 (F-33)                                        |
| **Restore a purchase**                                 | App Store, Google Play, Steam: **Restore purchase** in the app; linking Steam                                                                                                                                                                                   | —                                                                         | `activate-error-steam`                                                                 | P1 → P2 (CM-22, CM-24) · DOC-05c                 |
| **Refunds, billing and cancellations**                 | Polaris Key takes no payment; what happens after a refund. Who to ask is one sentence and a link                                                                                                                                                                | —                                                                         | —                                                                                      | P1 → P2 (CM-22) · DOC-05c                        |
| **Subscriptions and renewals**                         | Trials, renewals, "keeps the last version"                                                                                                                                                                                                                      | —                                                                         | —                                                                                      | P2 (LX-41)                                       |
| **Your account and sign-in methods**                   | Profile, appearance, adding and removing methods, **Where you're signed in**                                                                                                                                                                                    | —                                                                         | `account`, `account-profile`, `account-disconnect`                                     | P1 → P2 (I-33) · DOC-04b                         |
| **Bought with a different email or on Steam?**         | Adding an email or Steam so purchases show up; joining accounts and undoing it                                                                                                                                                                                  | `email_in_use`, `link_conflict`                                           | —                                                                                      | P1 · DOC-04b                                     |
| **Delete your account**                                | **What happens when you delete it** first; the typed confirmation; what developers keep                                                                                                                                                                         | —                                                                         | `account-delete`                                                                       | P1 · DOC-04b                                     |
| **Your data and privacy**                              | What an app reads from your device (in plain words); what the developer sees (a per-app id; your email only if shared); asking for a copy of your data (write to Polaris Key support, D4, until I-11 builds an export); asking a developer to erase its records | —                                                                         | —                                                                                      | P1 (D4; D5 for the policy) → P2 (I-11) · DOC-04b |
| **Choose what apps can see**                           | **Connected apps**: change or disconnect                                                                                                                                                                                                                        | —                                                                         | —                                                                                      | P2 (I-34)                                        |
| **Sync your settings and saves**                       | What syncs and how to turn it on                                                                                                                                                                                                                                | —                                                                         | —                                                                                      | P2 (U-05, U-22)                                  |
| **Privacy policy**, **Terms**                          | `docs/legal/privacy.md`, `terms.md`                                                                                                                                                                                                                             | —                                                                         | —                                                                                      | owner sign-off (D5)                              |

**Message ids.** One id per catalog entry, fixed now because the anchors, the `/docs/help/code/`
redirector, the portal's `helpLinks.ts` and the kits' later `help.link` all depend on it:

- a `codes` key is its own id: `device_limit`, `license_owned`;
- a `gate` or `activation` key is prefixed with its group and a dot: `gate.expired`,
  `activation.device-limit`. This keeps the 11 activation keys that would otherwise collide with
  code keys once separators are normalized (`activation.device-limit` and `device_limit`,
  `unauthorized`, `rate-limited` and others) apart;
- the fallback is `fallback`.

The id is the anchor, set by `<HelpMessage>` itself (never slugified), and the redirect path:
`/docs/help/code/activation.device-limit/` → `/docs/help/messages/devices/#activation.device-limit`.
`help-messages.json` (DOC-03a's schema, DOC-05a's data) maps each id to its entry.

**Messages your app shows** (`help/messages/`). Each H2 is the catalog title verbatim, and the
anchor is the message id. One entry can carry several ids when the app shows the same title for
them, for example "Activation file not valid". One title with two different causes is one H2
with a branch per cause, each branch carrying its own id. Each page sits last in its task group
(§3.2).

| Page                                 | Task group            | Entries (catalog titles, quoted as shown)                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All messages, A to Z                 | Messages              | Generated index of every consumer-facing title → its anchor                                                                                                                                                                                                                                                                                                                                                                                 |
| Messages about signing in            | Sign in               | Sign in to continue · Sign-in expired · Sign-in failed · Sign-in declined · Sign-in cancelled · Sign-in unavailable · Sign-in method unavailable · Code expired · Wrong code · Check didn't pass · Too many attempts · Confirm it's you · Email sign-in unavailable · Terms not accepted                                                                                                                                                    |
| Messages about your license key      | Your library          | Key not accepted · License disabled · License no longer valid · Not activated · Activation refused · Activation failed · No free license · Couldn't get a free license · Registration closed · Offer unavailable                                                                                                                                                                                                                            |
| Messages about your license status   | Your library          | License expired · Offline grace · Signed out · Not signed in · Couldn't check your license (`sync-failed`) · Couldn't refresh · Offline mode · Update required · Not available on this license · Channel not included · Not included (the last four renamed with the catalog at P2-08)                                                                                                                                                      |
| Messages about devices               | Devices               | Device limit reached (→ its article) · Device changed · Device check failed · Device check needed · Device check unavailable · Couldn't load devices · Couldn't remove device · Couldn't rename · Activation file not valid · Activation file not trusted                                                                                                                                                                                   |
| Messages about downloads and updates | Downloads and updates | Sign in to download · Download unavailable · Download busy · Download corrupted · Download interrupted · Can't download here · Not enough space · Can't update here · Update not finished · Update not applied · Update check failed · Update not verified · the "Content…" titles for game packs                                                                                                                                           |
| Messages about accounts              | Account and privacy   | License in another account · Email not verified · No key entries left · Email already in use · Already linked · Can't remove (two causes: your last sign-in method, `last_link`; an app you can't remove, `not_removable`)                                                                                                                                                                                                                  |
| Other messages                       | Messages              | Connection: Can't connect · Connection problem · Timed out · Not available. Settings: Set by your organization · Settings unavailable · Value not accepted. Something went wrong, plus every **developer-only** code: App not set up, App build problem, App problem, Service problem, Service not set up, Unexpected answer, Request refused, Insecure connection… These say "The app's developer needs to fix this. Tell them this code." |

"Sign-in cancelled" is quoted as the catalog shows it, against the US spelling rule; DOC-05a
files a copy fix to "Sign-in canceled", and the Help title follows the catalog when it changes.

### 7.2 The voice

Style guide §3 is the one home for the Help voice. In short: the app is the hero, plain words
only, what happens before the steps, who can and can't help, the screen quoted exactly.

### 7.3 Screenshots

The rules are in style guide §9. The mechanism:

- **Portal screens** come only from the portal's committed visual baselines
  (`packages/admin/e2e/__baselines__/portal/linux/<state>-{desktop,mobile}-{dark,light}.png`).
  `<PortalShot state="…" />` imports them by a narrowed glob, the same pattern
  `src/lib/baselines.ts` uses for the kits. When the portal changes, its baselines change and the
  docs follow. Nothing is captured by hand or committed under `packages/docs`.
- **App screens** come from the kit baselines (`<KitBaselines>`).
- Each shot is a theme-swapped pair, with the phone capture below 640 px.

### 7.4 Deep links

All targets are registered and drift-gated: `helpLinks.ts` in the portal, `docsLinks.ts` in the
console. The kits and own-UI apps link through the message-id redirector.

| From                                                        | Link                                                                                                                                                     | Built by                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Portal footer and login card: **Help · Privacy · Terms**    | `/docs/help/` · `/docs/help/your-data/` (`privacy-policy` after D5) · `/docs/help/terms/` (after D5)                                                     | DOC-06a                             |
| Portal account menu **Help**                                | `/docs/help/`                                                                                                                                            | DOC-06a                             |
| Login card "Didn't get a code?"                             | `/docs/help/code-didnt-arrive/`                                                                                                                          | DOC-06a                             |
| Activate dialog refusals                                    | `/docs/help/add-a-license/#license_owned` and the other refusal anchors                                                                                  | DOC-06a                             |
| Devices card; the free-device flow                          | `/docs/help/devices/`, `/docs/help/new-computer/`                                                                                                        | DOC-06a                             |
| Library empty state "Bought an app but don't see it?"       | `/docs/help/join-accounts/`                                                                                                                              | DOC-06a                             |
| **Need help?** card when the developer gave no support link | `/docs/help/contact/`                                                                                                                                    | DOC-06a                             |
| Account → Your data → Delete                                | `/docs/help/delete-account/`                                                                                                                             | DOC-06a                             |
| Email footer                                                | `/docs/help/what-is-polaris-key/` and `/docs/help/emails/#<kind>`                                                                                        | DOC-06b                             |
| Security emails, beside "Wasn't you? Secure your account"   | `/docs/help/secure-your-account/`                                                                                                                        | DOC-06b                             |
| Download page footer                                        | `/docs/help/check-a-download/`, `/docs/help/`                                                                                                            | DOC-06b                             |
| Worker HTML pages (sign-in card twin, device approval)      | `/docs/help/`, `/docs/help/approve-a-sign-in/`                                                                                                           | DOC-06b (with P0-38)                |
| An app with its own UI                                      | `/docs/help/code/<id>/`, listed per state in **States to handle** (§3.6)                                                                                 | P1 (DOC-03b's redirect pages)       |
| **Get help** on kit error, gate and activation screens      | `<baseUrl>/help/code/<id>` → `/docs/help/code/<id>/` → the entry. Built from the SDK's base URL, so another deployment gets its own Help. No wire change | DOC-06c (P2), after SP-39 and SP-35 |

### 7.5 What keeps Help true

- **Every message is accounted for.** `helpMessages.test.ts` fails when a key in `copy.en.json`
  (`codes`, `gate`, `activation`, `fallback`) or in the portal's `errors.ts` is neither in exactly
  one Help entry nor in the developer-only list. A new code fails the build until someone writes
  it a home.
- **Titles render from the catalog.** `<HelpMessage id="device_limit" />` prints the catalog
  title and message, so a copy change cannot leave Help quoting old words. It also emits the
  title from every translated catalog (`conformance/parity/copy.<locale>.json`) as a search alias.
- **UI labels render from the catalog** once P0-36 puts the portal on it:
  `<UiLabel key="portal.activate.title" />`. Until then the reviewer checks them.
- **Screenshots** follow the baselines (§7.3). **Links** are gated (§7.4).

### 7.6 Later (P3)

- **Personalised header.** Help linked with `?app=<slug>` shows the app's name, developer and icon
  from discovery's public `core.presentation`, as display only: "Help for Tidewater Studio".
- **Translations.** The top 15 articles in the kit-copy locales, with `lang` carried in links.
- **"Was this helpful?"** This needs a feedback route (rule 10).

---

## 8. The docs site design: integrated into the Polaris Key brand

### 8.1 What "integrated" means here

The docs look like the third Polaris Key surface, not a re-skinned Starlight. The audit found the
tokens, fonts, surfaces and section accents already right. What is missing is the console and
portal's **components and chrome**:

- Starlight's header and sidebar;
- Night Owl syntax colours, including blue, which the brand bans;
- full-pill hero buttons;
- violet-on-violet tabs;
- uncontained tables;
- a white phone menu disc;
- the stock 404;
- a separate theme key.

Targets. Each names its console or portal source; §8.2 says how the docs use it.

| Part             | Target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header           | The portal's top bar (EXPERIENCE.md §5.2) for every door: the docs are pages, not a workspace. The compact lockup with a neutral **Docs** or **Help** tag; door tabs where the portal has Library and Discover; a search field like the console's "Search or jump to… ⌘K"; door links and the theme button on the right.                                                                                                                                                                  |
| Sidebar          | The console's `Sidebar` groups and items (EXPERIENCE.md §5.1, components.md §1.4), with only the active group open in Developers and Operate. Features carry their service glyphs. Every auto-generated group gets a real label.                                                                                                                                                                                                                                                          |
| Type             | Rubik at 400 and 700 only, on EXPERIENCE.md §3's shared steps through `PageHeader`: `title` (24 px) for page titles, `display` (40/30 px) for the landing and Help home; `section` for h2 and h3. Long-form prose is the one docs-only step: 15/24 on Developers and Operate (**compact**) and 16/26 on Help (**comfortable**), EXPERIENCE.md's "one kit, two voices", recorded in components.md §7. The reviewed `docs-first-product` scale (h1 36/44) is superseded; DOC-01 redraws it. |
| Tables           | The `DataTable`'s head, row and cell classes: compact density on reference pages, the default elsewhere; rows that wrap grow. Wide tables scroll inside their own container, with a fade.                                                                                                                                                                                                                                                                                                 |
| Colour and theme | Dark first with full light parity, all from `tokens.css`. **One theme choice across portal, console and docs**: the docs read and write `pk-admin-theme` (system, dark or light), which `components/theme.tsx` already shares between the portal and console. The console's reduced-motion choice is honoured.                                                                                                                                                                            |
| Section accents  | Kept. `data-service` from `tools/services.json` per feature. An eyebrow with marker on every page, not only service pages.                                                                                                                                                                                                                                                                                                                                                                |
| Footer           | The portal's line, "Polaris Key · key.plrs.im", plus door links (Help · Privacy · Terms on Help; Developer changelog · Console on Developers) and **Last reviewed** from frontmatter.                                                                                                                                                                                                                                                                                                     |

### 8.2 One source: the console's `ui/` (D7)

The docs do not get a third copy of the look. They use the components the console and portal
already share (`packages/admin/src/ui`, EXPERIENCE.md §3), so a change there reaches all three
surfaces.

1. **The utility layer moves next to the components.** The `@theme inline` block in
   `packages/admin/src/styles.css` (the pre-brand utility names, the font-weight remap,
   `--pk-admin-fill`, elevations, breakpoints) moves unchanged into `packages/admin/src/ui/theme.css`.
   `styles.css` imports it, and unchanged console and portal baselines prove the move is pure.
   The docs import it after `@polaris-key/brand`'s `tokens.css`, `fonts.css` and `theme.css`, and
   Tailwind in the docs gains `@source` for `packages/admin/src/ui`, so every utility those
   components use exists.
2. **Static components render at build time.** `@astrojs/react` renders them with no `client:`
   directive, so they ship no JavaScript: `Callout`, `StatusPill`, `Kbd`, `EmptyState`,
   `PageHeader`, `Section`, `ServiceBadge` and `ServiceGlyph`, `SignedBadge`. A test renders each
   one in the docs build. A component that needs the console's router, stores or query client is
   not rendered; its class constants are used instead, and P0-37 removes the dependency.
3. **Interactive parts share class constants.** The header, sidebar, tabs, SDK picker, search
   dialog, theme menu and pager are Astro markup with small CSP-hashed scripts. Their class
   strings come from constants the console components export and use themselves
   (`ui/classes.ts`: the top bar, sidebar group and item, tabs, `Button` variants and sizes,
   `CommandPalette` rows, `DataTable` head, row and cell). No docs file writes its own class
   string for a part the console has.
4. **Docs-only parts** (numbered steps, the pager, the lane cards, the SDK picker, the Requires
   row, the message entry frame) are built from tokens and the nearest constants. Each is listed
   in components.md §7 and drawn in DOC-01.
5. **Code.** Two Expressive Code themes take their colours from the console's `lib/highlight.ts`
   roles (keyword → info, string → success, number → warning, key → accent-fg, comment →
   fg-subtle, punctuation → fg-muted), so there is no blue and no new token. The frame matches
   `CodeBlock`: a header with the file or language label and **Copy** docked in it.
6. **What stays out.** `kit.css` holds the in-app kit measures and is used only inside kit
   previews. The mockup kit is for drawing (DOC-01) and is not extracted into a package.

| Docs part                                                                  | Console source                                                   | How                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| Admonitions: note, tip, caution (Help's **Important**), danger, signed     | `Callout` tones `info`, `success`, `warning`, `danger`, `signed` | rendered                                           |
| Requires chips, "Not built yet" rows, status words                         | `StatusPill`, `ServiceBadge`                                     | rendered                                           |
| Page title, eyebrow, lede                                                  | `PageHeader` (`default`; `display` on the landing and Help home) | rendered                                           |
| Cards: doors, features, next steps                                         | `Section`                                                        | rendered                                           |
| Keyboard hints                                                             | `Kbd`                                                            | rendered                                           |
| Not found                                                                  | `EmptyState` (`kind="not-found"`)                                | rendered                                           |
| Signature facts                                                            | `SignedBadge`                                                    | rendered                                           |
| Tables                                                                     | `DataTable` head, row and cell (compact on reference pages)      | class constants                                    |
| Tabs: lanes, package managers, surfaces                                    | the console's page tabs                                          | class constants                                    |
| Header                                                                     | the portal's top bar (`PortalShell`)                             | class constants                                    |
| Sidebar                                                                    | the console's `Sidebar` group and item                           | class constants                                    |
| Buttons and links styled as buttons (`ConsoleLink`, `PortalLink`)          | `Button`                                                         | class constants                                    |
| Search dialog                                                              | `CommandPalette`                                                 | class constants                                    |
| Code blocks                                                                | `CodeBlock` frame; `lib/highlight.ts` roles                      | Expressive Code themes                             |
| Numbered steps, pager, lane cards, SDK picker, Requires row, message entry | docs-only                                                        | tokens and the nearest constants; components.md §7 |

**Approval.** DOC-02a is a plan-mode package. It adds components.md §7 "The docs site" (what the
docs render, which constants they import, the docs-only parts and the prose step) and one line in
BRAND.md §2 naming the docs as the third consumer of `ui/`. The lead approves both before it
merges.

### 8.3 Starlight overrides and docs components

| Starlight component                        | Override                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Header.astro`                             | The portal's top bar: lockup and tag, door tabs (Developers and Operate only), search trigger, door links, theme button                                        |
| `SiteTitle.astro` (exists)                 | Adds the **Docs** or **Help** tag                                                                                                                              |
| `Search.astro`                             | Trigger plus a custom dialog on the Pagefind JS API (merged bundles, grouped by door, `?q=`), on the `CommandPalette` constants                                |
| `ThemeProvider.astro`, `ThemeSelect.astro` | The `pk-admin-theme` key; an icon menu (System · Dark · Light)                                                                                                 |
| `MobileMenuToggle.astro`                   | A 44 × 44 ghost icon button (today a white 32 px disc)                                                                                                         |
| `Sidebar.astro`                            | The door-scoped tree; the console's group and item constants; feature glyphs; the collapse rule                                                                |
| `PageFrame.astro` (exists)                 | Adds `data-door` and `data-density`; the Help frame                                                                                                            |
| `PageTitle.astro` (exists)                 | `PageHeader`: eyebrow on every page, `description` as the lede, a meta row (Requires chips, Last reviewed)                                                     |
| `Pagination.astro`                         | The docs-only pager: no shadow, a small label over the title                                                                                                   |
| `Footer.astro`                             | The brand footer (§8.1)                                                                                                                                        |
| `TableOfContents`, `MobileTableOfContents` | Restyled; off on short pages and on reference pages                                                                                                            |
| `Hero.astro`                               | Not used: the landing is `Landing.astro`                                                                                                                       |
| 404                                        | `disable404Route`; `src/pages/404.astro` on `<StarlightPage>` with `EmptyState`; forwards unknown `/help/code/<id>`                                            |
| Expressive Code                            | Brand themes (§8.2); every block has a header with its file or language label and **Copy** docked in it (never over code); terminal frames titled **Terminal** |
| Rehype                                     | Wraps every table in the table container with the `DataTable` classes; reference pages get a wide template (about 1,100 px) with no ToC                        |

Docs components, used in MDX. DOC-03a builds each with its final props, unstyled; DOC-02a
restyles them on §8.2's sources:

- `SdkPicker`, `Lanes`, `Generated`, `Snippet`, `InstallSteps`, `StatesToHandle` (§3.6, §4);
- `Steps`, `Callout`, `Pill`, `Status`, `FeatureCard` and `CardGrid`;
- `PortalShot` and `KitBaselines` (exists) (§7.3);
- `HelpMessage` and `UiLabel` (§7.5);
- `ConsoleLink`, a deep-link button that opens a console page ("Open Licenses ↗"), and
  `PortalLink`;
- `Requires` (feature chips, role, SDK minimum version);
- `RunbookSection`, which renders one H2 of a repo file.

### 8.4 Mockups: a new "docs" area

The area is added to `/Users/vlad/Repos/pk-wt/dx-mockups/docs/design/mockups/` (branch
`program/dx-mockups`) as the twelfth entry in `areas.json`, once that branch's spacing workflow
has ended: key `docs`, title "Docs site", accent `core`. Its blurb: "One docs site with three
doors (Help for people using an app, Developers, Operate), drawn in the console and portal's own
components". It follows the screen contract:

- Tidewater for developer screens;
- DJDL and Diceroll for consumer screens, the way the portal mockups use them;
- October 2026 dates;
- glossary words;
- the shared type steps and the docs-only prose step (§8.1).

Each screen renders at desktop and phone, in both themes.

| Screen id             | What it shows                                                                                                                                                                                      | Packages         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `docs.landing`        | Three doors (the two gated ones labelled "For console members"), top help tasks, search; no hero art                                                                                               | DOC-02b, DOC-07a |
| `docs.help-home`      | Help header (Help tag, Search help, Your library ↗, no door tabs); six task tiles; categories; one line linking **Get help with an app**                                                           | DOC-02b, DOC-04a |
| `docs.help-article`   | "Move your license to a new computer": the Important callout, three branches, steps with bold labels, a portal screenshot pair, Check it worked, Undo, Still need help?, Last reviewed             | DOC-02a, DOC-05b |
| `docs.help-message`   | Arrived from DJDL's error screen at `#device_limit`: the entry highlighted, the catalog title and message quoted, Why you see this, What to do, **Open your library ↗**                            | DOC-02a, DOC-05a |
| `docs.guide-lanes`    | **Add licensing to your app**: SDK picker on Swift, lane tabs on **Your own UI** with States to handle (copy key and Help URL per state), steps tagged App and Console, Verified in Check it works | DOC-02a, DOC-09a |
| `docs.sdk-quickstart` | The Swift quickstart's fork: two equal cards, the comparison table, the first gate in both lanes, the install step with the scope routed first                                                     | DOC-02a, DOC-08a |
| `docs.reference`      | Error codes: a wide table in compact `DataTable` rows (Code · On screen · What it means · Fix · Help), filter chips, sticky header, no ToC                                                         | DOC-02a, DOC-12a |
| `docs.search`         | The ⌘K dialog for "device limit": results grouped Help, Developers, Operate, with section paths, keyboard hints and the "Help only" chip on a Help page                                            | DOC-02c, DOC-03b |
| `docs.mobile-menu`    | Phone: the open menu with the door tabs, the current door's tree and the theme row                                                                                                                 | DOC-02b          |
| `docs.operate-guide`  | **Help a customer**: Role required, **Open Licenses ↗** buttons, bold console labels, a link to the Help article the customer sees                                                                 | DOC-02a, DOC-11a |
| `docs.not-found`      | `EmptyState`: the star in text-subtle, one strong line, one muted line, **Back to the docs** and search                                                                                            | DOC-02b          |

`sdk.docs-first-product`'s header is updated to the door tabs, and its type to §8.1.

**Reviews.** Three `pkey-ux-reviewer` passes in mockup mode, each with its own lens:

1. **Consumer.** Someone who never chose Polaris Key, on a phone, arriving from an error.
2. **Developer.** Lanes, tabs, code legibility, how the page connects to Integration.
3. **Brand consistency.** Side by side with the **console and portal baselines** and with
   `products.integration` and `portal.library`: header, nav, pills, tabs, code, callouts,
   tables, footer.

Findings are applied in one fix round, and `designReview` records the round. Built screens then
follow the mockups README's update rule: saved to `_mockups/built/docs.*`, then a built-mode
`pkey-ux-reviewer` pass in a real browser.

### 8.5 The engineering packages and their checks

DOC-02a, DOC-02b and DOC-02c (§6.1) build all of §8.1–8.3. They own no content beyond the landing
layout. **Done** means:

- **Side by side with the real surfaces.** Built shots of the landing, a Help article, a guide
  with lanes, the reference page, search and the phone menu are laid next to the console and
  portal baselines (header beside the portal's top bar, sidebar beside the console's, callouts,
  pills, tables and code beside console pages) in both themes and on phone. The built-mode
  `pkey-ux-reviewer` signs them off against those baselines, not only against the mockups.
- **No local restyling.** `docs-classes.test.ts` fails when a docs stylesheet or an `.astro`
  style block sets colour, radius, spacing or font size on a class from `ui/classes.ts` or on a
  rendered console component. Starlight-only parts are on a short allow-list.
- **The shared lint.** `pnpm ui:lint --html=<built page>` passes on the six pages above.
- Every page passes the screen contract's no-horizontal-scroll rule at 390 px.
- The CSP hash set stays small (external stylesheets only; `inlineStylesheets: "never"` kept).
- The console and portal baselines are unchanged by DOC-02a's move of `theme.css`.

---

## 9. What not to do

- **Don't write ahead of the code.** A page about behaviour lands in that behaviour's PR. No
  "will", "soon", "coming", "currently" or "new" on shipped pages.
- **Don't publish what nobody can use.** No spec pages for components no kit ships (they are
  "Not built yet" rows), no feature sections with no pages, no stubs at the 0.9.x exit.
- **Don't promise a time you haven't measured.** "About 10 minutes" appears only after the
  fresh-reader run (§6.2).
- **Don't restate.** A concept gets one sentence and a link to its home. Rule lists, counts and
  tables that a source can generate are generated: the coherence rules, sub-clients, the console
  tour, channels and roles.
- **Don't count in prose.** No "six services", "seven surfaces" or "five dialects". Lists render
  from `tools/services.json`, parity and `api.json`.
- **Don't leak programme ids.** No P0-, ST-, LX-, D-14, "Amendment A2", `plans/…` or "SDK parity
  pass §3.1" in reader text, including OpenAPI descriptions.
- **No marketing.** No "seamless", "powerful", "simply", "just", "easy", banners or exclamation
  marks. Reference pages open with facts.
- **Don't hide the answer.** No primary answer only inside a tab or a collapsible. No nested tabs.
  Tabs are for alternatives, never for sequential steps.
- **Don't paste code.** Generate it or include it from a compiled snippet target.
- **Don't show an install command without its scope routing.**
- **Don't cross doors.** A Help page never links into gated docs (the chrome exception in §3.1 is
  the page chrome's, never the writer's), never uses developer words, and never says "contact
  support" as its first step. A developer page never answers a consumer question inline; it links
  Help.
- **Don't build a lookalike.** A docs part the console has uses the console's component or class
  constants (§8.2).
- **No hand-made screenshots.** No light-only images, no personal data, no screenshot of text
  that could be text.
- **No history in guides.** No "v2 used…", "Previously…" or "Deprecated spellings" sections. 0.9
  removes old names (owner, 2026-10-07): the changelog records each removal, the upgrade guide
  collects them, and the validation reference names the replacement.
- **No release-notes pages per feature, and no versioned doc trees.** One changelog, rendered in
  several views. "Since 0.9.2" notes, and one compatibility page.
- **No auto-generated "related" lists.** Three to five links, chosen by hand.
- **Respect the length budgets in §2.** Pages over them today are split by H2 in their package:
  `identity/portal` 8.9k, `manifest/authoring` 7.6k, `release/packs` 7k, `ci` 6.5k, `concepts`
  6.1k, `package-feeds` 5.4k, the runbook 16.9k and the Godot README 15k.

---

## 10. Amendments to the consolidation plan, and docs lines on its packages

**Amendments.** The lead applies these to `backlog-changes.json` and `integration.md`:

1. **C-51, I-19 and PX-19.** Customer help lives in the docs site's public Help area (D1). The
   portal links to it and keeps its in-product copy on the catalog. I-19 narrows to developer
   identity docs. Consumer identity articles are DOC-04b's, and each I- package updates its
   article.
2. **ST-29 and ST-35.** The docs gate is tiered (§3.1). Help needs no session. The developer tier
   admits any console member, and anyone else reaches the access page. The split (DOC-03b) lands
   before ST-30 issues non-admin sessions, so Product admins arriving from Integration never meet
   NoAccessPage. ST-35 keeps the Pagefind split, now three bundles, and the rule 11 text.
3. **SP-33a and SP-33b.** `renderUsage(feature, lang, lane)` with `lane` = `kit` or `library`, and
   goldens for both lanes. SP-33a also writes the docs' generated blocks.
4. **ST-41.** Per-SDK, per-feature links to the library lane through `integrationDocs()` in
   `docsLinks.ts`, checked against anchors and frontmatter (§3.7). A feature's "Not seen yet"
   state links `build/troubleshooting`.
5. **SP-37.** It depends on ST-41 and ST-43 as well as SP-33b, because "Your first product"
   mirrors the wizard. Its final path gets the fresh-reader run (§6.2). The developer changelog
   generator moves to DOC-12a now, so v0.9.0 ships its break list.
6. **Remove the deprecation wording** in the JSON for SP-35, SP-40, F-37, A-25, LX-33, LX-40 and
   ST-38. Rule 6 removes old names in 0.9, so the docs must not document aliases.
7. **Every removal adds an upgrade row.** SP-35, SP-40, ST-34, A-25, LX-33, LX-40, ST-38 and F-37
   each add a changelog entry whose `replaces` rows name every removed SDK name, manifest field,
   CLI form or Action input and its replacement, so **Upgrade to 0.9** regenerates in the same PR.
8. **P0-42** registers the docs generators: help messages, install steps, CLI, Action, console
   tour, integration docs, changelog and the upgrade table.
9. **P0-37.** Every component components.md §7 lists for the docs stays renderable without the
   console's router, stores or query client, and keeps its class constants in `ui/classes.ts`.
10. **A new all-SDK copy package** (DOC-06c): `help.link` in every kit-copy locale and an
    `error.helpUrl` row in `api.json`. It lands after SP-39 and SP-35. It is not a wire change.

**Docs acceptance lines** (P2). Each package writes or rewrites these pages, and a changelog entry
for any removal, in its own PR:

| Package                                  | Pages                                                                                                                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ST-37 (in flight)                        | `start/concepts.md`: the glossary                                                                                                                                                                                                            |
| ST-38                                    | `features/` labels and `src/lib/features.ts` replaced by `console.group`; `operate/console/products`; the coherence-rule table; an upgrade row for the declared registration policy                                                          |
| ST-40, ST-41                             | `build/integration`; Verified in every **Check it works**; "Not seen yet" → `build/troubleshooting`                                                                                                                                          |
| ST-42, ST-43                             | `start/first-product` (wizard steps); `operate/console/products`                                                                                                                                                                             |
| ST-29 … ST-35                            | `operate/console/members`, `reference/roles`, runbook lockout recovery, rule 11 text                                                                                                                                                         |
| ST-34                                    | Remove `PKEY_ADMIN_COOKIE` from `start/first-product`, `features/licensing/offline`, `reference/protocol/bundles`, `features/ship-builds/channels/polaris-key`, `contribute/agents/recipes`; `reference/cli` (`pkey login`); its upgrade row |
| ST-09, ST-44, ST-45                      | `operate/platform/settings`; `operate/console/tour` regenerated                                                                                                                                                                              |
| LX-33, LX-40                             | `features/licensing/model` (holder states, tiers, limits); `help/license-status`, `help/messages/license-status`; `reference/settings`; their upgrade rows                                                                                   |
| LX-34, LX-35                             | `features/licensing/{entitlements, add-ons}`; `features/managed-config/catalog` (flags leave); `help/library` (add-ons)                                                                                                                      |
| LX-36, P2-10, LX-38                      | `features/licensing/access` (enrollment and policy merged; automatic licenses); `help/activate`, `help/library`                                                                                                                              |
| LX-39                                    | `features/sign-in/*` (key entry); `help/messages/accounts` (`license_owned`)                                                                                                                                                                 |
| LX-41, LX-43, LX-23                      | `features/licensing/durations`; `help/subscriptions`, `help/license-status`                                                                                                                                                                  |
| CM-29, CM-20 … CM-28                     | `features/commerce/*` (with `features/ship-builds/commerce` and `channels/storefronts` moved in); `help/restore-purchase`, `help/refunds`                                                                                                    |
| U-30, U-31, U-27 … U-29                  | `features/managed-config/{catalog, visibility, minted-tokens, profiles}`; `reference/config-entry`                                                                                                                                           |
| U-01b, U-05, U-10, U-22, U-23            | `features/cloud-sync/*` (the skeleton arrives); `help/sync`; synced data in `help/remove-from-library`                                                                                                                                       |
| I-29 … I-34, I-08, I-10a/b, SP-40        | `features/sign-in/*`; `operate/platform/connections`; `help/work-account`, `help/account`, `help/connected-apps`; React cookie note removed; SP-40's upgrade row                                                                             |
| I-11                                     | `help/your-data` (self-serve export); the export task in `operate/console/help-a-customer`                                                                                                                                                   |
| F-33, F-34, F-36, F-37                   | `features/ship-builds/packages/*`; `build/install` (private feeds); `help/packages`; F-37's upgrade row                                                                                                                                      |
| A-19 … A-28, A-33                        | `features/ship-builds/channels/*`, rewritten in place (one page per channel; the matrix section at A-21); `reference/channels`; A-25's upgrade row                                                                                           |
| P2-08, P2-09, P2-11, P2-12, P4-33, P4-34 | `releases/release-tracks`, `updates/*`, `packs/*`; `help/beta`                                                                                                                                                                               |
| SP-35, SP-32a/b, SP-33b, SP-36, SP-37    | `reference/api-names`; every quickstart regenerated; snippets included from `examples/` (the SDK docs-snippets targets retire); `build/sdks/*` reference-only; SP-35's upgrade rows                                                          |
| UK-02b, UK-04 … UK-12, UK-31, UK-41      | `<StatesToHandle>` from fixtures; a kit tab per component; a component page returns when a kit ships it; a recipes page at UK-31                                                                                                             |
| HA-13, HA-14                             | `build/ui/theming` (presentation)                                                                                                                                                                                                            |
| P0-28                                    | `operate/console/keys-and-secrets`; `operate/platform/connections`                                                                                                                                                                           |

**Exit for the 0.9.x docs** (P1 done):

- Help is public (D4 in place), and every app message has a home.
- The portal, emails and the download page link into Help.
- There is one start path and one decision page, and the fresh-reader run passed on Node and
  Swift.
- Every quickstart shows both lanes on shipped symbols, every install step routes the scope, and
  every snippet compiles in its SDK lane.
- **Upgrade to 0.9** has a row for every removal shipped so far.
- No page describes unbuilt behaviour as shipped. No stubs. `lint-debt.json` is empty.
- The theme matches the reviewed mockups and sits beside the console and portal baselines.
- The tiered gate is live, and `check:links`, `docsLinks` and `helpLinks` pass.

The 1.0 bar's experience line ("the docs have one start path, and every generated page is
current") is met when SP-37 and the P2 lines are done.

---

## 11. Review log

**2026-10-08, editor's review.** Verdict: "Not ready for writers yet; revise first." Every
blocking finding is fixed. Most minor findings are applied; three are applied differently from
the suggestion, with the reason below.

**Blocking findings**

| #   | Finding                                                       | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Where                |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | The first 10 minutes fail at the first command                | Console **New product** is the one first step; `pkey init` and resync became the how-to **Register a product from its repo**. Every install step routes the `@polaris-key` scope first, rendered from the CLI's `feedsSetup()`. The Developers overview shows no command. `pkey doctor` left the interim path. A fresh-reader run on Node and Swift is in DOC-07a's and DOC-08a's definition of done, and the landing names a time only once it is measured                                             | §3.4, §3.5, §4, §6.2 |
| 2   | No upgrade guide for 0.9's removed names                      | **Upgrade to 0.9** (`build/upgrade-to-0-9`, P1, DOC-12a), with a generated Removed → Use instead table from the changelog's new `replaces` rows and `api.json`; the one page exempt from the removed-names lint; an acceptance line on SP-35, SP-40, ST-34, A-25, LX-33, LX-40, ST-38 and F-37; in the exit criteria                                                                                                                                                                                    | §2, §3.5, §5, §10    |
| 3   | No troubleshooting page for problems that cut across features | **Troubleshoot your integration** (`build/troubleshooting`, P1, DOC-07b). The Quickstart type gains "If it isn't working". Error-code entries and ST-41's "Not seen yet" link it                                                                                                                                                                                                                                                                                                                        | §2, §3.5, §3.7, §5   |
| 4   | The brand integration is a third copy with no drift check     | Option 1 chosen (D7): the docs render the console's own static components at build time and share class constants for interactive parts; the utility layer moves to `ui/theme.css`; no `components.css`, no mockup-kit extraction. A part-by-part mapping table (admonitions → `Callout` tones, tables → `DataTable` classes). Lead-approved components.md §7 and a BRAND.md §2 line. Checks: `docs-classes.test.ts`, `ui:lint --html`, and a built-mode review beside the console and portal baselines | §0, §8.1, §8.2, §8.5 |
| 5   | Undeclared dependencies, one circular                         | DOC-03a ships the contracts: every target path (moved or a stub with planned anchors), every redirect, the MDX components with final props including `PortalShot`, and every lint with a debt ledger. Writing starts against unstyled components; DOC-02a only restyles. DOC-12a's Help column declares DOC-05a; DOC-06a and DOC-06b follow the public switch                                                                                                                                           | §5, §6.1, §6.3       |
| 6   | Batches too big; W3 holds up everything                       | Twelve batches split into 28 packages of one concern or about ten pages: DOC-03a and DOC-03b, DOC-02a to DOC-02c, DOC-05a to DOC-05c, DOC-09a to DOC-09c, DOC-10a to DOC-10c, DOC-12a and DOC-12b, and more. DOC-03a no longer waits for ST-38: `src/lib/features.ts` maps the owner-approved names until `console.group` replaces it                                                                                                                                                                   | §3.2.1, §6.1         |
| 7   | No rule for Developers versus Operate                         | The door rule: features own their console screens; Operate → Console owns only product-wide screens. Integration moved to `build/integration`; Create and set up a product links Your first product; `nav-docs-targets.test.ts` checks every Docs target                                                                                                                                                                                                                                                | §3.1, §3.3, §5       |
| 8   | Public pages link into gated pages                            | A public `/docs/access/` page catches every sessionless reader of a gated page. Door-level links are allowed only in the page chrome, labelled "For console members", and `check:links` encodes that exception                                                                                                                                                                                                                                                                                          | §3.1, §3.4           |
| 9   | `/help` can collide with a product slug                       | D8: `help` joins `RESERVED_PRODUCT_SLUGS` and the schema, with a test row; the lead confirms no product uses it before go-live                                                                                                                                                                                                                                                                                                                                                                          | §0, §3.1, DOC-03b    |
| 10  | Two shipped consumer features have no Help article            | **Secure your account** (DOC-04b; security emails link it) and **Activate a computer without internet** (DOC-05b). Help a customer gains the activation-file and compromised-account tasks                                                                                                                                                                                                                                                                                                              | §5, §7.1, §7.4       |

**Minor findings, applied**

- `sync-failed` moved to its real entry, "Couldn't check your license", under license status.
- "Can't remove" is one heading with a branch per cause, each with its own id.
- Message ids are defined (`device_limit`, `gate.expired`, `activation.device-limit`, `fallback`)
  and used by anchors, the redirector and `helpLinks.ts`.
- Product and app are split: product is the record in Polaris Key, app is the developer's build
  and what consumers use. DOC-03a updates AGENTS.md rule 4 (style guide §4).
- The interim path looks under **Core → Devices** and drops `pkey doctor`.
- Unbuilt items carry their package: the data export (I-11), synced data on library removal
  (U-22), CLI docs links (P3, no package), the kits' Get help (P2, DOC-06c).
- D4 is required before Help goes public, unless the owner accepts the gap.
- The distribution console pages move once, to the path their final page keeps.
- The seven unbuilt component pages, the Kit recipes page and the DJDL cutover archive are
  deleted; Cloud Sync is one page until U-05.
- Rules have one home: the Help voice, the code-writing rules and the screenshot rules are the
  style guide's; budgets are §2's. The Chooser type is gone (an Overview with a decision table).
  One id per package (DOC-xx).
- A feature's Prebuilt UI and Reference are cards on its Overview, and empty sections are left
  out.
- Each message group sits last in its task group; All messages, A to Z is the one index.
- Who to contact has one home, Get help with an app.
- States to handle lists each state's copy key and Help URL; the decision page lists Verify on
  your server and says what the Node and Python terminal kits are for.
- Swift, Kotlin and GDScript snippets compile now, in docs-snippets targets inside each SDK; so do
  Node, React and Python, so no hand-written SDK fence remains.
- Developers and Operate follow the console's collapse rule; tables use the `DataTable`'s classes,
  not the mockup kit's 56 px rows.
- Gated-only `/_astro/` files stay gated; only files a public page or the layout uses are public.
- "Sign-in cancelled" is quoted as shown and gets a copy fix; DOC-02b owns the landing layout and
  DOC-07a its copy; DOC-01 waits for the spacing workflow; translated titles are search aliases.

**Minor findings, applied differently**

- **"What's new" and the time-word lint.** The heading became **Latest changes** rather than an
  exemption, so the lint keeps no special case.
- **The `features` frontmatter field.** Renamed `services`, because its values are service slugs
  and drive the per-service accents that Ship builds' sub-areas keep; switching to feature keys
  would lose those accents.
- **Public developer overview.** The review offered making `start/index` public; the plan keeps
  developer pages member-only (D2) and uses the public access page instead, so no developer
  content becomes public before the 1.0 review.
