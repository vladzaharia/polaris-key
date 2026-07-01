# Polaris Brand Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the published `@vladzaharia/polaris-brand@1.0.0` package as the single source of truth for the platform's visual identity across the admin/portal SPAs, the Worker-rendered HTML + emails, and the `sdk-react` default theme.

**Architecture:** Full adoption in `packages/admin` (React 18→19, Tailwind v3→v4 via `@tailwindcss/vite`, brand `styles.css` + `ThemeProvider`/`ServiceThemeProvider service="key"`, brand `/ui` + `/brand` components replacing the 21 hand-built ones). The Worker consumes the brand's SSR-safe `/marks` renderer (plain Node ESM) for its hand-written HTML surfaces. `sdk-react` generates its default theme tokens from `@vladzaharia/polaris-brand/tokens` at build time with no runtime dependency on the brand package.

**Tech Stack:** React 19, Tailwind v4, Vite 6, Radix UI, `@vladzaharia/polaris-brand` (GitHub Packages), Cloudflare Workers (wrangler/esbuild), pnpm workspace + turbo.

---

## Reference: locked decisions (from the design spec)

Spec: `docs/superpowers/specs/2026-06-30-polaris-brand-rollout-design.md`.

- **D1** Full adoption in `packages/admin`. **D2** GitHub Packages only. **D3** Three phases, each green before the next. **D4** Both SPAs `data-service="key"`. **D5** React 19 bump admin-only. **D6** Revert uncommitted MonoLisa work. **D7** Delete all 21 local UI components + local `Logo`. **D8** Managed-product switcher stays app-owned. **D9** SDK defaults generated from tokens JSON.

## Reference A: Token / utility-class migration map (v3 `--pk-*` → brand v4 semantic)

**CRITICAL SEMANTIC GOTCHA:** In the *old* admin, `bg-accent` / `text-accent-foreground` / `bg-muted` are **neutral hover fills**. In the *brand*, `bg-accent` / `text-accent` are the **colored service accent**. Do NOT map old `bg-accent` → brand `bg-accent`. Map old neutral fills to `bg-surface-raised` / `text-foreground`.

The brand's `@theme inline` defines `--color-primary` (= accent) and `--color-primary-foreground` (= background), so `bg-primary` / `text-primary` / `text-primary-foreground` are valid brand utilities and need no rename.

| Old class (v3) | New class (brand v4) | Notes |
|---|---|---|
| `bg-background` | `bg-background` | unchanged |
| `bg-card` | `bg-surface` | card surface |
| `bg-popover` | `bg-surface-raised` | popover/dropdown/select content |
| `bg-muted` | `bg-surface-raised` | neutral fill (incl. `hover:bg-muted/30` → `hover:bg-surface-raised/60`) |
| `bg-accent` (neutral) | `bg-surface-raised` | **NOT brand bg-accent** |
| `bg-secondary` | `bg-surface-raised` | only survives in views; most in deleted Button/Badge |
| `bg-primary` | `bg-primary` | unchanged (resolves to accent) |
| `bg-sidebar` | `bg-surface-deep` | Shell only |
| `bg-sidebar-accent` | `bg-surface-raised` | Shell only |
| `text-foreground` | `text-foreground` | unchanged |
| `text-muted-foreground` | `text-muted` | **122 uses — the biggest rename** |
| `text-card-foreground` | `text-foreground` | |
| `text-popover-foreground` | `text-foreground` | |
| `text-accent-foreground` (neutral) | `text-foreground` | **NOT brand text-accent** |
| `text-secondary-foreground` | `text-foreground` | |
| `text-sidebar-foreground` | `text-muted` | Shell only |
| `text-primary` | `text-primary` | unchanged (= accent) |
| `text-primary-foreground` | `text-primary-foreground` | unchanged (= background) |
| `text-destructive` | `text-danger` | |
| `text-success` | `text-success` | unchanged |
| `text-warning` | `text-warning` | unchanged |
| `border-border` | `border-border` | unchanged |
| `border-input` | `border-border` | |
| `border-primary` | `border-accent` | |
| `border-destructive` | `border-danger` | |
| `border-success` / `border-warning` | `border-success` / `border-warning` | unchanged |
| `border-sidebar-border` | `border-border` | Shell only |
| `ring-ring` | `ring-ring` | unchanged (= accent) |
| `ring-offset-background` | `ring-offset-background` | unchanged |
| `ring-destructive` | `ring-danger` | |
| `bg-destructive` / `text-destructive-foreground` | `bg-danger` / `text-background` | mostly inside deleted components |
| `shadow-pk-sm|md|lg` | (drop) / `shadow-[var(--shadow)]` | only in deleted components |
| `animate-pk-in|overlay-in|spin` | (drop, brand uses `tw-animate-css`) | only in deleted components |
| `font-sans` / `font-mono` | `font-sans` / `font-mono` | provided by brand `@theme` |

## Reference B: Component API differences (brand vs old admin)

| Concern | Old admin | Brand | Migration |
|---|---|---|---|
| `Button` variants | `primary`(default)/`secondary`/`outline`/`ghost`/`destructive`/`link` | `solid`(default)/`gradient`/`outline`/`ghost`/`link`/`good`/`warning`/`info`/`danger` | `primary`→omit (solid default); `destructive`→`danger`; `secondary`→`outline`; `outline`/`ghost`/`link` unchanged. Sizes `sm`/`md`/`lg`/`icon` unchanged. `loading` + `asChild` exist in both. |
| `Badge` variants | `default`/`secondary`/`outline`/`success`/`warning`/`destructive` | `solid`/`outline`/`muted`/`danger`/`success`/`warning`/`info` | `default`→`solid`; `secondary`→`muted`; `destructive`→`danger`; rest unchanged. |
| `Dialog` parts | +`DialogBody`, `DialogActionBar` | no Body/ActionBar | `DialogBody`→`<div className="px-1 py-2">`; `DialogActionBar`→`DialogFooter`. |
| `DropdownMenuItem` | `destructive` prop | `inset` prop, no `destructive` | replace `destructive` prop with `className="text-danger focus:text-danger"`. |
| `Field` | auto-clones child, injects `id`/`aria-*` | `{label,description,error,htmlFor}` only | keep an app `Field` wrapper (Task 1.6). |
| `ConfirmDialog` | app convenience component | none | app wrapper on brand `AlertDialog` (Task 1.7). |
| Toasts | `<Toaster>{children}</Toaster>` + `useToast().{success,error,toast}` | global `<Toaster/>` + `useToast()`/`toast({tone})` | app `useToast` shim + root `<Toaster/>` (Task 1.5). |
| `DataTable` | `{columns(ColumnDef),rows,rowKey,filterable}` + `useKeysetPagination` | `{data,columns(DataTableColumn),getRowId}` | app `DataTable` wrapper on brand `Table` primitives; move `useKeysetPagination` to `lib` (Task 1.8). |
| `Logo`/`LogoMark` | `<Logo subtitle>`, `<LogoMark className>` | `Logo`(no subtitle)/`Mark`(size number) | app `AppLogo` wrapper (Task 1.9). |
| `EmptyState`/`Spinner`/`Skeleton` | local | brand exports equivalents | import from `/ui` directly. |

---

# PHASE 0 — Package-access gate

**Exit criteria:** `pnpm install` resolves `@vladzaharia/polaris-brand@1.0.0` and React 19 in `packages/admin`; the rest of the workspace still resolves React 18; CI can authenticate to GitHub Packages.

### Task 0.1: Add the `@vladzaharia` scope to the root registry config

**Files:**
- Modify: `.npmrc` (repo root)

- [ ] **Step 1: Append the scope line**

Current `.npmrc`:
```ini
auto-install-peers = true
@polaris-key:registry = https://npm.pkg.github.com
```

Change to:
```ini
auto-install-peers = true
@polaris-key:registry = https://npm.pkg.github.com
@vladzaharia:registry = https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

- [ ] **Step 2: Export a token locally and verify auth**

Run:
```bash
export GITHUB_PACKAGES_TOKEN=<classic PAT with read:packages>
npm view @vladzaharia/polaris-brand version --registry=https://npm.pkg.github.com
```
Expected: prints `1.0.0` (confirms the token can read the private package).

- [ ] **Step 3: Commit**

```bash
git add .npmrc
git commit -m "chore: add @vladzaharia GitHub Packages registry"
```

### Task 0.2: Add the brand dependency and bump admin to React 19

**Files:**
- Modify: `packages/admin/package.json`

- [ ] **Step 1: Edit dependencies**

In `packages/admin/package.json`, set these versions (change `react`/`react-dom` to 19, `@types/*` to 19, add the brand package; add `@tailwindcss/vite`, drop `autoprefixer`/`postcss`/`tailwindcss` v3 — the Tailwind swap is Task 1.1 but do the dep changes here in one install):

```jsonc
{
  "dependencies": {
    "@radix-ui/react-checkbox": "^1.1.3",
    "@radix-ui/react-dialog": "^1.1.4",
    "@radix-ui/react-dropdown-menu": "^2.1.4",
    "@radix-ui/react-label": "^2.1.1",
    "@radix-ui/react-select": "^2.1.4",
    "@radix-ui/react-slot": "^1.1.1",
    "@radix-ui/react-switch": "^1.1.2",
    "@radix-ui/react-tabs": "^1.1.2",
    "@radix-ui/react-toast": "^1.2.4",
    "@radix-ui/react-tooltip": "^1.1.6",
    "@vladzaharia/polaris-brand": "1.0.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^0.469.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tailwind-merge": "^2.6.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^26.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.8.0",
    "vite": "^6.0.0",
    "vitest": "^3.1.0"
  }
}
```
(The direct Radix deps stay for now; several are still referenced by app code until views are migrated. Remove any that end up unused in Task 1.14.)

> NOTE: the brand's direct Radix deps are `radix-ui` (unified), not the per-package `@radix-ui/*` the admin uses. Both can coexist during migration.

- [ ] **Step 2: Install and verify resolution**

Run (from repo root, with `GITHUB_PACKAGES_TOKEN` exported):
```bash
pnpm install
pnpm --filter @polaris-key/admin exec node -e "console.log(require('@vladzaharia/polaris-brand/package.json').version)"
```
Expected: `1.0.0`.

- [ ] **Step 3: Verify sdk-react still resolves React 18**

Run:
```bash
pnpm --filter @polaris-key/react exec node -e "console.log(require('react/package.json').version)"
```
Expected: an `18.x` version (confirms the React 19 bump did not hoist over the SDK). If it prints 19, add a `pnpm.overrides` scoped exception or `react` to sdk-react's own deps pinned to 18 — but do NOT proceed until the SDK tree is 18.

- [ ] **Step 4: Commit**

```bash
git add packages/admin/package.json pnpm-lock.yaml
git commit -m "chore(admin): add polaris-brand, bump to React 19 + Tailwind v4 deps"
```

### Task 0.3: Wire the GitHub Packages token into CI

**Files:**
- Modify: the CI workflow(s) under `.github/workflows/` (read them first to find the node-setup + install steps)

- [ ] **Step 1: Read the workflow(s)**

Run:
```bash
ls .github/workflows
```
Open each workflow that runs `pnpm install`. Identify the `actions/setup-node` step and the install step.

- [ ] **Step 2: Add registry auth to setup-node and export the token for install**

In each relevant job, ensure `setup-node` declares the registry and the install step has the token in env:
```yaml
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          registry-url: https://npm.pkg.github.com
          scope: "@vladzaharia"
      - run: pnpm install --frozen-lockfile
        env:
          GITHUB_PACKAGES_TOKEN: ${{ secrets.GITHUB_PACKAGES_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_PACKAGES_TOKEN }}
```
Add a repo secret `GITHUB_PACKAGES_TOKEN` (classic PAT with `read:packages`, access to the private package) in GitHub repo settings. If the workflow's built-in `GITHUB_TOKEN` has `packages: read` and the package is in the same org/owner, `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` may suffice — verify the package is readable by the workflow token before relying on it.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows
git commit -m "ci: authenticate to GitHub Packages for @vladzaharia scope"
```

---

# PHASE 1 — Admin + customer-portal SPAs

**Exit criteria:** both SPAs render entirely with brand tokens/components; no `--pk-*` tokens or `src/components/ui/*` remain; dark+light correct; `data-service="key"` accent; no FOUC; `pnpm --filter @polaris-key/admin run typecheck && test && build` green; manual browser walkthrough of manage + portal in both modes.

### Task 1.1: Swap Vite from PostCSS/Tailwind v3 to `@tailwindcss/vite`

**Files:**
- Modify: `packages/admin/vite.config.ts`
- Delete: `packages/admin/postcss.config.js`
- Delete: `packages/admin/tailwind.config.ts`

- [ ] **Step 1: Add the Tailwind v4 plugin to Vite**

Replace the plugins line in `packages/admin/vite.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The customer portal is served at `/`; the operator console is served at `/manage`.
// Both are emitted from one Vite build and served by the Worker assets binding.
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        portal: "index.html",
        manage: "manage.html",
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/login": "http://127.0.0.1:8787",
      "/callback": "http://127.0.0.1:8787",
      "/logout": "http://127.0.0.1:8787",
      "/magic": "http://127.0.0.1:8787",
      "/download": "http://127.0.0.1:8787",
      "/manage/api": "http://127.0.0.1:8787",
      "/manage/login": "http://127.0.0.1:8787",
      "/manage/callback": "http://127.0.0.1:8787",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});
```

- [ ] **Step 2: Delete the v3 config files**

```bash
git rm packages/admin/postcss.config.js packages/admin/tailwind.config.ts
```

- [ ] **Step 3: Commit (build will be green after Task 1.2 supplies CSS)**

```bash
git add packages/admin/vite.config.ts
git commit -m "build(admin): switch to @tailwindcss/vite (Tailwind v4)"
```

### Task 1.2: Replace the stylesheet with the brand's + revert MonoLisa work (D6)

**Files:**
- Create: `packages/admin/src/app.css`
- Delete: `packages/admin/src/styles.css`
- Revert (untracked): `packages/admin/src/monolisa.css`, `packages/admin/public/fonts/`
- Modify: `packages/admin/src/main.tsx`, `packages/admin/src/portal/main.tsx`

- [ ] **Step 1: Create the thin app stylesheet**

`packages/admin/src/app.css`:
```css
/* App-level styles. The brand package owns tokens, fonts, and Tailwind v4 theme. */
@import "@vladzaharia/polaris-brand/styles.css";

html,
body,
#root {
  height: 100%;
}

/* Thin scrollbar used by the operator console main pane. */
.pk-scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
```

- [ ] **Step 2: Point both entrypoints at the new stylesheet**

`packages/admin/src/main.tsx` — change `import "./styles.css";` to `import "./app.css";`.
`packages/admin/src/portal/main.tsx` — change `import "../styles.css";` to `import "../app.css";`.

- [ ] **Step 3: Delete the old stylesheet and revert the uncommitted MonoLisa work (D6)**

```bash
git rm packages/admin/src/styles.css
rm -f packages/admin/src/monolisa.css
rm -rf packages/admin/public/fonts
git checkout -- packages/admin/tailwind.config.ts 2>/dev/null || true   # already deleted in 1.1; ignore
```
(The `styles.css`/`tailwind.config.ts` font edits are moot since both files are deleted in 1.1/1.2. Confirm `git status` shows no stray `monolisa.css`/`public/fonts/`.)

- [ ] **Step 4: Commit**

```bash
git add packages/admin/src/app.css packages/admin/src/main.tsx packages/admin/src/portal/main.tsx
git commit -m "style(admin): consume brand styles.css; drop local tokens + MonoLisa pipeline"
```

### Task 1.3: Add FOUC guard + theme/service attributes + titles to both HTML entries

**Files:**
- Modify: `packages/admin/index.html`, `packages/admin/manage.html`

- [ ] **Step 1: Rewrite `packages/admin/index.html`**

```html
<!doctype html>
<html lang="en" data-theme="dark" data-service="key">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>Polaris Key</title>
    <script>
      (() => {
        try {
          const stored = window.localStorage.getItem("polaris-theme");
          const mode = stored === "light" || stored === "dark" ? stored : "dark";
          document.documentElement.dataset.theme = mode;
          document.documentElement.style.colorScheme = mode;
        } catch {
          document.documentElement.dataset.theme = "dark";
          document.documentElement.style.colorScheme = "dark";
        }
      })();
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/portal/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Rewrite `packages/admin/manage.html`** — identical `<head>` (with `<title>Polaris Key — Manage</title>`) and `data-theme="dark" data-service="key"` on `<html>`, but the body script stays `/src/main.tsx`.

- [ ] **Step 3: Commit**

```bash
git add packages/admin/index.html packages/admin/manage.html
git commit -m "feat(admin): brand FOUC guard + data-theme/data-service on both entries"
```

### Task 1.4: App providers — brand ThemeProvider + ServiceThemeProvider("key")

**Files:**
- Create: `packages/admin/src/components/AppProviders.tsx`
- Modify: `packages/admin/src/App.tsx`, `packages/admin/src/portal/App.tsx`
- Delete (after Shell migration, Task 1.10): `packages/admin/src/components/theme.tsx`

- [ ] **Step 1: Create AppProviders**

`packages/admin/src/components/AppProviders.tsx`:
```tsx
import * as React from "react";
import {
  ServiceThemeProvider,
  ThemeProvider,
} from "@vladzaharia/polaris-brand/brand";
import { Toaster } from "@vladzaharia/polaris-brand/ui";

/** Root brand providers for both SPAs. Service is fixed to "key" (this is Polaris Key). */
export function AppProviders({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ThemeProvider>
      <ServiceThemeProvider service="key">
        {children}
        <Toaster />
      </ServiceThemeProvider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 2: Update `App.tsx` root**

In `packages/admin/src/App.tsx`, replace the imports of `ThemeProvider` (from `./components/theme.js`) and `Toaster` (from the local barrel), and change the `App()` body:
```tsx
import { AppProviders } from "./components/AppProviders.js";
// ...remove: import { ThemeProvider } from "./components/theme.js";
// ...remove Toaster from the ui import list

export function App(): React.ReactElement {
  return (
    <AppProviders>
      <Boot />
    </AppProviders>
  );
}
```
Also update `ThemeBackdrop`/`BootScreen` token classes per Reference A (e.g. `bg-background text-foreground` stays; `text-muted-foreground` → `text-muted`; `text-primary` stays) and swap `LogoMark`/`Spinner`/`EmptyState` imports to the brand/AppLogo (handled in the view-migration task for App.tsx, Task 1.12).

- [ ] **Step 3: Update `portal/App.tsx` root**

In `packages/admin/src/portal/App.tsx`, replace `ThemeProvider` + `Toaster` wrapper:
```tsx
import { AppProviders } from "../components/AppProviders.js";

export function PortalApp(): React.ReactElement {
  return (
    <AppProviders>
      <Boot />
    </AppProviders>
  );
}
```

- [ ] **Step 4: Typecheck (will still fail until Task 1.5–1.12); commit provider scaffolding**

```bash
git add packages/admin/src/components/AppProviders.tsx
git commit -m "feat(admin): AppProviders wrapping brand Theme + Service(key) providers"
```

### Task 1.5: `useToast` compatibility shim + brand Toaster

**Files:**
- Create: `packages/admin/src/lib/toast.ts`
- Test: `packages/admin/src/lib/toast.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/admin/src/lib/toast.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";

const calls: Array<{ tone?: string; title?: string; description?: string }> = [];
vi.mock("@vladzaharia/polaris-brand/ui", () => ({
  toast: (input: { tone?: string; title?: string; description?: string }) => {
    calls.push(input);
    return { id: "1", dismiss: () => {}, update: () => {} };
  },
}));

import { useToast } from "./toast.js";

describe("useToast shim", () => {
  it("maps success/error/default to brand tones", () => {
    calls.length = 0;
    const t = useToast();
    t.success("Saved", "All good");
    t.error("Nope");
    t.toast({ title: "Hi" });
    expect(calls).toEqual([
      { tone: "success", title: "Saved", description: "All good" },
      { tone: "danger", title: "Nope", description: undefined },
      { tone: "default", title: "Hi", description: undefined },
    ]);
  });
});
```

> The shim is a plain function (not a React hook that needs a provider), so it can be unit-tested directly by mocking the brand `toast` store and asserting the tone mapping.

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @polaris-key/admin exec vitest run src/lib/toast.test.ts`
Expected: FAIL (`./toast.js` not found).

- [ ] **Step 3: Implement the shim**

`packages/admin/src/lib/toast.ts`:
```ts
import { toast as brandToast } from "@vladzaharia/polaris-brand/ui";

/**
 * Back-compat shim for the admin's former `useToast()` API (`.toast/.success/.error`),
 * implemented over the brand's global `toast()` store. The brand `<Toaster/>` is mounted
 * once in AppProviders; there is no context to read, so this is a plain function.
 */
export interface AdminToast {
  toast: (t: {
    title: string;
    description?: string;
    variant?: "default" | "success" | "destructive";
  }) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}

const toneOf = (
  variant?: "default" | "success" | "destructive",
): "default" | "success" | "danger" =>
  variant === "success" ? "success" : variant === "destructive" ? "danger" : "default";

export function useToast(): AdminToast {
  return {
    toast: ({ title, description, variant }) =>
      void brandToast({ title, description, tone: toneOf(variant) }),
    success: (title, description) =>
      void brandToast({ title, description, tone: "success" }),
    error: (title, description) =>
      void brandToast({ title, description, tone: "danger" }),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @polaris-key/admin exec vitest run src/lib/toast.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/lib/toast.ts packages/admin/src/lib/toast.test.ts
git commit -m "feat(admin): useToast shim over brand toast store"
```

### Task 1.6: `Field` wrapper (preserve auto-wiring)

**Files:**
- Create: `packages/admin/src/components/Field.tsx`
- Test: `packages/admin/src/components/Field.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/admin/src/components/Field.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./Field.js";

describe("Field", () => {
  it("wires label + injects id/aria into the child and shows errors", () => {
    render(
      <Field label="Email" error="Required">
        <input />
      </Field>,
    );
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toContain("-error");
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `pnpm --filter @polaris-key/admin exec vitest run src/components/Field.test.tsx`
Expected: FAIL (`./Field.js` not found).

- [ ] **Step 3: Implement (port the old Field, restyled with brand Label + tokens)**

`packages/admin/src/components/Field.tsx`:
```tsx
import * as React from "react";
import { Label } from "@vladzaharia/polaris-brand/ui";
import { cn } from "../lib/cn.js";

export interface FieldProps {
  label: React.ReactNode;
  htmlFor?: string;
  help?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
  labelAside?: React.ReactNode;
  children: React.ReactElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean | "true" | "false";
    "aria-required"?: boolean;
  }>;
}

export function Field({
  label,
  htmlFor,
  help,
  error,
  required,
  className,
  labelAside,
  children,
}: FieldProps): React.ReactElement {
  const reactId = React.useId();
  const id = htmlFor ?? `pk-field-${reactId}`;
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  const control = React.cloneElement(children, {
    id,
    "aria-describedby": describedBy,
    "aria-invalid": error ? "true" : undefined,
    "aria-required": required || undefined,
  });

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>
          {label}
          {required ? <span className="ml-0.5 text-danger">*</span> : null}
        </Label>
        {labelAside}
      </div>
      {control}
      {help ? (
        <p id={helpId} className="text-xs text-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run to pass; commit**

Run: `pnpm --filter @polaris-key/admin exec vitest run src/components/Field.test.tsx` → PASS
```bash
git add packages/admin/src/components/Field.tsx packages/admin/src/components/Field.test.tsx
git commit -m "feat(admin): Field wrapper preserving auto aria wiring on brand Label"
```

### Task 1.7: `ConfirmDialog` wrapper on brand AlertDialog

**Files:**
- Create: `packages/admin/src/components/ConfirmDialog.tsx`
- Test: `packages/admin/src/components/ConfirmDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/admin/src/components/ConfirmDialog.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog.js";

describe("ConfirmDialog", () => {
  it("fires onConfirm when the confirm action is clicked", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to fail** — `pnpm --filter @polaris-key/admin exec vitest run src/components/ConfirmDialog.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`packages/admin/src/components/ConfirmDialog.tsx`:
```tsx
import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@vladzaharia/polaris-brand/ui";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "solid" | "danger" | "outline";
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "danger",
  loading = false,
  onConfirm,
}: ConfirmDialogProps): React.ReactElement {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="max-w-md"
        onEscapeKeyDown={(e) => loading && e.preventDefault()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={confirmVariant}
            loading={loading}
            onClick={(e) => {
              e.preventDefault();
              void onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```
> The old `confirmVariant="destructive"` default becomes `"danger"`; call sites passing `confirmVariant="destructive"` must be updated to `"danger"` during their view migration.

- [ ] **Step 4: Run to pass; commit**

```bash
git add packages/admin/src/components/ConfirmDialog.tsx packages/admin/src/components/ConfirmDialog.test.tsx
git commit -m "feat(admin): ConfirmDialog wrapper on brand AlertDialog"
```

### Task 1.8: `DataTable` app component + extract `useKeysetPagination`

**Files:**
- Create: `packages/admin/src/components/DataTable.tsx`
- Create: `packages/admin/src/lib/keyset.ts`
- Test: `packages/admin/src/components/DataTable.test.tsx`, `packages/admin/src/lib/keyset.test.ts`

- [ ] **Step 1: Move the keyset hook into lib (pure logic, unchanged)**

`packages/admin/src/lib/keyset.ts` — copy `KeysetCursor`, `KeysetPage`, `UseKeysetPagination`, and `useKeysetPagination` verbatim from the old `DataTable.tsx` (no UI, no token classes).

- [ ] **Step 2: Write a failing test for the DataTable wrapper**

`packages/admin/src/components/DataTable.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable, type ColumnDef } from "./DataTable.js";

interface Row { id: string; name: string; }
const columns: ColumnDef<Row>[] = [
  { id: "name", header: "Name", cell: (r) => r.name, accessor: (r) => r.name, sortable: true },
];

describe("DataTable", () => {
  it("renders rows and an empty state", () => {
    render(<DataTable columns={columns} rows={[{ id: "1", name: "Ada" }]} rowKey={(r) => r.id} />);
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to fail** — `pnpm --filter @polaris-key/admin exec vitest run src/components/DataTable.test.tsx` → FAIL.

- [ ] **Step 4: Implement the wrapper on brand Table primitives**

`packages/admin/src/components/DataTable.tsx` — port the old `DataTable` body but render with brand primitives (`Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` from `@vladzaharia/polaris-brand/ui`), brand `Input`, `Skeleton`, `EmptyState`. Keep the exact old public API (`ColumnDef`, `DataTableProps` with `columns/rows/rowKey/loading/filterable/filterPlaceholder/empty/onRowClick/onRowClickLabel/className`). Apply Reference A to internal classes (`text-muted-foreground`→`text-muted`, `bg-muted/40`→`bg-surface-raised/60`, `border-border` unchanged, `ring-ring` unchanged). Re-export the keyset hook for import-compatibility:
```tsx
export {
  useKeysetPagination,
  type KeysetCursor,
  type KeysetPage,
  type UseKeysetPagination,
} from "../lib/keyset.js";
```

- [ ] **Step 5: Run tests to pass; commit**

```bash
git add packages/admin/src/components/DataTable.tsx packages/admin/src/lib/keyset.ts packages/admin/src/components/DataTable.test.tsx packages/admin/src/lib/keyset.test.ts
git commit -m "feat(admin): DataTable on brand Table primitives; extract keyset hook"
```

### Task 1.9: `AppLogo` wrapper (brand Logo/Mark, service="key")

**Files:**
- Create: `packages/admin/src/components/AppLogo.tsx`

- [ ] **Step 1: Implement**

`packages/admin/src/components/AppLogo.tsx`:
```tsx
import * as React from "react";
import { Logo, Mark } from "@vladzaharia/polaris-brand/brand";
import { cn } from "../lib/cn.js";

/** The Polaris Key mark. `size` is px (brand Mark uses --mark-size). */
export function AppMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}): React.ReactElement {
  return <Mark service="key" size={size} className={cn("leading-none", className)} />;
}

/** Full lockup with an optional muted subtitle (e.g. "admin", "portal"). */
export function AppLogo({
  subtitle,
  className,
}: {
  subtitle?: string;
  className?: string;
}): React.ReactElement {
  return (
    <span className={cn("inline-flex items-center gap-2 text-foreground", className)}>
      <Logo service="key" layout="horizontal" size={132} />
      {subtitle ? (
        <span className="text-xs font-normal uppercase tracking-wider text-muted">
          {subtitle}
        </span>
      ) : null}
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/admin/src/components/AppLogo.tsx
git commit -m "feat(admin): AppLogo/AppMark wrappers over brand Logo/Mark (service=key)"
```

### Task 1.10: Rewrite `Shell.tsx` on brand primitives

**Files:**
- Modify: `packages/admin/src/components/Shell.tsx`
- Delete: `packages/admin/src/components/theme.tsx` (after Shell no longer imports it)

- [ ] **Step 1: Rewrite imports + theme toggle**

In `Shell.tsx`: replace `import { Logo, LogoMark } from "./brand/Logo.js"` with `import { AppLogo, AppMark } from "./AppLogo.js"`; replace `import { useTheme } from "./theme.js"` with brand `ModeToggle` (`import { ModeToggle } from "@vladzaharia/polaris-brand/brand"`); change the local `ui/index.js` import to `@vladzaharia/polaris-brand/ui`. Replace the `<ThemeToggle/>` component with `<ModeToggle />`. Replace `<Logo subtitle="admin" />` → `<AppLogo subtitle="admin" />`, `<LogoMark className="size-5 lg:hidden" />` → `<AppMark size={20} className="lg:hidden" />`.

- [ ] **Step 2: Apply the class map to Shell's markup**

Per Reference A, in `Shell.tsx`: `bg-sidebar`→`bg-surface-deep`, `bg-sidebar-accent`→`bg-surface-raised`, `border-sidebar-border`→`border-border`, `text-sidebar-foreground`→`text-muted`, `text-muted-foreground`→`text-muted`, `bg-background`→`bg-background`, `border-border` unchanged, `bg-primary text-primary-foreground` unchanged (avatar), `ring-ring` unchanged. Replace `DropdownMenuItem destructive` with `className="text-danger focus:text-danger"`.

- [ ] **Step 3: Delete the local theme provider**

```bash
git rm packages/admin/src/components/theme.tsx
```

- [ ] **Step 4: Typecheck the file compiles against brand; commit**

Run: `pnpm --filter @polaris-key/admin exec tsc --noEmit` (expect only errors in not-yet-migrated views).
```bash
git add packages/admin/src/components/Shell.tsx
git commit -m "feat(admin): rebuild Shell on brand UI + ModeToggle + AppLogo"
```

### Task 1.11–1.13: Per-view migration (mechanical, map-driven)

Each view task follows the **same recipe**. Do them one file per step-group, running that file's test after.

**Recipe (apply to each file):**
1. Change component imports from `./components/ui/index.js` / `../components/ui/index.js` (and `../../components/ui/index.js`) to `@vladzaharia/polaris-brand/ui`, EXCEPT: `Field` → `../components/Field.js`; `ConfirmDialog` → `../components/ConfirmDialog.js`; `DataTable` + `ColumnDef`/keyset types → `../components/DataTable.js`; `useToast` → `../lib/toast.js`; `Logo`/`LogoMark` → `AppLogo`/`AppMark` from `../components/AppLogo.js`.
2. Rename `Button` variants (`destructive`→`danger`, `secondary`→`outline`, drop `primary`) and `Badge` variants (`default`→`solid`, `secondary`→`muted`, `destructive`→`danger`).
3. Replace `DialogBody`→`<div className="px-1 py-2">`, `DialogActionBar`→`DialogFooter` (and import `DialogFooter`).
4. Apply Reference A class renames (the big one: `text-muted-foreground`→`text-muted`; neutral `bg-muted`/`bg-accent`→`bg-surface-raised`; `text-destructive`→`text-danger`).
5. Update any `confirmVariant="destructive"` → `"danger"`.
6. Run the file's colocated test (see mapping below); then `tsc --noEmit` for the file.

**View → test file mapping** (from `packages/admin/test/`): `Dashboard`→`dashboard.test.tsx`; `Activity`→`activity.test.tsx`; `Catalog`+`SchemaForm`→`catalog.test.tsx`,`SchemaForm.test.tsx`; `Releases`→`releases.test.tsx`; `Licenses`/`LicenseDetail`/`licenses/*`→`licenses.test.tsx`; `Products`/`products/*`→`products.test.tsx`; `Profiles`/`profiles/*`→`profiles.test.tsx`; `Secrets`→`secrets.test.tsx`; `Tiers`/`tiers/*`→`tiers.test.tsx`; `App.tsx`→`App.test.tsx`,`views.test.tsx`; `portal/App.tsx`→`portal.test.tsx`; context→`context.test.tsx`.

### Task 1.12: Migrate the two app roots + SchemaForm

**Files (each its own commit):**
- `packages/admin/src/App.tsx` — imports: `{ Spinner, EmptyState }` → `@vladzaharia/polaris-brand/ui`; `LogoMark` → `AppMark`. Classes: `text-muted-foreground`→`text-muted`; `text-primary` stays. Test: `App.test.tsx`, `views.test.tsx`.
- `packages/admin/src/portal/App.tsx` — imports: `{ Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, Skeleton }` → `/ui`; `{ ConfirmDialog }` → `../components/ConfirmDialog.js`; `{ DataTable, type ColumnDef }` → `../components/DataTable.js`; `{ Field }` → `../components/Field.js`; `{ useToast }` → `../lib/toast.js`; `{ Logo, LogoMark }` → `AppLogo, AppMark`. Variant renames: `Badge variant="default"`→`"solid"`, `variant="warning"`/`"success"`/`"outline"` unchanged; `Button variant="outline"`/`"ghost"` unchanged. Classes per map (`text-muted-foreground`→`text-muted`, `hover:bg-muted/30`→`hover:bg-surface-raised/60`, `bg-muted` in `TopLink` active→`bg-surface-raised`, `border-border` unchanged, `bg-background/90`→`bg-background/90`). `confirmVariant="destructive"`→`"danger"`. Test: `portal.test.tsx`.
- `packages/admin/src/SchemaForm.tsx` — imports `{ Badge, Checkbox, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue }`: `Field`→`../components/Field.js`, rest→`/ui`. Apply class map. Test: `SchemaForm.test.tsx`.

- [ ] **Step 1:** Migrate `App.tsx` per recipe → run `App.test.tsx`,`views.test.tsx` → commit `refactor(admin): migrate App root to brand UI`.
- [ ] **Step 2:** Migrate `portal/App.tsx` per recipe → run `portal.test.tsx` → commit `refactor(admin): migrate portal app to brand UI`.
- [ ] **Step 3:** Migrate `SchemaForm.tsx` per recipe → run `SchemaForm.test.tsx` → commit `refactor(admin): migrate SchemaForm to brand UI`.

### Task 1.13: Migrate the operator views

Apply the recipe to each file below, grouped by test. Commit per group after its test passes.

- [ ] **Group A — Dashboard/Overview/Activity:** `views/Dashboard.tsx`, `views/ProductOverview.tsx`, `views/Activity.tsx`. Notable: `border-primary`→`border-accent` (Dashboard, Releases); `text-warning`/`text-success` unchanged (ProductOverview). Run `dashboard.test.tsx`, `activity.test.tsx`. Commit.
- [ ] **Group B — Catalog:** `views/Catalog.tsx`, `views/catalog/PublishDialog.tsx`. `DialogBody`/`DialogActionBar` replacements. Run `catalog.test.tsx`. Commit.
- [ ] **Group C — Licenses:** `views/Licenses.tsx`, `views/LicenseDetail.tsx`, `views/licenses/KeysSection.tsx`, `views/licenses/DevicesSection.tsx`, `views/licenses/PolicySection.tsx`, `views/licenses/OverridesEditor.tsx`, `views/licenses/EditMetadataDialog.tsx`, `views/licenses/shared.tsx`. `KeysSection` uses `DialogBody`/`DialogActionBar`+`DataTable`+`ConfirmDialog`+`Field`. Run `licenses.test.tsx`. Commit.
- [ ] **Group D — Products:** `views/Products.tsx`, `views/products/CreateProductDialog.tsx`, `views/products/EditProductDialog.tsx`, `views/products/SecretDialog.tsx`, `views/products/RotateKeyResultDialog.tsx`, `views/releases/ResyncButton.tsx`. Run `products.test.tsx`, `releases.test.tsx`. Commit.
- [ ] **Group E — Profiles:** `views/Profiles.tsx`, `views/profiles/ProfileDetailDialog.tsx`, `views/profiles/CreateProfileDialog.tsx`, `views/profiles/PayloadEditor.tsx`. Run `profiles.test.tsx`. Commit.
- [ ] **Group F — Tiers/Releases/Secrets/Settings/Oidc:** `views/Tiers.tsx`, `views/tiers/dialogs.tsx`, `views/Releases.tsx`, `views/Secrets.tsx`, `views/Settings.tsx`, `views/Oidc.tsx`. `Settings` uses `Switch`+`ConfirmDialog`+`Field`+`useToast`; `border-success`/`bg-success` unchanged. Run `tiers.test.tsx`, `releases.test.tsx`, `secrets.test.tsx`. Commit each group.

> After each group: `pnpm --filter @polaris-key/admin exec vitest run test/<file>` must pass and `tsc --noEmit` must have no errors in the migrated files.

### Task 1.14: Delete the local component library

**Files:**
- Delete: `packages/admin/src/components/ui/` (all 21 + barrel), `packages/admin/src/components/brand/Logo.tsx` (and empty `components/brand/` dir)

- [ ] **Step 1: Confirm nothing imports the old barrel/Logo**

Run:
```bash
grep -rn "components/ui" packages/admin/src || echo "clean"
grep -rn "components/brand/Logo" packages/admin/src || echo "clean"
grep -rn "components/theme" packages/admin/src || echo "clean"
```
Expected: all print `clean`.

- [ ] **Step 2: Delete**

```bash
git rm -r packages/admin/src/components/ui
git rm packages/admin/src/components/brand/Logo.tsx
```

- [ ] **Step 3: Remove now-unused direct Radix deps**

Check which `@radix-ui/*` deps are still imported by app code:
```bash
for p in checkbox dialog dropdown-menu label select slot switch tabs toast tooltip; do
  grep -rqn "@radix-ui/react-$p" packages/admin/src && echo "used: $p" || echo "drop: $p";
done
```
Remove the `drop:` entries from `packages/admin/package.json` dependencies, then `pnpm install`.

- [ ] **Step 4: Full admin green gate**

Run:
```bash
pnpm --filter @polaris-key/admin run typecheck
pnpm --filter @polaris-key/admin run test
pnpm --filter @polaris-key/admin run build
pnpm --filter @polaris-key/admin run lint
```
Expected: all pass; `dist/` emits `index.html`, `manage.html`, and brand fonts under `dist/assets`.

- [ ] **Step 5: Commit**

```bash
git add -A packages/admin
git commit -m "refactor(admin): delete hand-built UI library; brand is the source of truth"
```

### Task 1.15: Manual browser verification (both SPAs, both modes)

- [ ] **Step 1: Run the worker + admin dev servers** (`pnpm --filter @polaris-key/worker dev` and `pnpm --filter @polaris-key/admin dev`) and open the portal (`/`) and manage console (`/manage`).
- [ ] **Step 2:** Verify in **dark and light** (toggle via `ModeToggle`): no FOUC on reload; the "key" accent (purple `#a879ff`) appears on primary buttons/links/focus rings; tables, dialogs, dropdowns, toasts, forms render correctly; sidebar + product switcher work; a destructive confirm flow (e.g. disconnect device / delete) works.
- [ ] **Step 3:** Record the result (screenshots or a note) in the PR description. This is not automatable — state explicitly that manual verification passed.

---

# PHASE 2 — Worker-rendered HTML + emails

**Exit criteria:** OIDC device screen, auth error pages, and shells carry the brand; emails are branded within email-safe limits; `pnpm --filter @polaris-key/worker run typecheck && test && dryrun` green.

### Task 2.1: Add the brand to the worker + a shared brand helper

**Files:**
- Modify: `packages/worker/package.json`
- Create: `packages/worker/src/brand/index.ts`
- Test: `packages/worker/src/brand/index.test.ts`

- [ ] **Step 1: Add the dependency**

In `packages/worker/package.json` `dependencies`, add:
```jsonc
    "@vladzaharia/polaris-brand": "1.0.0",
```
Run `pnpm install`.

- [ ] **Step 2: Write a failing test for the helper**

`packages/worker/src/brand/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { keyMark, PK } from "./index.js";

describe("worker brand helper", () => {
  it("renders an inline key mark SVG", () => {
    const svg = keyMark(48);
    expect(svg).toContain("<svg");
    expect(svg).toContain("role=\"img\"");
  });
  it("exposes the key palette", () => {
    expect(PK.accent).toMatch(/^#/);
    expect(PK.page).toMatch(/^#/);
  });
});
```

- [ ] **Step 3: Run to fail** — `pnpm --filter @polaris-key/worker exec vitest run src/brand/index.test.ts` → FAIL.

- [ ] **Step 4: Implement the helper (SSR-safe `/marks` only)**

`packages/worker/src/brand/index.ts`:
```ts
import { renderMark } from "@vladzaharia/polaris-brand/marks";

/** Polaris Key palette (dark surface), mirrored from the brand tokens for inline HTML/email. */
export const PK = {
  page: "#060912",
  surface: "#101827",
  text: "#eef3ff",
  muted: "#aab8d2",
  line: "#25344d",
  accent: "#a879ff", // service "key" primary
  danger: "#ff7a92",
} as const;

/** Inline "key" constellation mark SVG for server-rendered HTML surfaces. */
export function keyMark(size = 48): string {
  return renderMark("key", { size, surface: "dark", title: "Polaris Key" });
}
```

- [ ] **Step 5: Run to pass; commit**

```bash
git add packages/worker/package.json packages/worker/src/brand/index.ts packages/worker/src/brand/index.test.ts pnpm-lock.yaml
git commit -m "feat(worker): brand helper using SSR-safe /marks renderer"
```

### Task 2.2: Rebrand the OIDC device-verify screen

**Files:**
- Modify: `packages/worker/src/oidc.ts` (the `handleAuthDeviceVerify` HTML template, ~lines 530–546)

- [ ] **Step 1: Import the helper**

Add near the top of `oidc.ts`: `import { keyMark, PK } from "./brand/index.js";`

- [ ] **Step 2: Replace the HTML string** (keep the existing `confirmUrl`, `deviceLabel`, `record`, `product`, `escapeHtml` logic):
```ts
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${escapeHtml(product.name)}</title>
<body style="font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; margin:0; background:${PK.page}; color:${PK.text};">
  <main style="max-width: 460px; margin: 12vh auto; padding: 32px;">
    <div style="display:flex; align-items:center; gap:10px; margin:0 0 20px;">
      <span style="width:36px; height:36px;">${keyMark(36)}</span>
      <span style="color:${PK.muted}; font-weight:600;">Polaris Key</span>
    </div>
    <h1 style="font-size: 28px; margin:0 0 16px;">Authorize ${escapeHtml(product.name)}</h1>
    <p style="line-height:1.5; color:${PK.muted};">A desktop app is asking to activate this device. Confirm the code and device before signing in.</p>
    <dl style="display:grid; grid-template-columns: 110px 1fr; gap:10px; margin:24px 0; color:${PK.muted};">
      <dt>Code</dt><dd style="margin:0; color:${PK.text}; font-weight:700; letter-spacing:.08em;">${escapeHtml(record.userCode)}</dd>
      <dt>Device</dt><dd style="margin:0;">${escapeHtml(deviceLabel)}</dd>
      <dt>Product</dt><dd style="margin:0;">${escapeHtml(product.slug)}</dd>
    </dl>
    <a href="${escapeHtml(confirmUrl.toString())}" style="display:inline-flex; align-items:center; justify-content:center; min-height:44px; padding:0 18px; border-radius:8px; background:${PK.accent}; color:${PK.page}; text-decoration:none; font-weight:700;">Continue to sign in</a>
  </main>
</body>`;
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @polaris-key/worker run typecheck && pnpm --filter @polaris-key/worker exec vitest run` (existing oidc tests must still pass; if a test asserts the old `#5b7cfa`, update it to `PK.accent`).
```bash
git add packages/worker/src/oidc.ts
git commit -m "feat(worker): rebrand OIDC device-verify screen with key mark + palette"
```

### Task 2.3: Branded shared error page

**Files:**
- Create: `packages/worker/src/brand/errorPage.ts`
- Modify: `packages/worker/src/portal/auth.ts`, `packages/worker/src/admin/auth.ts`

- [ ] **Step 1: Create the shared template**

`packages/worker/src/brand/errorPage.ts`:
```ts
import { keyMark, PK } from "./index.js";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A branded standalone error page body for worker HTML surfaces. */
export function brandErrorHtml(titleText: string, message: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(titleText)}</title>
<body style="font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; margin:0; background:${PK.page}; color:${PK.text};">
  <main style="max-width: 420px; margin: 16vh auto; padding: 32px; text-align:center;">
    <span style="display:inline-flex; width:40px; height:40px;">${keyMark(40)}</span>
    <h1 style="font-size: 22px; margin:16px 0 8px;">${escapeHtml(message)}</h1>
    <p style="color:${PK.muted};">Polaris Key</p>
  </main>
</body>`;
}
```

- [ ] **Step 2: Use it in both `htmlError()`s** (preserve each file's existing security-header wiring)

`packages/worker/src/portal/auth.ts`:
```ts
import { brandErrorHtml } from "../brand/errorPage.js";
// ...
function htmlError(status: number, message: string): Response {
  return new Response(brandErrorHtml("Portal sign-in", message), {
    status,
    headers: portalSecurityHeaders(
      new Headers({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      }),
    ),
  });
}
```
`packages/worker/src/admin/auth.ts`:
```ts
import { brandErrorHtml } from "../brand/errorPage.js";
// ...
function htmlError(status: number, message: string): Response {
  return new Response(brandErrorHtml("Sign-in", message), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @polaris-key/worker run typecheck && vitest run`.
```bash
git add packages/worker/src/brand/errorPage.ts packages/worker/src/portal/auth.ts packages/worker/src/admin/auth.ts
git commit -m "feat(worker): branded shared auth error page"
```

### Task 2.4: Brand the fallback SPA shells (FOUC guard + attributes)

**Files:**
- Modify: `packages/worker/src/portal/index.ts` (`portalShell()`), `packages/worker/src/admin/index.ts` (`spaShell()`)

- [ ] **Step 1: Add the FOUC guard + attributes to both placeholder shells**

For `portalShell()` set the HTML to (analogous for `spaShell()` with `manage.js` + `Polaris Key — Admin`):
```html
<!doctype html><html lang="en" data-theme="dark" data-service="key"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polaris Key — Portal</title><script>(()=>{try{var m=localStorage.getItem("polaris-theme");m=m==="light"||m==="dark"?m:"dark";document.documentElement.dataset.theme=m;document.documentElement.style.colorScheme=m}catch(e){document.documentElement.dataset.theme="dark"}})()</script></head><body><div id="root"></div><script type="module" src="/assets/portal.js"></script></body></html>
```
(These placeholders only serve when the ASSETS binding is absent — the real shells are the Phase 1 `index.html`/`manage.html`. Keep them consistent anyway.)

- [ ] **Step 2: Verify + commit**

Run: `pnpm --filter @polaris-key/worker run typecheck && vitest run` (update any shell-string assertions).
```bash
git add packages/worker/src/portal/index.ts packages/worker/src/admin/index.ts
git commit -m "feat(worker): FOUC guard + theme/service attrs on fallback shells"
```

### Task 2.5: Email-safe branding

**Files:**
- Modify: `packages/worker/src/portal/email.ts`

- [ ] **Step 1: Add a shared email frame (inline styles, system font, accent + wordmark; no SVG/webfont)**

In `email.ts`, add:
```ts
const EMAIL_ACCENT = "#a879ff";
const EMAIL_INK = "#14213d";

function emailFrame(bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${EMAIL_INK};max-width:520px;margin:0 auto;padding:24px;">
  <div style="border-left:4px solid ${EMAIL_ACCENT};padding-left:12px;margin-bottom:20px;font-weight:700;font-size:18px;">Polaris&nbsp;Key</div>
  ${bodyHtml}
  <p style="color:#6b7280;font-size:12px;margin-top:28px;">Polaris Key</p>
</div>`;
}
```

- [ ] **Step 2: Wrap the two templates**

In `sendMagicLink`, set `html` to:
```ts
    html: emailFrame(
      `<p>Use this link to sign in to Polaris Key:</p><p><a href="${escapeHtml(link)}" style="display:inline-block;background:${EMAIL_ACCENT};color:#0b1020;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;">Sign in</a></p><p>This link expires in 10 minutes.</p>`,
    ),
```
In `sendPortalNotice`, set `html` to:
```ts
    html: emailFrame(`<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`),
```
(Leave the `text` fallbacks and subjects unchanged.)

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @polaris-key/worker run typecheck && vitest run`.
```bash
git add packages/worker/src/portal/email.ts
git commit -m "feat(worker): email-safe brand frame for magic-link + notice emails"
```

### Task 2.6: Worker green gate

- [ ] Run:
```bash
pnpm --filter @polaris-key/worker run typecheck
pnpm --filter @polaris-key/worker run test
pnpm --filter @polaris-key/worker run lint
pnpm --filter @polaris-key/worker run dryrun
```
Expected: all pass (dryrun bundles the brand `/marks` import without error). Commit any test-assertion updates.

---

# PHASE 3 — sdk-react default-theme alignment

**Exit criteria:** `sdk-react` `defaultTheme` token values match brand tokens, generated from the tokens JSON; no runtime brand dependency; React peer stays `^18`; `pnpm --filter @polaris-key/react run typecheck && test && build` green.

### Task 3.1: Token-generation script

**Files:**
- Create: `packages/sdk-react/scripts/gen-theme.mjs`
- Create: `packages/sdk-react/src/theme.generated.ts` (script output, committed)
- Modify: `packages/sdk-react/package.json` (add brand as **devDependency** + a `gen:theme` script + `prebuild`/`pretypecheck` hook)

- [ ] **Step 1: Add the devDependency + scripts**

In `packages/sdk-react/package.json`:
```jsonc
  "scripts": {
    "gen:theme": "node scripts/gen-theme.mjs",
    "build": "pnpm gen:theme && rm -rf dist && tsc -p tsconfig.build.json",
    "typecheck": "pnpm gen:theme && tsc --noEmit",
    "test": "vitest run",
    "lint": "prettier --check \"src/**/*.{ts,tsx}\" \"test/**/*.{ts,tsx}\"",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "@vladzaharia/polaris-brand": "1.0.0",
    "@testing-library/react": "^16.1.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "jsdom": "^26.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
```
(peerDependencies stay `react`/`react-dom` `^18`.) Run `pnpm install`.

- [ ] **Step 2: Write the generator**

`packages/sdk-react/scripts/gen-theme.mjs`:
```js
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const tokens = require("@vladzaharia/polaris-brand/tokens");
const v = (path) =>
  path.split(".").reduce((o, k) => o[k], tokens).$value;

const out = `// GENERATED by scripts/gen-theme.mjs from @vladzaharia/polaris-brand/tokens. Do not edit.
export const brandTokens = {
  accent: "${v("polaris.service.key.primary")}",
  accentHover: "${v("polaris.color.polaris")}",
  accentText: "${v("polaris.color.page")}",
  ring: "${v("polaris.service.key.primary")}",
  background: "${v("polaris.color.page")}",
  surface: "${v("polaris.color.surface")}",
  text: "${v("polaris.color.text")}",
  textMuted: "${v("polaris.color.muted")}",
  border: "${v("polaris.color.line")}",
  danger: "${v("polaris.color.danger")}",
  radius: "${v("polaris.radius.medium")}",
  fontFamily:
    "${v("polaris.typography.text")}, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
} as const;
`;

const dir = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(dir, "..", "src", "theme.generated.ts"), out);
console.log("wrote src/theme.generated.ts");
```

- [ ] **Step 3: Generate + commit**

Run: `pnpm --filter @polaris-key/react run gen:theme` (produces `src/theme.generated.ts`).
```bash
git add packages/sdk-react/package.json packages/sdk-react/scripts/gen-theme.mjs packages/sdk-react/src/theme.generated.ts pnpm-lock.yaml
git commit -m "build(sdk-react): generate brand token values from tokens JSON"
```

### Task 3.2: Consume the generated tokens in `defaultTheme`

**Files:**
- Modify: `packages/sdk-react/src/components/theme.ts`
- Test: `packages/sdk-react/test/theme.test.ts`

- [ ] **Step 1: Write a failing test**

`packages/sdk-react/test/theme.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { defaultTheme } from "../src/components/theme.js";
import { brandTokens } from "../src/theme.generated.js";

describe("defaultTheme", () => {
  it("uses brand token values", () => {
    expect(defaultTheme.tokens.accent).toBe(brandTokens.accent);
    expect(defaultTheme.tokens.background).toBe(brandTokens.background);
    expect(defaultTheme.tokens.text).toBe(brandTokens.text);
  });
});
```

- [ ] **Step 2: Run to fail** — `pnpm --filter @polaris-key/react exec vitest run test/theme.test.ts` → FAIL.

- [ ] **Step 3: Wire the generated tokens into `defaultTheme.tokens`**

In `packages/sdk-react/src/components/theme.ts`, import the generated bag and spread it (keep the `copy` block + `highContrastTheme` + `mergeTheme`/`themeVars` unchanged; update the contrast comment to note values are brand-derived):
```ts
import { brandTokens } from "../theme.generated.js";
// ...
export const defaultTheme: PolarisTheme = {
  tokens: { ...brandTokens },
  copy: {
    productName: "Polaris Key",
    // ...unchanged copy...
  },
};
```
> `brandTokens` provides exactly the `PolarisThemeTokens` keys; the object literal satisfies the interface. Keep `oidcButtonLabel: "Continue with Polaris"` etc.

- [ ] **Step 4: Run to pass; commit**

Run: `pnpm --filter @polaris-key/react exec vitest run test/theme.test.ts` → PASS.
```bash
git add packages/sdk-react/src/components/theme.ts packages/sdk-react/test/theme.test.ts
git commit -m "feat(sdk-react): default theme derived from brand tokens"
```

### Task 3.3: SDK green gate

- [ ] Run:
```bash
pnpm --filter @polaris-key/react run typecheck
pnpm --filter @polaris-key/react run test
pnpm --filter @polaris-key/react run build
pnpm --filter @polaris-key/react run lint
```
Expected: all pass; `dist/` includes the generated tokens compiled in; no `@vladzaharia/polaris-brand` in the built runtime import graph (it's dev-only). Verify:
```bash
grep -rn "polaris-brand" packages/sdk-react/dist || echo "no runtime brand dep — good"
```

---

# Final: whole-repo gate

- [ ] Run from root:
```bash
pnpm gen:corpus 2>/dev/null || true
pnpm run typecheck
pnpm run test
pnpm run build
```
Expected: all workspace packages green (turbo runs typecheck across all 12 packages; admin + worker + sdk-react tests pass; admin build emits both SPAs).

- [ ] Manual browser verification (Phase 1 Task 1.15) recorded.

---

## Self-review notes (author checklist)

- **Spec coverage:** Phase 0 (D2 gate), Phase 1 (D1/D4/D5/D6/D7/D8 — SPAs), Phase 2 (Worker HTML + emails), Phase 3 (D9 — SDK) all have tasks. ✓
- **Token gotcha** (neutral vs colored accent) is called out in Reference A and repeated in the recipe. ✓
- **Type consistency:** wrapper APIs (`ConfirmDialog.confirmVariant` now `"danger"`, `useToast` shim shape, `DataTable` re-exports keyset types) are defined once and referenced by the migration recipe. ✓
- **Known relaxation:** the 32-file view migration uses a map-driven recipe rather than pasting each file's full post-migration source (impractical + brittle at this scale); every file's exact import set and transformations are enumerated, and each is guarded by its existing colocated test. This is the deliberate exception to "full code per step" for mechanical bulk edits.
