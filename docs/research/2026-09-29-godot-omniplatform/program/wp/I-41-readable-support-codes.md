# I-41 Readable support codes, and support-code search in the Polaris Key Console

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16)            |
| Size        | 0.6–1 engineer-weeks                                                          |
| Depends on  | [I-11](I-11-portal-library.md)                                                |
| Unblocks    | none                                                                          |
| Role        | `pkey-implementer`                                                            |
| Plan mode   | no                                                                            |
| Gates       | migration; table-owners; rule-10; threat-model; console CSP parity; docsLinks |
| Human input | none                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                     |

## Goal

Owner request (2026-10-20): make support codes easy to read aloud to a support agent, and let the
Polaris Key Console search by them. Today the support code is the person's pairwise subject for the
product (`ps_` + 22 base64url characters), minted by `POST /api/products/<p>/support-code`
(`services/identity/portal/supportCode.ts`) and shown as `supportCode` on the portal product page.
It is not on the wire, in client-core or in any SDK, so this is no wire change.

## Spec (lead decisions)

1. **Format.** Nine characters shown as `XXX-XXX-XXX` (distinct from device codes, XXXX-XXXX).
   Alphabet `23456789ABCDEFGHJKMNPQRSTVWXYZ` (30 symbols; no 0/O, 1/I/L, U). Crypto randomness with
   rejection sampling (uniform). 30^9 ≈ 2×10^13 codes, globally unique, retry on collision. Shown in
   the mono font, grouped, with a Copy button that copies the dashed form.
2. **Input normalization** (portal and console): case-insensitive; spaces, dashes and dots ignored.
   Anything outside the alphabet is "not a support code".
3. **Storage.** New D1 table `support_codes (code TEXT PRIMARY KEY, product TEXT NOT NULL, subject TEXT
NOT NULL, created_at INTEGER NOT NULL, UNIQUE(product, subject))`, owned by `identity`
   (`TABLE_OWNERS` row; regenerate the data-model docs with `pnpm gen docs-reference`). Migration
   `00XX_support_codes.sql` (the lead numbers it). Created lazily, never backfilled. One stable code
   per (product, person); "Get a support code" returns the existing one.
4. **Portal.** `POST …/support-code` and the product view return the readable code, not the subject.
   `SupportCodeRow` shows it formatted, with Copy and the hint "Give this code to <App>'s support."
   Keep the rate limit and the rule that a code-only subject stays unlisted. Keep the change inside
   `SupportCodeRow` (PX-28a may touch the product page near `ProductDataCard`).
5. **Console.** The product Users page search recognises a support code (dashes optional) and does an
   exact lookup within that product. New `GET /manage/api/support-codes/<code>` resolves a code to
   `{product, subject}` only when the caller `can(product, users)` read; otherwise the same 404 as an
   unknown code (no cross-tenant oracle). Rate-limited per operator. The command palette (Cmd-K)
   recognises the pattern, offers "Open support code XXX-XXX-XXX" and jumps to that product's user.
   The code shows on the user's row and detail. Rule 10: OpenAPI spec plus `routeCoverage` / descriptor
   `surface`.
6. **Security.** The code identifies the person to that product's support; it is no credential.
   Lookups never reveal another product's data or the account email. THREAT-MODEL rows: enumeration
   (30^9 plus the rate limit), cross-tenant, code versus subject.
7. **Docs.** Help support-code page/section says what it is and where to find it; operate/console/users.md
   covers search and the palette; correct every place that says the code is the subject. Terse copy;
   "Polaris Locker" on customer pages, "Polaris Key Console" on operator pages.

## Tests

Alphabet, length and grouping; normalization; collision retry; stability; scope (product A's operator
gets 404 for product B's code); palette jump; portal display; the worker suite; `gen --check`.

## Acceptance criteria

- [ ] Spec items 1-7 hold.
- [ ] Migration, TABLE_OWNERS row, OpenAPI + routeCoverage, THREAT-MODEL rows done.
- [ ] Tests above pass; green gate passes.
- [ ] Real-browser self-look: portal row and console search and palette, dark and light, 390 and 1440.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).
