# Admin component system

Companion to [ADMIN.md](../ADMIN.md) §4. These are the API sketches, states and accessibility
contracts for every component the redesign builds. Each component consumes `@polaris-key/brand`
tokens; none defines a color, radius, shadow, duration or font of its own.

## Conventions

**Location.**

- Primitives live in `packages/admin/src/ui/`, which replaces `components/ui/`.
- Composites shared by both SPAs live in `packages/admin/src/ui/` as well.
- Console-only composites live in `packages/admin/src/console/components/`.
- Portal-only composites live in `packages/admin/src/portal/components/`.

**Token names.** These follow BRAND.md's semantic paths. Tailwind v4 utilities are generated from
the brand package's `@theme` export:

| Utility                                                                   | Brand path                   |
| ------------------------------------------------------------------------- | ---------------------------- |
| `bg-surface-page`, `-raised`, `-overlay`, `-sunken`                       | `surface.*`                  |
| `text-strong`, `-default`, `-muted`, `-subtle`                            | `text.*`                     |
| `border-subtle`, `-strong`                                                | `border.*`                   |
| `bg-accent-solid`, `text-accent-fg`, `text-accent-on`, `bg-accent-subtle` | the current section's accent |
| `text-success-fg`, `bg-warning-subtle`, …                                 | `status.*`                   |
| `bg-signed-solid`, `text-signed-on`, `border-signed-border`               | `signed.*`                   |

If BRAND.md lands different utility names, a one-file alias layer (`ui/theme.css`) maps them, and
no component changes. ADMIN.md §0.3 has the full consumption contract.

**Accent scoping.** `accent-*` utilities always resolve to the nearest `[data-service]` ancestor's
family. The shell sets it on the content root and on each sidebar group. A component never names a
service color directly. The exception is `ServiceBadge`, which sets its own `data-service`.

**Refs.** React 19: `ref` is a plain prop, and no component uses `forwardRef`.

**Interactive minimums.**

- Hit target ≥ 32×32 px (36 px on touch, via `@media (pointer: coarse)`).
- Every icon-only control has an accessible name and a visible tooltip.

**Motion.** Brand `duration.*` and `easing.*` only. These collapse under `prefers-reduced-motion`
in the brand CSS.

**Type.** Rubik has 400 and 700 only, with `font-synthesis: none`:

- Body, table and control text: 400.
- Headings, the page title, table header labels and the active nav item: 700.
- Never `font-medium` or `font-semibold`. A codemod in chunk 1 rewrites the 181 existing uses to
  400 or 700 per role.
- Numbers in tables use `tabular-nums`. Code, hashes, keys and ids use the platform mono stack.

---

## 1. Shell components

### 1.1 `AppShell`

```tsx
<AppShell
  topBar={<TopBar />}
  sidebar={<Sidebar sections={visibleSections} />}
  section={section} // ServiceId | "core"; drives data-service + the section bit
>
  {page}
</AppShell>
```

**Layout.**

- A CSS grid with `grid-template-columns: var(--sidebar-w) 1fr` and `height: 100dvh`.
- The sidebar and the main column scroll independently (fixes SH-3).
- `--sidebar-w`: 15rem expanded, 3.5rem collapsed (persisted per viewer in `localStorage`).
- Content max width is 80rem for most templates; the matrix and editor templates go full-bleed.

**Breakpoints:**

| Width     | Sidebar                                                   |
| --------- | --------------------------------------------------------- |
| ≥ 1280    | expanded                                                  |
| 1024–1279 | collapsed (icons with tooltips), expandable as an overlay |
| < 1024    | hidden; opened as a `Drawer` from the top-bar menu button |

**a11y.**

- Landmarks: `header` (top bar), `nav[aria-label="Product"]` (sidebar), `main#content`.
- A "Skip to content" link is the first focusable element.
- The mobile drawer is a real modal: focus trap, Escape closes, the background is `inert`, scroll
  is locked, and focus returns to the menu button (fixes SH-2).

### 1.2 `TopBar`

```tsx
<TopBar>
  <BrandBlock section={section} />{" "}
  {/* Pinned K + section bit + "Polaris Key" */}
  <ProductSwitcher /> {/* only when a product is in scope */}
  <EnvironmentBadge /> {/* hidden in production */}
  <CommandTrigger /> {/* "Search or jump to…  ⌘K" */}
  <TopBarActions>
    <HelpLink /> {/* docs for this page; label "Docs" */}
    <ThemeMenu />
    <UserMenu />
  </TopBarActions>
</TopBar>
```

**Height.** 56 px, plus `env(safe-area-inset-top)`.

**Background.** `surface.page` at 88 % with a backdrop blur. Under
`prefers-reduced-transparency` it is opaque `surface.raised`.

**`BrandBlock`.**

- Renders `<SectionMark section={section} size={28} />` and the compact wordmark at ≥ 640 px.
- It is a link to `#/` (Home), labelled "Polaris Key home".
- **The section bit.** The K's terminal bit takes the section accent's `solid` in a service
  section; on core and platform pages the K has no bit at all (BRAND.md §6, owner decision
  2026-10-03, superseding the earlier gold-on-core rule).
  - The brand package draws this. ADMIN only passes `section`.
  - The bit changes color with a `duration.base` crossfade (none under reduced motion).
  - The star never changes.
  - See ADMIN.md §2.4 and open question Q1 on the optical cut.

### 1.3 `ProductSwitcher`

```tsx
<ProductSwitcher
  products={products} // from useProducts(): slug, name, services, attention count
  current={slug}
  onSelect={(slug) => go(sameViewIn(slug))}
/>
```

- **Trigger.** A button showing the current product's name, its slug in mono, and the service dots
  (one `ServiceGlyph` per enabled service, ≤ 6). The accessible name is
  "Product: DJDL (djdl). Change product".
- **Popover.** A `Combobox` list with:
  - type-to-filter on name and slug;
  - sections "Recent" (last 5, `localStorage`) and "All products";
  - per row: name, slug, service dots, and an attention badge when `setup.nextActions` is non-empty;
  - footer actions "All products" (`#/products`) and "New product".
- **Selection.** Keeps the current page when the target product runs that service; otherwise it
  goes to the target's Overview (fixes SH-11). The rule lives in `sameViewIn(slug)` in `nav.ts`.
- **Keyboard.** `g p` opens it. Arrow keys and type-ahead work; Enter selects.

### 1.4 `Sidebar`

```tsx
<Sidebar>
  <SidebarScope /> {/* Platform links when no product */}
  {sections.map((s) => (
    <SidebarGroup
      key={s.key}
      service={s.accent}
      label={s.label}
      glyph={<ServiceGlyph id={s.accent} />}
    >
      {s.items.map((i) => (
        <SidebarItem key={i.page} to={i.route} icon={i.icon} badge={i.badge} />
      ))}
    </SidebarGroup>
  ))}
  <SidebarFooter>{/* collapse toggle, docs, build version */}</SidebarFooter>
</Sidebar>
```

**Items** are `<a href>` (via `Link`). Middle-click and open-in-new-tab work, and
`aria-current="page"` marks the active item.

**Active state:**

- a 3 px inline-start bar in `accent.solid`;
- a `bg-accent-subtle` fill;
- label weight 700.

**Group labels.**

- Text: `text-muted`, xs, uppercase tracking.
- Glyph: `ServiceGlyph`, colored `accent.solid`.
- Distribution and Update use the Star Cut glyph; every other service uses its lucide icon.
- **Collapsed mode:** the label hides and the glyph remains as a divider with a tooltip.

**Badges.**

- A count or a dot from `useAttention()`, e.g. "3" on Edge mint when 3 recipes are pending.
- Badges are text, never color-only: `aria-label="3 pending"`.

**Platform links** (shown when no product is in scope, and always in collapsed form at the top):
Home, Products, Platform.

### 1.5 `CommandPalette`

Built on `cmdk` inside a `Dialog`.

```tsx
<CommandPalette
  sources={[
    navigationSource,
    productSource,
    entitySource(slug),
    actionSource(slug),
    themeSource,
  ]}
/>
```

**Open.** `⌘K` / `Ctrl+K`, or `/` when focus is not in a text field. Also from `CommandTrigger`.

**Sources:**

| Source                         | What it offers                                                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Navigation**                 | Every page in `SECTIONS` for the current product (filtered by enablement), plus Home, Products, Platform                                                                                                                                        |
| **Products**                   | Jump to any product                                                                                                                                                                                                                             |
| **Entities (current product)** | Licenses by name, email or id; tiers; profiles; releases by version; deliverables; devices by id prefix (calls `GET …/devices?q=`, debounced 200 ms); catalog keys. Entities come from the query cache first, then fetch when the cache is cold |
| **Actions**                    | Create license, New profile, New tier, Publish catalog, Resync from repo, Prepare signing key, Set secret, Toggle theme, Sign out. Each action names its section, and destructive actions are never offered                                     |

**Results.**

- Grouped, each row with an icon, label, secondary text (slug or kind) and a shortcut hint.
- Recent commands are pinned first.

**a11y.** The `cmdk` combobox pattern, with the input labelled "Search or jump to". A live region
announces the result count.

### 1.6 `PageHeader`

```tsx
<PageHeader
  eyebrow={<Breadcrumbs items={[{ label: "Licenses", to: r.licenses() }, { label: license.name }]} />}
  title={license.name}
  titleAside={<StatusPill status={licenseState(license)} />}
  description="Licensed to ada@example.com · created 3 Sep 2026"
  meta={<SourceBadge source="admin" />}
  primaryAction={<Button>Mint key</Button>}
  secondaryActions={[{ label: "Edit", onSelect }, { label: "Offline bundle…", onSelect }]}
  dangerActions={[{ label: "Disable license…", onSelect }]}
  tabs={<PageTabs value={tab} items={[...]} />}
/>
```

**Title.**

- The one `<h1>` on the page, 2xl/700. The top bar carries none (fixes SH-12).
- `document.title` becomes `"{title} · {product} · Polaris Key"`.

**Actions.**

- One primary action at most.
- Secondary actions show inline up to 2, then overflow into an `ActionMenu` labelled "More
  actions".
- Danger actions always sit at the bottom of the overflow menu, after a separator, styled danger.

**Responsive.** Below 640 px the actions collapse into the overflow menu, except the primary action,
which stays as a full-width button under the title.

**Sticky mode.** On scroll, a 48 px condensed bar (title and primary action) pins under the top bar
for `record` and `editor` templates.

### 1.7 `PageTabs`

```tsx
<PageTabs value={tab} onChange={setTab} items={[{ value: "policy", label: "Policy", count?: 3, dirty?: true }]} />
```

- Underline style. Each tab is a `Link`, so the tab is in the URL (`/licenses/:id/keys`), which
  fixes LDT-4.
- Panels stay mounted while dirty (`forceMount` when `dirty`).
- Switching away from a dirty tab is allowed; the dirty dot stays.
- **a11y.** WAI-ARIA tabs when the tabs are panels; `nav` with `aria-current` when they are routes.
  Route tabs are the default.

### 1.8 `Breadcrumbs`

`nav[aria-label="Breadcrumb"]` with an `ol`; the last item has `aria-current="page"`. Shown only on
detail, editor and wizard pages, and it replaces `BackLink` (2 copies today).

---

## 2. Actions

### 2.1 `Button`

```tsx
type ButtonProps = {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger" | "link";
  size?: "xs" | "sm" | "md" | "lg";
  loading?: boolean; // implies disabled; never overridable (fixes UI-1)
  disabledReason?: string; // renders the button aria-disabled + focusable, with a tooltip (fixes UI-2)
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  type?: "button" | "submit" | "reset"; // defaults to "button" (fixes UI-3)
  asChild?: boolean; // honours loading/disabled by aria-disabled + click guard
} & ComponentProps<"button">;
```

- `primary` uses `accent.solid` / `accent.on`, so a button inside the License section is
  chartreuse.
- `danger` uses `status.danger`.
- `loading` keeps the label, swaps `iconStart` for a spinner, and sets `aria-busy`.
- **Disabled with a reason** sets `aria-disabled="true"` instead of `disabled`, so the button stays
  focusable. It shows a tooltip and links the reason with `aria-describedby`; clicking does
  nothing.
- No `pointer-events:none` anywhere.

### 2.2 `IconButton`

```tsx
<IconButton label="Copy public key" icon={<Copy />} onClick={...} />
```

`label` is required. It becomes both the `aria-label` and a tooltip.

### 2.3 `ActionMenu` (kebab and overflow)

```tsx
<ActionMenu label="Actions for release 2.4.0" items={[
  { label: "Promote to stable…", onSelect },
  { type: "separator" },
  { label: "Yank…", onSelect, tone: "danger", disabledReason?: "Already yanked" },
]} />
```

- Disabled items stay visible with their reason as a secondary line, not hidden.
- Destructive items come last, after a separator.

### 2.4 `CopyButton` / `useCopy`

```tsx
const { copy, state } = useCopy(); // state: "idle" | "copied" | "failed"
<CopyButton value={publicKey} label="Copy public key" />;
```

- Announces "Copied" via the live region.
- **On failure** (no clipboard permission) it selects the text and announces "Press ⌘C to copy",
  instead of failing silently (fixes RBD-2).

---

## 3. Forms

The form layer is `react-hook-form` (open question Q3) wrapped in three components, so views never
touch the library directly.

### 3.1 `Form`, `useAdminForm`

```tsx
const form = useAdminForm<LicensePolicy>({
  values: serverValues,     // re-seeds ONLY when not dirty (fixes MPE-1, UPS-2, UHL-4)
  resetOn: [license.modifiedAt], // explicit identity for "server changed under you"
  onSubmit: (v) => mutate(diff(serverValues, v)),
  mapServerErrors: apiErrorToFields, // ApiError.fields → field errors
});
<Form form={form}>{...}<SaveBar /></Form>
```

**Server changes under a dirty form.** When `resetOn` changes while the form is dirty, the form is
not re-seeded. Instead a `Callout` appears: "This license changed while you were editing.
**Review changes** / **Discard mine**". The diff opens in a `Drawer`.

**`diff`** produces the minimal PATCH body, with `null` for cleared nullable fields. This fixes
TIR-1, LDT-2 and PRD-6 at the client. The worker must also accept `null`; see ADMIN.md §7.3, A-3.

### 3.2 `FormField`

```tsx
<FormField name="maxOfflineDays" label="Max offline days" help="Blank uses the product default (30)." required?>
  {(field) => <NumberInput {...field} nullable min={1} max={365} />}
</FormField>
```

- A render prop hands `id`, `aria-describedby`, `aria-invalid` and `aria-required` to any control,
  including Radix Select via its trigger. This fixes UI-6 and SCF-1.
- **Required** is shown by the text "Required" after the label (`text-subtle`, xs), never by a bare
  red asterisk.
- The error is shown under the control with an icon. It uses `role="alert"` only when it appears
  after submit, not on each keystroke.
- A per-field **dirty marker** (a 6 px accent dot plus sr-only "changed") appears beside the label
  when the value differs from the server's.

### 3.3 Controls

| Control              | Notes                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Input`              | Prefix and suffix slots, a clear button (`clearable`), `mono` flag.                                                                                                                                  |
| `NumberInput`        | `nullable`: empty ⇒ `null`, never `0` (fixes UHL-4, TIR-1). `unit` suffix. `percent` mode stores a fraction and shows % (fixes UHL-5).                                                               |
| `Textarea`           | Sans by default; `mono` opt-in (today it is always mono). Auto-grow.                                                                                                                                 |
| `Select`             | Radix; accepts `id` on the trigger. `allowEmpty` with an explicit "None" option instead of sentinel strings. Option `description` line (replaces the legend `dl`, UPS-7).                            |
| `Combobox`           | Searchable single or multi select, used for releases (PAD-2: version + channel + date per option), tiers, profiles and outlets.                                                                      |
| `OrderedMultiSelect` | Chosen items as a numbered, reorderable list (drag handle plus keyboard ↑/↓ buttons), with available items in a combobox. Used for license profiles, where order is precedence (fixes LIC-3, LDT-3). |
| `Checkbox`, `Switch` | Take `label` and `description`, so a separate Label is never needed. `Switch` is for immediate or form-local booleans, never as the only control for a confirmed destructive action (LDT-7).         |
| `RadioCards`         | Mutually exclusive choices with descriptions: access modes, registration policy, fingerprint mode.                                                                                                   |
| `SegmentedControl`   | 2–4 short options: table density, the time window on Update health, Matrix view mode.                                                                                                                |
| `DateInput`          | A calendar date in the **operator's local zone**, stored as end-of-day local → epoch. Always shows the resolved instant ("expires 30 Sep 2026, 23:59 CEST"). Fixes LIC-5.                            |
| `VersionInput`       | Validates with the same dotted/semver rule the server uses (shared helper in `lib/version.ts`, replacing 2 `compareDottedVersion` copies). `min`/`max` cross-field validation.                       |
| `ChannelPicker`      | A checkbox group over `channelOptions()`, with channel semantics as descriptions (stable, beta, pr = "every PR build", dev = "bypass").                                                              |
| `SecretInput`        | Password field with Reveal (`aria-pressed`) and an "overwrite" confirmation when `configured` is true (SEC-3).                                                                                       |
| `CodeEditor` (lazy)  | CodeMirror 6 (JSON and YAML, line numbers, lint markers from a validator, format). Loaded only by the catalog and payload JSON editors, so it stays out of the main bundle.                          |

### 3.4 `SaveBar`

```tsx
<SaveBar
  form={form}
  saveLabel="Save policy"
  discardLabel="Discard"
  summary="3 changes"
/>
```

**When.** Appears when the form is dirty: sticky to the bottom of the content column, with
`env(safe-area-inset-bottom)` (fixes MPE-5).

**Contents:**

- the change summary (a count, plus "Review" opening a diff drawer for editor templates);
- Discard (ghost);
- Save (primary).

**Keyboard.** `⌘S` saves and `Esc`, from the bar, discards after a confirm.

**While saving.** Save shows `loading` and inputs are `readOnly`.

**On error.** The bar stays, the error summary shows inline, and focus moves to the first invalid
field.

### 3.5 `useUnsavedChangesGuard`

```tsx
useUnsavedChangesGuard(form.isDirty, {
  message: "Discard unsaved changes to this license?",
});
```

- Registers with the router's blocker (ADMIN.md §2.6) and with `beforeunload`.
- Route changes, product switches and tab changes away from a mounted dirty panel prompt with a
  `ConfirmDialog` offering "Keep editing" / "Discard".
- Fixes SH-6, LDT-4, PRF-6 and the MPE guard gap.

---

## 4. Overlays

### 4.1 `Dialog`

```tsx
<Dialog
  open
  onOpenChange
  size="sm|md|lg|xl"
  title
  description
  dismissible={!busy}
>
  <DialogBody>…</DialogBody>
  <DialogFooter>…</DialogFooter>
</Dialog>
```

- **Sizes:** sm 24rem, md 32rem, lg 44rem, xl 60rem.
- **Below 640 px** every dialog is a bottom sheet (full width, max 92dvh, drag handle,
  safe-area padded).
- `dismissible={false}` blocks Escape **and** outside-click while busy (fixes UI-10).
- There is one footer component.
- **Focus.** It moves to the first field, or to the least destructive button (Cancel) for confirms. On close it returns
  to the invoker.
- **A body that overflows** joins the tab order as a region named by the dialog's title.

### 4.2 `ConfirmDialog`

```tsx
<ConfirmDialog
  intent="neutral" | "caution" | "danger"
  title="Disable license?"
  consequences={["Every device loses access at its next check-in.", "Keys stay valid and can be re-enabled."]}
  confirmLabel="Disable license"
  typedConfirmation={{ value: "djdl", label: "Type the product slug to confirm" }} // optional
  onConfirm={async () => …}
/>
```

- `intent` defaults to `neutral`. `danger` styles the confirm button danger and leads the body with
  a `status.danger` icon.
- `consequences` is a list: each effect gets its own line, never one paragraph.
- **`typedConfirmation`** keeps the confirm button `aria-disabled` until the input matches exactly.
  The input is labelled; paste is allowed.
  - The value typed is what the client sends where the API has a confirm field (product delete's
    `confirmSlug`). This fixes UI-10 and PRD-4.
- **Errors keep the dialog open**, with the message inline under the consequences, and Retry
  available (fixes EMR-3).
- The confirm button's label repeats the verb ("Disable license"), never "Confirm" or "OK".

### 4.3 `Drawer` (sheet)

```tsx
<Drawer side="end" size="md|lg" title description route?="devices/:id" open onOpenChange>
  <DrawerBody />
  <DrawerFooter />
</Drawer>
```

- Side panel for peek, detail and secondary forms. Replaces the restyled Dialog (DEV-2).
- **Routed drawers** put their id in the URL (`#/p/djdl/devices/dev_123`), so a device drawer is
  linkable and Back closes it.
- **Below 1024 px** it becomes full-screen with a back button.
- Same focus contract as `Dialog`; non-modal is not offered.

### 4.4 `OneTimeSecretPanel`

```tsx
<OneTimeSecretPanel
  label="License key"
  value={key}
  hint="Shown once. Polaris Key stores only its hash."
  onDone={…}
/>
```

- Used for license keys, CI tokens, outlet-generated secrets and minted bundles.
- **The parent dialog becomes non-dismissible** until either Copy has been pressed, or the operator
  ticks "I've stored this key". Done is disabled until then.
- Escape and the X close button ask "Close without copying? The key cannot be shown again." This
  fixes LIC-2.
- A Download button is offered for bundles (`.pkeybundle`). If `URL.createObjectURL` is unavailable
  it falls back to a data URL, and on failure it says so instead of doing nothing (fixes LDT-13).

### 4.5 `Tooltip`, `Popover`

- `Tooltip` is for labels and short explanations only. It is never the only home of data: anything
  an operator needs (a failure reason, a blocker, a hash) goes in visible text, a `Popover` or a
  drawer.
- `Popover` is click-opened, focusable and keyboard-dismissable. It is used for matrix cell details
  on hover-less devices and for "why" explanations.

---

## 5. Feedback

### 5.1 Toasts

Built on `sonner`.

```tsx
toast.success("License disabled", {
  action: { label: "Undo", onClick: reEnable },
});
toast.error(apiError); // ApiError → title + description via errorCopy(), never "api 422"
```

- **Placement.** Bottom-end on desktop, top on phones.
- **Durations:**

  | Variant       | Duration                                 |
  | ------------- | ---------------------------------------- |
  | success, info | 4 s                                      |
  | warning       | 8 s                                      |
  | error         | persistent until dismissed (fixes UI-11) |

- Max 3 visible. Identical toasts dedupe by key.
- **Undo action** is offered only where a safe inverse exists: re-enable a disabled license,
  unyank a yank, resume a pause. Deauthorize and revoke have no inverse, so they get no Undo.
- **Rule:** a toast confirms an action that happened. Validation and form errors are inline, never
  toast-only (fixes CAT-6 duplication).

### 5.2 `Callout`

```tsx
<Callout tone="info|success|warning|danger|signed" title action?>…</Callout>
```

- A `subtle` background, `border` outline, an icon and the tone's `fg` title.
- **`signed`** uses gold: "Signed by release key rk-2026-09".
- `role="status"` for dynamic callouts. Static explanatory callouts get no role (fixes EMR-2).

### 5.3 Loading

- **`PageSkeleton`** per template (table, record, form, matrix, dashboard), matching the real layout.
- One polite live region per page announces "Loading licenses…" and then "Licenses loaded". This
  fixes UI-13.
- **Background refetch** shows a 2 px indeterminate progress line under the page header after
  400 ms, and never replaces content.

### 5.4 `EmptyState`

```tsx
<EmptyState
  kind="first-run" | "no-results" | "service-off" | "not-found" | "error"
  title description
  primaryAction secondaryAction docs="…"
/>
```

- **`first-run`** shows the **stationary star motif**: the kit's star glyph, never rotated or
  animated, in `text-subtle`, 48 px, with a faint `border.subtle` "guide" circle. The copy says what
  the object is and why you'd create one.
- **`no-results`** has no illustration. It shows "No licenses match **status: expired**" plus
  **Clear filters**.
- **`service-off`** names the service, uses its `ServiceGlyph` in its accent, and offers **Enable
  {Service}** (opens Services with that row highlighted) plus a docs link.
- **`error`** is `ErrorState` (§5.5), never this component with a warning icon (fixes UI-14).

### 5.5 `ErrorState` and `errorCopy`

```tsx
<ErrorState error={apiError} onRetry={refetch} />
```

`errorCopy(error, context)` maps an `ApiError` (status, code, reason, errors, fields) to a title,
description and next step. ADMIN.md §5.9 has the tables.

- An unknown code falls back to "The server refused this ({status} {code})." plus a "Copy details"
  button that copies a JSON blob (status, code, reason, path, time) for a support report.

---

## 6. Data display

### 6.1 `DataTable`

Built on TanStack Table v8, with TanStack Virtual above 200 rows.

```tsx
<DataTable
  id="licenses"                            // namespaces URL + persisted column prefs
  data={rows}
  columns={columns}                        // ColumnDef with meta: { priority: 1|2|3, align, mono, numeric }
  getRowId={(r) => r.id}
  state={tableState}                       // from useTableUrlState("licenses"): sort, filters, q, page/cursor, columns
  onStateChange={setTableState}
  facets={[{ id: "status", label: "Status", options: [...] }, { id: "tier", ... }]}
  search={{ placeholder: "Search name, email or id", columns: ["name", "email", "id"] }}
  selection={{ mode: "multi", bulkActions: [{ label: "Disable…", tone: "danger", onSelect }] }}
  rowHref={(r) => r.licenseUrl}            // the primary cell renders as a Link; no role=button rows
  rowActions={(r) => [...]}                // trailing ActionMenu
  pagination={{ mode: "client" | "cursor" | "offset", pageSize: 50, onLoadMore?, total? }}
  density={density}                        // "comfortable" | "compact", persisted per viewer
  loading error onRetry
  empty={<EmptyState kind="first-run" … />}
  mobile="cards" | "scroll"                // cards: priority-1 columns as a stacked card list < 768px
/>
```

**Feature set:**

| Feature           | Behavior                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sorting           | Header button with `aria-sort`; multi-sort with Shift. Client or server per column                                                                                                                                                                                       |
| Search            | Debounced 150 ms; written to the URL `q`                                                                                                                                                                                                                                 |
| Facets            | Popover multi-select chips in a `FilterBar`, each shown as a removable chip ("Status: expired ×"). Counts per option when computable client-side                                                                                                                         |
| Column visibility | A "Columns" menu; persisted in `localStorage` per table id. Priority-3 columns are hidden by default below 1280 px                                                                                                                                                       |
| Selection         | A checkbox column with a header tri-state. A bulk-action bar replaces the FilterBar while rows are selected ("3 selected · Disable… · Clear"). Selection persists across pages only in cursor mode with an explicit "Select all N matching" (only when `total` is known) |
| Pagination        | `client` (virtualized, no pager), `cursor` ("Load more" plus "Showing 150"), `offset` (pager with page size)                                                                                                                                                             |
| Sticky header     | Sticky header and sticky first column on horizontal scroll                                                                                                                                                                                                               |
| Rows              | **The row is not a button.** The primary cell holds a real link; a click elsewhere on the row (not on a control) follows `rowHref` as a pointer-only enhancement. Keyboard users use the link. This fixes UI-12 and PRD-2                                                |
| States            | loading (skeleton rows matching the columns), `error` (inline `ErrorState` in the body), `empty` (first-run), filtered empty (`no-results` with Clear filters)                                                                                                           |
| a11y              | Native `<table>`, `<th scope>`, `caption` (sr-only, the table's label), live-region row count after filtering                                                                                                                                                            |

### 6.2 `FilterBar`

```tsx
<FilterBar search facets dateRange? actions={<Button>Export CSV</Button>} />
```

- Every filter value lives in the URL (`?status=expired&tier=pro&q=ada`). Back restores the filters.
- An "Export CSV" action is available on any client-mode table; it exports visible columns and the
  filtered rows.

### 6.3 `DescriptionList`

```tsx
<DescriptionList columns={1|2|3} items={[{ term: "Tier", detail: <EntityLink kind="tier" id="pro" />, help?: "…" }]} />
```

A `<dl>` grid that collapses to one column below 640 px. It replaces 4 hand-rolled copies.

### 6.4 `StatusPill`

```tsx
<StatusPill status="active" />  // vocabulary-driven
<StatusPill tone="warning" icon={<Clock />}>Expires in 3 days</StatusPill>
```

- Always an icon (or dot) **plus** text, so color is never alone.
- A central vocabulary `lib/status.ts` maps every server state to `{label, tone, icon}`, replacing
  the 5+ local maps (MTX-4, REL-6, CAT-9).

**Vocabulary (one table):**

| Domain       | Mapping                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| License      | `active`→success "Active"; `expired`→warning "Expired" (computed from `expiresAt`); `disabled`→neutral "Disabled"                                      |
| Key          | `active`→success; `revoked`→neutral "Revoked"                                                                                                          |
| Device       | `authorized`→success; `deauthorized`→neutral; fingerprint `verified`→success; `unverified`→warning; `drifted`→warning "Drifted"                        |
| Rollout      | `active`→accent "Rolling out 25 %"; `paused`→warning; `halted`→danger; `complete`→success                                                              |
| Availability | `live`→success; `approved`→info; `in-review`/`processing`/`pending`→neutral with a clock icon; `rejected`→danger; `removed`→neutral                    |
| Readiness    | holds→warning "Held"; warning→warning "Not ready"; ok→success "Ready"                                                                                  |
| Compat cell  | `pinned`→accent "Pinned"; `compatible`→success; `held`→warning; `incompatible`→danger; `revoked`→danger; `current`→outline ring **and** "Current" text |
| Edge mint    | `approved`→success; `pending`→warning "Needs approval"; `changed`→danger "Changed since approval" (distinct from pending; fixes EMR-2)                 |
| Secrets      | `configured`→success; `missing`→warning with an icon                                                                                                   |
| Source       | `manifest`→neutral "From manifest"; `admin`→info "Set in console"                                                                                      |

### 6.5 `SignedBadge` and gold

```tsx
<SignedBadge by="release key" kid="rk-2026-09" /> // ◆ gold glyph + "Signed · rk-2026-09"
```

**Gold means signed, and nothing else.** It marks:

- signing keys (product Ed25519 keys, CI release keys, delegated content keys);
- signed records (a release record, a pack release's signer, a signed entitlement gate);
- verified signatures (Sparkle signature present, a pack release record verified).

**Rendering:**

- The badge is a `signed.solid` glyph (the K's bit shape as a 10 px rhombus, supplied by the brand
  package as `SignedGlyph`) beside `text-default` label text.
- A chip variant uses a `signed.solid` fill with `signed.on` text.
- Gold is never body text, never a warning, never a "premium" marker.

### 6.6 `ServiceBadge`, `ServiceGlyph`, `SourceBadge`

- **`ServiceGlyph id`.** The Star Cut mark for `distribution` and `update` (service cut, 16 or
  24 px, from the brand package). The lucide icon for the others. Colored `accent.solid` via its
  own `data-service`.
- **`ServiceBadge id`.** The glyph plus the label, used in the product switcher, Services and the
  dashboard.
- **`SourceBadge source manifest|admin`.** One implementation (replaces 3). It carries a
  `Popover` explaining:
  - "Set in console: survives a resync. **Revert to manifest** hands it back."
  - "From manifest: the next resync re-applies `.pkey/…`."

### 6.7 `CodeBlock`, `JsonViewer`

```tsx
<CodeBlock language="ts" code={snippet} copy filename="polaris.ts" />
<JsonViewer value={trustSet} collapsedDepth={2} copy />
```

- `CodeBlock` uses static highlighting (a tiny tokenizer for json, ts, sh, toml; no runtime
  library), a copy button, wrap toggle and line numbers.
- `JsonViewer` renders a collapsible tree with copy-path and copy-value, keyboard navigable as a
  `tree`. Large values are virtualized.

### 6.8 `DiffViewer`

```tsx
<DiffViewer
  mode="structured" | "text"
  before={activeCatalog} after={draftCatalog}
  structure={catalogDiffModel}   // keyed by entry.key → added / removed / changed fields
/>
```

- **`structured`** groups changes by entry:
  - **Added** (success), **Removed** (danger, with a "breaking" warning when the key is referenced by
    any profile or license override), **Changed** (field-level before → after).
  - A summary header: "+2 keys · −1 key · 3 changed".
- **`text`** is a unified or split line diff (jsdiff), used for JSON and YAML drafts and for
  resync previews.
- **a11y.** Every change row has a text prefix ("Added", "Removed"), never color alone.

### 6.9 `KeyDisplay`, `Hash`, `IdChip`

```tsx
<KeyDisplay label="Public key" value={pub} kind="public" />          // full value, wrap, copy
<KeyDisplay label="Webhook secret" kind="secret" configured updatedAt /> // never a value: "Configured · 3 Sep"
<Hash value={sha256} chars={12} />  // "3f9a1c…8d02" + copy; full value in a Popover, never only `title`
<IdChip value={licenseId} />        // mono, truncated middle, copy
```

- **Reveal** exists only for values the client legitimately holds: a one-time key in
  `OneTimeSecretPanel`, and a secret being typed into `SecretInput`. Stored secrets are write-only
  by design and have no reveal.
- `KeyDisplay kind="signing"` adds `SignedBadge` and the key's status (staged, active, retired,
  revoked).

### 6.10 `Timestamp`, `Duration`, `Version`

- `<Timestamp at={ms} format="relative|absolute|date" />` renders `<time dateTime>`, shows relative
  ("3 h ago") with the absolute value as visible secondary text on detail pages, and in a tooltip on
  tables. It is **not** focusable (fixes ACT-4); the table cell carries the absolute value in an
  sr-only span.
- `<Duration ms />`: "in 2 days", "for 14 days".
- `<Version value="2.4.0" yanked? channel? />`: mono, with a line-through **and** a "Yanked" pill
  when yanked.

### 6.11 `EntityLink`

```tsx
<EntityLink kind="license" id={id} label={name ?? id} />
```

- Typed links to every entity route: license, tier, profile, release, deliverable, pack release,
  device (opens the drawer route), catalog key, outlet, rollout (opens the matrix cell).
- Used wherever an id is shown. This fixes DEV-1, ACT-2, UHL-6, PKD-8 and TIR-9.

### 6.12 `Timeline`

```tsx
<Timeline
  items={events}
  groupBy="day"
  renderItem={(e) => <ActivityItem e={e} />}
  loadMore
/>
```

- A vertical list with day separators.
- Each item: actor avatar (initials) or a system glyph for runtime rows, a verb phrase ("**Ada**
  disabled license **Studio Pro**"), a target `EntityLink`, a timestamp and an expandable summary.
- Used by Activity, the license and profile "History" panels (filtered views of Activity), and
  rollout history in the matrix drawer.
- **a11y.** An `ol` with `aria-label`; each day is a group heading.

### 6.13 Charts

Hand-rolled SVG, no chart library. All charts follow the repo's `dataviz` guidance:

- direct labels instead of legends where possible;
- a data table toggle ("Show as table") on every chart;
- colors from status and accent tokens only;
- validated in both themes.

| Component   | Use                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `StatTile`  | A KPI: label, value (tabular, 2xl/700), delta or secondary text, optional `Sparkline`, optional link. Replaces StatCard and MetricCard.                                                                                        |
| `Sparkline` | Inline 80×24 trend: devices seen per day, activations. `aria-hidden` with the value in text beside it.                                                                                                                         |
| `Meter`     | Seat usage "3 of 5", rollout progress (bp → %), storage. A `role="meter"` with `aria-valuenow`.                                                                                                                                |
| `Funnel`    | Update-health funnel: offered → downloaded → applied → confirmed, with step conversion % on the connectors and revert or rollback as a separate danger bar. A `figure` with a `figcaption` and the table toggle (fixes UHL-1). |
| `BarList`   | Horizontal bars with labels: devices by platform, app version, SDK (uses DEV-4's unused summary fields).                                                                                                                       |

### 6.14 `Grid` (matrix primitive)

```tsx
<Grid
  label="Distribution matrix: releases by outlet"
  rows={releases} columns={outlets}
  rowHeader={(r) => <ReleaseRowHeader r={r} />}
  columnHeader={(c) => <OutletHeader c={c} />}
  cell={(r, c) => <MatrixCell … />}
  onCellActivate={(r, c) => openDrawer(r, c)}
  stickyRowHeader stickyColumnHeader
/>
```

- The WAI-ARIA `grid` pattern: one tab stop, arrow keys move, Home/End go to row ends,
  Ctrl+Home/End go to the corners, Enter or Space activates.
- Each cell's accessible name is the full sentence ("2.4.0 on App Store: Live, rolling out 25 %,
  held: pack textures 1.3 incompatible").
- Cells are compact glyph-plus-label summaries. Detail goes to a `Drawer`, never to `title` (fixes
  MTX-1, MTX-3, CMP-2).
- Shared by the Distribution matrix and the Compatibility matrix.

### 6.15 `Stepper`

```tsx
<Stepper steps={[{ id: "basics", label: "Basics" }, …]} current="catalog" onStep />
```

- Used by the wizard template (create product, create license, link repo).
- An `ol` with `aria-current="step"`. Completed steps are links; future steps are disabled with a
  reason.

---

## 7. Data and routing hooks (not visual, but part of the system)

| Hook                                | Purpose                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `useMe()`                           | TanStack Query `["me"]`. Invalidated by product create and delete (fixes SH-1).                                                                                                |
| `useProducts()`, `useProduct(slug)` | One query each (the five inline fetchers collapse into this). `useProduct` reads `["products"]` as initial data.                                                               |
| `queries.ts`                        | Every query key and fetcher in one module, typed: `qk.license(slug, id)` etc.                                                                                                  |
| `mutations.ts`                      | Every mutation with its **invalidation set** declared beside it (table in ADMIN.md §5.4). A test asserts each mutation declares one (fixes CC-1 to CC-4).                      |
| `useTableUrlState(id)`              | Reads and writes a table's sort, filters, search and cursor from the hash query.                                                                                               |
| `useSearchParam(name, codec)`       | Typed hash-query params for page-level state (tab, window, deliverable, drawer id).                                                                                            |
| `useAttention(slug)`                | Derives sidebar badges and the overview's attention list from already-cached queries (setup, mint recipes, readiness holds, Sentry candidates, expiring licenses). No new API. |
| `useShortcut(keys, handler, opts)`  | Registers a shortcut with the global help sheet (`?`); suppressed in text inputs.                                                                                              |
