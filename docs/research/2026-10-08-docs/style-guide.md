# Polaris Key docs style guide

How every page on `key.plrs.im/docs` is written. It goes with the plan in [`README.md`](README.md),
which owns the machinery: page types and their budgets (§2), the doors (§3.1), and where code
comes from and what checks it (§4). This guide is the **only home** for writing rules: the
voices, the Help voice, copy rules, words, how code is written, admonitions, screenshots and
diagrams. DOC-12b publishes it as `/docs/contribute/writing-docs/`. Writers get it with every
package, and reviewers check against §12.

What enforces it:

- DOC-03a's lints check the mechanical rules: type skeletons, banned words, programme ids, counts,
  future tense, Help's word list, `pkey` commands and HTTP paths. Today's hits sit in
  `lint-debt.json`, which only shrinks; a package clears its own pages.
- A critic pass checks the rest. For Help, the critic is a fresh reader with no repo context.
- Where this guide and a screen disagree, **quote the screen** and file a copy fix.

---

## 1. Three voices, one style

| Door           | Reader                                                        | Voice                                                                  | Density     |
| -------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------- |
| **Developers** | Someone integrating an SDK, writing a manifest, running CI    | Precise and technical. The UI's and the code's own words               | compact     |
| **Operate**    | A console member or platform admin doing a task               | Precise. Console labels exactly as shown. Role and impact stated first | compact     |
| **Help**       | Someone using an app built on Polaris Key, who never chose it | Warm, plain, short. The app's and portal's words. No developer terms   | comfortable |

Every door follows §4 to §11. The voices differ only in vocabulary (§5) and the Help rules (§3).

## 2. Developer and operator pages

- **Second person, present tense, active voice.** "The SDK caches the license document." Not "The
  license document will be cached".
- **One idea per sentence.** Aim for 15 words and stay under 25. Split a sentence that carries an
  "and" with two ideas.
- **Lead with the point.** The first sentence of a page or section says what the reader gets or
  must know. Background comes after the steps, or on a concept page.
- **Put the condition before the instruction.** "To pin a release key, add…" and "If the device
  is offline, the SDK…", not "Add … to pin a release key".
- **Give one sentence of why and link the rest.** Any explanation longer than a sentence belongs
  on a concept page.
- **Contractions are fine** (don't, can't, it's). Never "we'll" or "let's".
- **Say exactly what happens.** "Publishing signs the release and puts it on the stable track".
  Not "Publishing processes the release".
- **No marketing and no hedging.** Don't use: seamless, powerful, robust, simply, just, easy,
  effortless, leverage, utilize, "out of the box", "best-in-class", exclamation marks.
- **No time words.** Don't use: currently, now ("now supports"), new, recently, soon, coming soon,
  "at the moment", "for now", "in the future", "what's new". Say what is true. Something not built
  yet is a "Not built yet" row in a generated table, never a sentence about the future. The
  changelog strip on the Developers overview is headed **Latest changes**.
- **No promised durations you haven't measured.** "About 10 minutes" appears only after the
  fresh-reader run (README §6.2) measured it.
- **No programme ids, plan paths or history.** Readers can't resolve "LX-33", "D-14", "SDK parity
  pass §3.1", `plans/P4-01.md`, "until wire contract v3", "v2 used refresh()". The changelog and
  **Upgrade to 0.9** hold history.
- **No counts.** "Every service" or a generated list, never "the six services".
- **Operate pages** open with **Role required** and, for anything that changes data, the
  **impact**. Steps name the console page and labels in bold, exactly as shown: "Open **Licenses**,
  select the license, then **Deauthorize Old iMac**". Skip anything the screen makes obvious.
- **Write in the door that owns the page** (README §3.1). A feature's console screens are
  documented in that feature's how-tos; Operate → Console covers only screens that span the
  product. When a task touches another door, link it in one sentence.

## 3. Help pages (consumer voice)

This section is the one home for the Help voice. The reader did not choose Polaris Key. They
bought or installed an app, and something on screen sent them here. Write for that person on a
phone.

- **The app is the hero.** Say "the app" and "the app's developer", or name the app when the page
  is about one ("DJDL"). Polaris Key is "the service the app uses for licenses and sign-in".
  Never write product, tenant, platform, operator, console, customer or end user.
- **Start with what this fixes**, in one sentence. Then, if it matters, one **Important** callout
  that says what can't be done and who can do it. "Polaris Key can't refund an app. The app's
  developer or the store you bought it from can."
- **Before anything that can't be undone**, put a **What happens when you…** section first.
- **Branch by situation, easiest first.** "If you still have the old computer" comes before "If
  the old computer is gone". Contacting someone is always the last branch, and it names the right
  party.
- **Who to contact has one home**: **Get help with an app**. Every other page gives it one
  sentence and a link: "For refunds, ask the app's developer or the store. See **Get help with an
  app**."
- **Steps.** Number them and keep each branch to 7 or fewer. One action per step. Labels in bold,
  exactly as the screen shows them ("Select **Activate license**").
- **Give the result.** End with **Check it worked** ("Your new computer appears under **Devices**")
  and, when possible, **Undo**.
- **Quote messages verbatim.** A heading for a message is the app's title, character for
  character, even when the catalog breaks a house rule ("Sign-in cancelled"; file the copy fix).
  It comes from the copy catalog through `<HelpMessage>`, never retyped, and its anchor is the
  message id (README §7.1), never written by hand. One title with two causes is one heading with
  a branch per cause.
- **Use their words** (§5.2). No SDK, API, token, OIDC, SSO, seat, magic link, manifest,
  entitlement, flag, channel, release track, tier (unless the app shows it), wire, endpoint, JSON
  or error code in prose. The code may appear once, in small text, as "code: `device_limit`", for
  telling the developer.
- **Never blame the reader.** Not "You entered an invalid key", but "The app didn't accept that
  key".
- **Never ask for secrets.** "Never send anyone your full license key". Send the last 4 characters
  and the code shown.
- **Say only what is built.** A feature the portal or the app doesn't have yet is not mentioned,
  not even as "soon". It joins the article in the PR that ships it.
- **Short.** At most 600 words per article and 120 words per message entry. Plain enough to
  translate: no idioms, no jokes, no culture-bound examples.
- **Never link into gated docs.** A Help page links only to Help pages, the portal and the app's
  own support. The footer's "Developer docs (for console members)" link belongs to the page
  chrome, never to the article. The tier rule in `check:links` enforces it.

## 4. House copy rules

These come from docs/design/EXPERIENCE.md §2 and apply to every page.

| Rule                            | Use                                                                        | Not                                                         |
| ------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Headings                        | Sentence case, no full stop: "Move your license to a new computer"         | "Move Your License To A New Computer."                      |
| Spelling                        | US: license, recognize, localization, color, canceled                      | licence, recognise, localisation, colour                    |
| Say exactly what happens        | "Publish", then "Published"; "The key is shown once"                       | "Your request was processed"                                |
| Errors                          | What happened, then the fix: "tonebox is taken. Try tonebox-app."          | "The server refused this (422 bad_request)"                 |
| Retry                           | Try again                                                                  | Retry                                                       |
| Secrets                         | Never shown again.                                                         | Four different phrasings of it                              |
| Confirm buttons, named in steps | The verb and the object: **Halt 2 rollouts**, **Deauthorize Old iMac**     | Confirm, OK, Yes                                            |
| Sign-in                         | Sign in · Sign in again                                                    | Log in, Back to sign-in                                     |
| Theme                           | System · Dark · Light                                                      | Match my device                                             |
| People and things               | Names; ids as secondary text                                               | `lic_1 · seat 1`, "by u1"                                   |
| When a line earns its place     | A consequence, an irreversible fact, a constraint, or the one missing fact | Restating the title; defining the label; promising a future |

Repo rules also apply (AGENTS.md rule 4, as DOC-03a words it):

- device, never machine;
- **product** is the record in Polaris Key: the console's product, the manifest, the API.
  **App** is the developer's build that embeds an SDK, and what consumers use. "Create the
  product in the console" and "Add licensing to your app" are both right; "Create the app in the
  console" is wrong. Help says "app" throughout (§3);
- tier, never plan;
- "profile" only for a config profile.

## 5. Words

### 5.1 UI words (ST-37's glossary)

`start/concepts.md` is the canonical glossary (AGENTS.md rule 4), and ST-37 is bringing in the
consolidation's words. **A word enters the docs in the same PR that puts it in the console.**
Until that package lands, write the word the console shows today. Identifiers in code, manifests
and on the wire keep their names; format them as code.

| Say                                                                   | Meaning                                                                                          | Not in prose (code spans only where an identifier)         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **Product**, **app**                                                  | The record in Polaris Key; the developer's build and what consumers use (§4)                     | app for the record; product in Help                        |
| **Feature**                                                           | Licensing, Managed config, Ship builds, Sign-in, Cloud Sync, Commerce                            | module, "the services" as product words, capability        |
| **Integration**, **Verified**                                         | The product page that connects each feature; a feature on a platform has answered an SDK request | setup checklist, quick start, "Setup complete"             |
| **License in an account**, **Waiting license**, **Floating license**  | Who holds a license                                                                              | owned, bound, unbound, pending holder                      |
| **Automatic grant**                                                   | The portal's label for a license the access policy issued. The only use of "grant"               | grant (otherwise), "From signing in"                       |
| **Tier**                                                              | A license template; every license has one                                                        | plan                                                       |
| **Add-on**                                                            | A sub-license: an in-app purchase, DLC, feature pack, seat pack or consumable                    | grant, store mapping, addon license                        |
| **Entitlement**                                                       | A named right a device gets from its license                                                     | flag (UI)                                                  |
| **Limits**                                                            | Device limit, offline days, release tracks, versions, fingerprint mode                           | terms, policy, effective policy                            |
| **Duration**, **Trial**, **Keeps the last version**, **Subscription** | How long a license runs, and how it renews                                                       | term, perpetual fallback                                   |
| **Access policy**, **Access**                                         | Who gets a license automatically; the product page for who gets what                             | auto-issue, enrollment settings                            |
| **Profile**                                                           | A named set of config and secret values: Default plus one per tier                               | license profile                                            |
| **Setting**, **Secret**, **Minted token**                             | The three config entry types                                                                     | edge-mint, half-secret, "config" as a type                 |
| **Editable**, **Read-only**, **Hidden**                               | A setting's visibility in the app                                                                | default, enforced, hidden as UI words; management state    |
| **Channel** (distribution channel)                                    | A place builds reach customers                                                                   | outlet (`outlet` is the code word only)                    |
| **Storefront**, **Sales**                                             | A channel's selling side; its tab                                                                | storefront (for a delivery place), commerce page           |
| **Offer**, **SKU**                                                    | What is sold; its id on one storefront                                                           | store product mapping                                      |
| **Install source**                                                    | AltStore, F-Droid, Obtainium, a Scoop bucket, Flathub                                            | storefront feed                                            |
| **Release track**                                                     | stable, beta, dev and custom lanes                                                               | update channel, "Channels" page                            |
| **Packages**, **Updates**, **Pack**                                   | Package feeds; updater setup and feeds; a content deliverable                                    | Package feeds (nav), Feed, content pack                    |
| **Connection**, **Sign-in surface**, **Screen name**                  | An upstream sign-in provider; a place a person signs in; the account's public name               | platform OIDC, custom issuer, sign-in channel, "Your name" |
| **Member**, **Role**, **Area**                                        | A console user; a built-in permission set; a stable permission id                                | admin group                                                |
| **Personal token**, **Service token**                                 | `pkeyp_` (packages-only or admin); `pkeyci_`                                                     | the console cookie for the CLI, product token              |
| **terms**                                                             | Legal terms only                                                                                 | license terms                                              |

### 5.2 The words Help uses instead

| Developer word                          | Help says                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| product                                 | the app (or its name)                                                                                     |
| the portal, customer portal             | your library at key.plrs.im (the site calls itself Polaris Key)                                           |
| account                                 | your Polaris Key account                                                                                  |
| license key, `pkey_…`                   | license key, or key                                                                                       |
| device, seat, activation                | device (never seat or machine); "the number of devices your license allows"                               |
| tier                                    | the name the app shows (for example "Pro"), otherwise "your license"                                      |
| entitlement, flag, add-on               | what your license includes; the add-on's own name                                                         |
| floating, waiting, or in an account     | a license with a key; a license waiting for you to sign in as name@example.com; a license in your account |
| access policy, Automatic grant          | the app gave you a license when you signed in. "Automatic grant" appears only as the label on screen      |
| release track, channel                  | beta versions; the version you're on                                                                      |
| distribution channel, install source    | where you got the app: the App Store, Steam, the app's download page, AltStore                            |
| connection, SSO, OIDC, IdP              | your work account; your organization's sign-in                                                            |
| email code, magic link                  | the code we emailed you (and its sign-in button)                                                          |
| passkey                                 | passkey (defined once: "a sign-in saved on your device, unlocked with your face, fingerprint or PIN")     |
| attestation, fingerprint, hardware hash | the device check                                                                                          |
| offline bundle, activation file request | the request code the app shows; the activation file the developer sends you                               |
| session                                 | where you're signed in                                                                                    |
| grace, `graceUntil`                     | "Offline grace" as the app shows it: "you can keep using the app offline until…"                          |
| version window, `allowedRange`          | "Update required" as the app shows it: "this version of the app is no longer supported for your license"  |
| revoke, deauthorize                     | the button's label ("Remove device"); "the developer turned off this license"                             |
| personal token                          | only on "Install packages with a personal token", defined there                                           |

## 6. Structure

- **Titles.** Each page type has a title pattern (README §2):
  - How-to titles are imperative with no "How to" and no gerund: "Add licensing to your app".
  - Concept titles are nouns.
  - A decision page is an Overview titled "Choose…": "Choose your integration".
  - Help titles are the reader's task or the on-screen message.
- **Description.** One sentence, the page's summary in search and cards. A how-to's description
  starts with a verb. A Help description says what it fixes.
- **Headings.** H2 and H3 only on most pages. Never skip a level. No heading that only repeats the
  title. Quickstart steps are numbered H2s ("1. Create the product").
- **Steps.**
  - One action per step.
  - The expected result follows in the same step, or as **You should see…** in a quickstart.
  - Where it runs is a tag at the start: **Console**, **App**, **Server**, **CLI**.
  - Commands are complete. "As configured above" is never allowed.
  - Optional steps come after the core path and start with "Optional:".
  - A quickstart or how-to ends with **If it isn't working** (at most 5 links) before Next steps.
- **Lists.** Use a numbered list for sequences and bullets for sets. At most 7 bullets; past that,
  use a table or group them.
- **Tables.** Use a table when items share attributes. Header cells are nouns. Never one row or
  one column. Reference tables put the quick table first.
- **Links.**
  - The link text says where it goes ("See **Release tracks**"), never "here" or "this page".
  - Internal links are absolute and end with a slash: `/docs/features/licensing/`.
  - Console pages are linked with `<ConsoleLink>`, portal pages with `<PortalLink>`.
  - Three to five related links, chosen by hand.
  - A link to a stub or to a page that doesn't exist yet is not allowed at hand-off.
- **Numbers, dates, units.**
  - Numerals for quantities ("5 codes an hour", "90 days"). Words only at a sentence start and in
    "one click".
  - Prose dates: "October 8, 2026". Tables and frontmatter: `2026-10-08`.
  - Units are spaced: "10 MB", "36 px".
  - Versions read "0.9.2". Minimums read "Node 22.13 or later".
- **Abbreviations.** Expand on first use on each page, except URL, HTTP, JSON, CLI, SDK and API on
  developer pages. No "e.g.", "i.e." or "etc.": write "for example" or "such as", or finish the
  list.

## 7. Code

This is how code is written. README §4 is where it comes from and what checks it.

- **Never write an SDK snippet into a page.** Generate it (`<Generated>`) or include it by region
  from `examples/` or from the SDK's docs-snippets target (`<Snippet>`), where that SDK's CI
  compiles it. To add a snippet, add a region to the snippet target, in the SDK's own style.
- **Install steps route the scope first.** Use `<InstallSteps>`: it prints the registry routing
  for `@polaris-key` (or the ecosystem's equivalent) and then the install, from the CLI's own
  setup text. Never write a bare `npm i @polaris-key/…`, and never `--extra-index-url`.
- **Every block is titled** with its file name (`App.swift`, `polaris-key.json`,
  `.pkey/product`) or **Terminal**. Output goes in its own block titled **Output**.
- **Tidewater Studio (`tidewater`)** is the one example product. App code reads its generated
  config (`polaris-key.json` from SP-32), so slugs, URLs and pins don't appear in snippets.
- **Placeholders** look like `<fingerprint from Integration>`: angle brackets, lowercase, a
  description. A block containing one has no Copy button, and its footer says where to get the
  value.
- **No secrets, real or fake.** Tokens come from environment variables (`PKEY_CI_TOKEN`) or
  `pkey login`. Key prefixes appear only in reference tables, with a "Safe to share" column.
- **Tabs.** Use the SDK picker, the lane tabs, package-manager tabs or surface tabs, synced
  site-wide and never nested. The first paragraph above any tab set says what the tabs hold, so
  the answer survives a flattened export.
- **Formatting and length.**
  - Use each SDK's formatter (Prettier, ruff, swift-format, ktlint, gdformat).
  - Lines are at most 80 columns, so a phone shows them without much scrolling.
  - Comments explain why, not what.
  - No `...` inside a region a reader copies. Long files are included by region instead.
- **Shell commands** have no prompt (`$`) in copyable blocks. A command and its output never share
  a block.
- **Manifests, `pkey` commands and HTTP calls** are validated (README §4): write them so the
  validator, `help.ts` and the OpenAPI spec accept them as they stand.
- **Inline code** is for identifiers, file names, commands, values and codes. Never for emphasis,
  and never for UI labels (those are **bold**).

## 8. Admonitions

Four types, each with one meaning. They render as the console's `Callout`, with an icon and a
title, never told by colour alone.

| Type        | Console tone | Means                                                                                      | Title it with                                          |
| ----------- | ------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| **note**    | info         | A fact the reader needs to act correctly that doesn't fit the flow                         | The fact: "The key is shown once"                      |
| **tip**     | success      | A shortcut or a better way                                                                 | The shortcut: "Copy the command from Integration"      |
| **caution** | warning      | Something that can cause a bug or a real inconvenience. On Help it is titled **Important** | The consequence: "Devices on 2.4.0 keep it"            |
| **danger**  | danger       | Data loss, a security exposure, or something that can't be undone                          | The loss: "Deleting the product deletes every license" |

- **Lead with the "so what".** The title alone should be enough. Never title one "Note" or
  "Warning".
- **Limits.** At most 2 per page on developer and operator pages; at most 1 on Help. Never two in a
  row. Never between two paragraphs about one idea. Never inside a step, unless it changes that
  step.
- **Never repeat body text** in an admonition, or an admonition in body text.
- **Not admonitions.**
  - "Not built yet" is a row in a generated status table, not a callout.
  - "Requires" (features, role, SDK version) is the chip row under the title.
  - The **signed** (gold) tone is only for signature facts.
- **Collapsibles** hold optional detail only. Title them as a question: "Using Node 20?". The
  primary answer never sits in one.

## 9. Screenshots

- **From baselines only.**
  - Portal screens come from the portal's committed visual baselines through `<PortalShot>`.
  - App screens come from the kit baselines through `<KitBaselines>`.
  - Nothing is captured by hand, cropped by hand or committed under `packages/docs`.
- **Both themes.** Each shot is a dark and light pair swapped by the reader's theme, with the phone
  capture on narrow screens. A light-only image is a defect.
- **Fixture data only.** Fixtures use `example.com` people and the fixture apps. No real personal
  data, keys or emails, even blurred.
- **Captions and alt text.** The caption names the element ("The **Activate license** dialog").
  The alt text says what the screen shows and what to press. Consumer captions for kit screens
  add "Your app may look different".
- **Earn the image.** At most one screenshot per Help branch. None where a bold label already makes
  the step clear. Never a screenshot of text: code, errors and messages are text.
- **Console screenshots** appear only on Operate walkthroughs, and only once the console has
  committed baselines to import. Until then, bold labels carry the steps.

## 10. Diagrams

- **Prefer a numbered list or a table.** Draw a diagram only for a flow across three or more
  parties, such as a sign-in redirect, the update flow from CI to device, or the config chain.
- **Draw in SVG** with brand tokens (`currentColor`, `var(--pk-…)`), so it follows both themes.
  Rubik for labels. No raster diagrams, no screenshots of whiteboards.
- **Give the full text.** The surrounding prose or a caption carries the full flow, so a screen
  reader or an agent loses nothing.
- **Plain-text trees** are fine inside code blocks for directory layouts and sidebar sketches.
  ASCII-art flows are not.

## 11. Accessibility

- Status is never told by colour alone: pills, callouts and badges carry a word and an icon.
- Every image has alt text. Decorative marks have empty alt next to a visible name.
- Headings are in order. Each page has one H1, the title.
- Tables have header cells. Wide tables scroll inside their own container, never the page.
- Link text makes sense on its own. Icons-only links have an accessible name.
- Controls are at least 44 × 44 px on phones. Focus is visible (the brand's 2 px violet ring).

## 12. Review checklist

The reviewer, and for Help the plain-language critic, cites `page#anchor` for each finding.

1. Is the type right, and does the page follow its skeleton and budget (README §2)? Is it in the
   door that owns its subject (README §3.1)?
2. Does the first sentence say what the reader gets? Is the answer outside every tab and
   collapsible?
3. Is every claim true against today's code, with the evidence in the PR? Is anything unbuilt
   described as shipped, or any duration promised that nobody measured?
4. Is any concept explained here that has a home elsewhere? Replace it with one sentence and a
   link. On Help, is "who to contact" one sentence and a link?
5. Are the words the glossary's (§5.1), or Help's (§5.2)? Product and app used right? Any banned
   word, time word, count or programme id?
6. Do the labels and messages match the screens exactly? On Help, do message titles render from
   the catalog, with their message-id anchors?
7. Is the code generated or included from a compiled snippet target? Does every install step
   route the scope first? Is every block titled? Are there no secrets, and are placeholders
   correct?
8. Do the steps have one action each, results shown, Check it works or Check it worked, an Undo
   where possible, and "If it isn't working" where the type asks for it?
9. Are admonitions within their limits, titled with the point, and not repeating the body?
10. Are screenshots from baselines, in both themes, with captions and alt text?
11. Do links point inside the page's tier, with no stub targets, and are related links three to
    five, chosen by hand?
12. On phone and in both themes, does anything scroll sideways, and does every element read?
