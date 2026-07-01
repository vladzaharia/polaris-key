# Polaris Brand Rollout — Design Spec

- **Date:** 2026-06-30
- **Status:** Approved (design); implementation plan pending (`writing-plans`)
- **Scope:** Roll the `@vladzaharia/polaris-brand` system across every user-visible Polaris Key surface.

## 1. Context & Motivation

Polaris Key is a pre-launch, multi-product licensing + remote-config + release platform
(one Cloudflare Worker + SDKs + admin SPA). A locked decision in the platform overhaul is:
"Admin SPA = production rebuild on Tailwind + shadcn-style, WCAG AA, responsive, **new brand**."

That brand now exists as a productized, versioned package: `@vladzaharia/polaris-brand@1.0.0`,
published privately to GitHub Packages. It ships design tokens, MonoLisa fonts, a constellation
mark/logo SVG renderer, brand React components, and a 52-component shadcn-style UI library, all on
Tailwind v4 with a `data-theme` (mode) + `data-service` (accent) theme contract.

This effort adopts that package as the single source of truth for the platform's look and feel.
Because the platform is pre-launch, we break freely: no back-compat shims for the old admin styles,
tokens, or components.

## 2. Locked Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Adoption depth | **Full adoption** — React 19 + Tailwind v4 in admin; consume brand `styles.css` + providers; replace all local UI components + local `Logo` with brand `/ui` + `/brand`. |
| D2 | Consumption method | **GitHub Packages only** — install published `@vladzaharia/polaris-brand@1.0.0` everywhere; requires `@vladzaharia` registry line + `GITHUB_PACKAGES_TOKEN` (local + CI). No local link, no vendoring. |
| D3 | Effort scope | **All three phases planned now**, executed phase-by-phase, each green before the next. |
| D4 | Service accent | **Both SPAs `data-service="key"`.** Managed-product switching is a separate concept from brand service. |
| D5 | React 19 bump width | **Admin package only.** `sdk-react` keeps its broad peer range (>=18) for customer compatibility. |
| D6 | Uncommitted MonoLisa work | **Revert it** (`monolisa.css`, `public/fonts/`, `styles.css` + `tailwind.config.ts` font edits). The brand `styles.css` bundles MonoLisa. |
| D7 | Retire local components | **Delete all 21 hand-built admin UI components + local `Logo`**; do not keep any. |
| D8 | Managed-product switcher | **Stays app-owned** (rendered with brand `Select`/`DropdownMenu`); not the brand `ProductSwitcher`. |
| D9 | SDK default theming | **Generate `sdk-react` theme defaults from `@vladzaharia/polaris-brand/tokens`** (W3C JSON) via a build/dev script; no runtime dependency on the brand package. |

## 3. Current-State Facts (verified)

**`packages/admin`** — the only frontend package; builds two SPAs from one Vite project:
- Entries: `manage.html` → `src/main.tsx` → operator console; `index.html` → `src/portal/main.tsx` → customer portal.
- Stack: React `^18.3.1`, **Tailwind `^3.4.17`** (JS `tailwind.config.ts` + `postcss.config.js` + autoprefixer), Vite 6, `@vitejs/plugin-react`.
- Tokens: `--pk-*` HSL CSS vars in `src/styles.css`, aliased in `tailwind.config.ts` via `hsl(var(--pk-*))`; utilities like `bg-primary`, `text-primary-foreground`, `bg-card`, `bg-popover`, `border-border`.
- Theme: local `src/components/theme.tsx` toggles `.dark`/`.light` class on `<html>`, persists to `pk-admin-theme`.
- Components: 21 hand-built shadcn-style components on Radix under `src/components/ui/`, plus local `src/components/brand/Logo.tsx`, `src/components/Shell.tsx`.
- Uncommitted brand-ish work (to be reverted per D6): `src/monolisa.css` (1135-line `@font-face`), `public/fonts/`, font edits in `src/styles.css` + `tailwind.config.ts`.
- Views: ~13 manage views (`Dashboard`, `Products`, `ProductOverview`, `Licenses`, `LicenseDetail`, `Catalog`, `Tiers`, `Profiles`, `Releases`, `Oidc`, `Activity`, `Secrets`, `Settings`) + subdirs; 5 portal views (`Dashboard`, `Licenses`, `LicenseDetail`, `Downloads`, `Profile`). Hash routing (`src/route.ts`), no router lib.

**`packages/worker`** — Cloudflare Worker renders standalone HTML:
- SPA shells: `src/portal/index.ts`, `src/admin/index.ts` (minimal `<div id="root">` + script).
- OIDC device-verify screen: `src/oidc.ts` (~530–546), hand-written HTML + inline styles.
- Auth error pages: `htmlError()` in `src/portal/auth.ts` and `src/admin/auth.ts`.
- Emails: `src/portal/email.ts` (magic-link + notice).
- Appcast XML: `src/release/appcast.ts` (machine-readable; out of scope).

**`packages/sdk-react`** — embedded in customers' apps; `PolarisLogin`/`LicenseGate`/`PolarisLogout`, themeable via `components/theme.ts` defaults.

**Repo plumbing:** root `.npmrc` already sets `@polaris-key:registry=https://npm.pkg.github.com`; `pnpm-workspace.yaml` = `packages/*`, `tools`, `conformance/runners/node`, `products`. The brand repo lives outside this workspace (`../polaris-brand`).

**Brand package consumable surface:**
- Subpaths: `.`, `/marks`, `/brand`, `/ui`, `/styles.css`, `/tokens`, `/assets/*`. React `>=19` peer.
- Theme contract: `ThemeProvider` sets `<html data-theme="dark|light">` (localStorage `polaris-theme`, default dark); `ServiceThemeProvider` sets a `[data-service]` wrapper; FOUC guard script belongs in `<head>`.
- Semantic Tailwind utilities: `bg-surface`, `bg-surface-raised`, `bg-surface-deep`, `text-foreground`, `text-muted`, `text-accent`, `border-border`, `border-soft`, `ring-accent`, `text-success|warning|danger|info`, `font-sans|mono`.
- `/marks` is plain Node ESM: `renderMark(service, opts)`, `renderLogo(service, opts)`, `services`, `serviceById`, `brandTokens` — SSR-safe, no React.
- Fonts: MonoLisa bundled into the shipped `styles.css` via `@font-face` with package-relative URLs.

## 4. Target Architecture

### Phase 0 — Package-access gate (prerequisite)
- Add `@vladzaharia:registry=https://npm.pkg.github.com` to root `.npmrc`.
- Provision `GITHUB_PACKAGES_TOKEN` (classic PAT, `read:packages`) for local installs and wire it into CI as `NODE_AUTH_TOKEN`; document in `CONTRIBUTING.md`.
- Add `@vladzaharia/polaris-brand@1.0.0` to `packages/admin`; bump admin to React 19 (`react`, `react-dom`, `@types/react`, `@types/react-dom`, testing-library).
- **Exit:** `pnpm install` resolves the package and React 19 in admin; the rest of the workspace's React 18 tree is undisturbed (explicitly verified).

### Phase 1 — Admin + customer-portal SPAs (full adoption)
- **Toolchain:** remove `postcss.config.js`, `tailwind.config.ts`, `autoprefixer`, Tailwind v3; add `@tailwindcss/vite` to `vite.config.ts`. No hand-authored Tailwind config.
- **Styles:** delete admin token layer + reverted `monolisa.css`; each entry imports `@vladzaharia/polaris-brand/styles.css` once; a minimal `app.css` only for admin-specific rules the brand doesn't cover.
- **Providers:** retire `src/components/theme.tsx` + `pk-admin-theme`; wrap both apps in brand `ThemeProvider` → `ServiceThemeProvider service="key"`; use brand `useTheme`/`ModeToggle`; migrate toasts to brand `useToast`/`Toast`.
- **HTML entries:** add brand FOUC guard to both `<head>`s; set `data-theme` default + `data-service="key"` on `<html>`; update `<title>`s; add favicon/meta.
- **Component migration (retire all 21 local + local `Logo` per D7):** rewrite view imports to `@vladzaharia/polaris-brand/ui` + `/brand`. Behavior-preserving wrappers:
  - `DataTable` — keep admin keyset-pagination hook; render via brand `DataTable`/`Pagination`/`Table`.
  - `ConfirmDialog` — rebuild on brand `AlertDialog`.
  - Managed-product switcher (D8) — app logic retained; render with brand `Select`/`DropdownMenu`.
  - `Logo`/`Mark` — brand components, `service="key"`.
  - Class/token rewrite — old→new mapping table (v3 `bg-primary`/`text-primary-foreground`/`bg-card`/`bg-popover`/… → brand `bg-surface`/`bg-surface-raised`/`text-foreground`/`text-accent`/…). Mechanical.
- **Custom v3 extras** (`pk-glow` shadow, `pk-*` animations): re-express as brand tokens or a small `@theme`/`app.css` block, or drop where superseded.
- **Verification:** `tsc` + `vitest` + `prettier` + `vite build` (both entries) green; manual browser walkthrough of manage + portal in dark **and** light.

### Phase 2 — Worker-rendered HTML + emails
- Lead-owned helper `packages/worker/src/brand/` wrapping `renderLogo("key")`/`renderMark("key")` (from `/marks`) + a shared token palette; imported by all worker surfaces.
- Shells (`portal/index.ts`, `admin/index.ts`): FOUC guard + `data-theme`/`data-service` + titles.
- OIDC device-verify (`oidc.ts`): rebrand with inline brand tokens + inline `renderMark("key")` SVG.
- Auth errors (`portal/auth.ts`, `admin/auth.ts`): shared branded `htmlError()` template.
- Emails (`portal/email.ts`): **email-safe** — inline styles, system-font fallback, accent color, raster/wordmark logo (no inline SVG, no webfonts).

### Phase 3 — sdk-react default-theme alignment
- Build/dev script generates `sdk-react` `components/theme.ts` default token values from `@vladzaharia/polaris-brand/tokens` (dev-dependency only; no runtime brand dependency, no React 19 peer).
- Existing consumer override API unchanged.

## 5. Orchestration Model

- **Lead owns (never delegated):** the `.npmrc`/token gate, provider-wiring contract, old→new class/token mapping table, worker `brand/` helper, and the component→brand mapping.
- **Fan out:** disjoint view migrations to parallel subagents (serialize same-file work).
- **Fan in:** reviewers — silent-failure-hunter, code-reviewer, type-design-analyzer, pr-test-analyzer.
- **Green gate** run between waves and between phases.

## 6. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| React 19 hoisting collides with workspace React 18 | Admin-only bump; verify `sdk-react` tree still resolves 18; add peer overrides only if pnpm force-dedupes. |
| Tailwind v4 utility gaps vs v3 (`pk-glow`, custom animations) | Re-express as brand tokens or a small `@theme` block; drop where superseded. |
| Email clients strip SVG/webfonts/`<style>` | Email is a deliberately degraded surface: color + wordmark + raster logo only. |
| GitHub Packages token missing in CI | Phase 0 wires `NODE_AUTH_TOKEN` secret; blocks install otherwise. |
| DataTable keyset-pagination parity when swapping to brand primitives | Preserve admin's keyset hook; brand primitives render-only. |

## 7. Acceptance Criteria

- Both SPAs render entirely with brand tokens/components; no `--pk-*` tokens or local `components/ui/*` remain.
- Dark + light modes correct and WCAG AA on both SPAs; `data-service="key"` accent applied; no FOUC.
- Worker OIDC screen, error pages, shells, and emails carry the brand (emails within email-safe limits).
- `sdk-react` default theme matches brand token values; override API intact.
- Full green gate per package; manual browser verification recorded.

## 8. Out of Scope

- Appcast XML styling; CLI text output.
- Monorepo-wide React 19 migration (admin only).
- New brand geometry/tokens (consume the published package as-is; changes go upstream to `polaris-brand`).
- Observability (per platform overhaul scope).
