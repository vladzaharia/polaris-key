import * as React from "react";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ThemeProvider } from "../components/theme.js";
import { Button } from "../ui/Button.js";
import { Announcer } from "../ui/LiveRegion.js";
import { AppToaster, toast } from "../ui/toast.js";
import type { PortalAccount } from "./api.js";
import { ActivateProvider, useActivate } from "./activate.js";
import {
  JumpIconButton,
  JumpPalette,
  JumpTrigger,
} from "./components/JumpPalette.js";
import { PortalShell } from "./components/PortalShell.js";
import { useLibrary } from "./library.js";
import { SCALE_THRESHOLD } from "./model/libraryView.js";
import { StarScreen } from "./components/States.js";
import { announceSignedIn } from "./session.js";
import {
  consumeQuietSignOut,
  createPortalQueryClient,
  useSession,
} from "./data.js";
import { portalErrorCopy } from "./errors.js";
import { AccountPage } from "./pages/AccountPage.js";
import { DiscoverPage } from "./pages/DiscoverPage.js";
import { DownloadFlowPage } from "./pages/DownloadFlowPage.js";
import { FreeDevicePage } from "./pages/FreeDevicePage.js";
import { LibraryPage } from "./pages/LibraryPage.js";
import { ProductPage } from "./pages/ProductPage.js";
import { SignInPage } from "./pages/SignInPage.js";
import { StorefrontPage } from "./pages/StorefrontPage.js";
import { restoreCarriedKey } from "./carriedKey.js";
import {
  activateContext,
  rewriteActivatePath,
  setParams,
  type ActivateContext,
  useDocumentTitle,
  useRoute,
  type PortalRoute,
} from "./router.js";
import { t } from "../lib/copy.js";

/**
 * The customer site, Polaris Key at `key.plrs.im` (docs/design/PORTAL.md).
 *
 * Providers (theme, the query client, toasts) → the session → either the login card (signed
 * out, the URL kept so sign-in returns to it) or the signed-in shell with the routed page and
 * the one Activate license modal.
 */
export function PortalApp(): React.ReactElement {
  const [client] = React.useState(() => {
    rewriteActivatePath();
    restoreCarriedKey();
    return createPortalQueryClient();
  });
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <AppToaster phoneBottom />
        <Announcer />
        <Boot />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function Boot(): React.ReactElement {
  const session = useSession();
  const qc = useQueryClient();
  const signedOut = session.data === null;
  // Signed out mid-visit: say so (a toast) as the login card takes over (§4.28).
  const wasSignedIn = React.useRef(false);
  React.useEffect(() => {
    if (session.data) wasSignedIn.current = true;
    else if (session.data === null && wasSignedIn.current) {
      wasSignedIn.current = false;
      if (!consumeQuietSignOut())
        toast.info(t("signin.session.toastTitle"), {
          description: t("signin.session.toastBody"),
        });
    }
  }, [session.data]);
  // Signed out (or deleted): nothing of the last account stays in the cache.
  React.useEffect(() => {
    if (!signedOut) return;
    for (const key of [
      "licenses",
      "license",
      "releases",
      "library",
      "downloads",
      "product",
      "registryTokens",
      "discover",
      "storefront",
    ])
      qc.removeQueries({ queryKey: ["portal", key] });
  }, [signedOut, qc]);
  if (session.isPending) {
    return <StarScreen title="Opening Polaris Key" busy />;
  }
  if (session.error) {
    const copy = portalErrorCopy(session.error);
    return (
      <StarScreen title={copy.title}>
        <BootTitle title={copy.title} />
        <p className="text-fg-muted">{copy.description}</p>
        <Button variant="outline" onClick={() => void session.refetch()}>
          {t("signin.retry")}
        </Button>
      </StarScreen>
    );
  }
  if (!session.data) return <SignInPage />;
  return (
    <ActivateProvider>
      <SignedIn account={session.data.account} />
    </ActivateProvider>
  );
}

function BootTitle({ title }: { title: string }): null {
  useDocumentTitle(title);
  return null;
}

function SignedIn({ account }: { account: PortalAccount }): React.ReactElement {
  const route = useRoute();
  // Another tab waiting on "Check your email" signs itself in now (§4.4).
  React.useEffect(() => announceSignedIn(), []);
  // Focused flows (§4.25, PX-10) run in their own minimal chrome, outside the shell.
  if (route.kind === "focused") {
    return route.flow === "free-device" ? (
      <FreeDevicePage
        key={route.product}
        account={account}
        product={route.product}
        params={route.params}
      />
    ) : (
      <DownloadFlowPage
        key={route.product}
        account={account}
        product={route.product}
        params={route.params}
      />
    );
  }
  return <SignedInShell account={account} route={route} />;
}

function SignedInShell({
  account,
  route,
}: {
  account: PortalAccount;
  route: Exclude<PortalRoute, { kind: "focused" }>;
}): React.ReactElement {
  const activate = useActivate();

  // `#/?activate=<key>` (and `/activate#key=…`, rewritten to it) opens the modal over the
  // Library with the key filled in, with what the link carried. A hash written by hand goes
  // through the same sanitiser as the link (`activateContext`). The parameters are consumed so a
  // reload doesn't re-open it.
  const linkParams = route.kind === "library" ? route.params : null;
  const activateParam = linkParams?.get("activate") ?? null;
  const ctx: ActivateContext = linkParams ? activateContext(linkParams) : {};
  const productParam = ctx.product ?? null;
  const nextParam = ctx.next ?? null;
  const forParam = ctx.for ?? null;
  const returnParam = ctx.return ?? null;
  React.useEffect(() => {
    if (activateParam === null) return;
    activate.open({
      key: activateParam || undefined,
      product: productParam ?? undefined,
      next: nextParam ?? undefined,
      forDevice: forParam ?? undefined,
      returnTo: returnParam ?? undefined,
    });
    setParams({
      activate: null,
      product: null,
      next: null,
      for: null,
      return: null,
    });
  }, [activateParam, productParam, nextParam, forParam, returnParam, activate]);

  // ⌘K (§4.27) from 8 products.
  const lib = useLibrary();
  const libraryCount = lib.products ? lib.products.length : null;
  const scaled = (lib.products?.length ?? 0) >= SCALE_THRESHOLD;
  const [jumpOpen, setJumpOpen] = React.useState(false);
  React.useEffect(() => {
    if (!scaled) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setJumpOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scaled]);

  return (
    <PortalShell
      account={account}
      route={route}
      libraryCount={libraryCount}
      discoverCount={lib.discoverCount}
      headerExtra={
        scaled ? <JumpTrigger onOpen={() => setJumpOpen(true)} /> : null
      }
      phoneHeaderExtra={
        scaled ? <JumpIconButton onOpen={() => setJumpOpen(true)} /> : null
      }
    >
      <Page route={route} account={account} />
      {scaled ? (
        <JumpPalette
          open={jumpOpen}
          onOpenChange={setJumpOpen}
          products={lib.products ?? []}
          onActivate={() => activate.open()}
        />
      ) : null}
    </PortalShell>
  );
}

function Page({
  route,
  account,
}: {
  route: Exclude<PortalRoute, { kind: "focused" }>;
  account: PortalAccount;
}): React.ReactElement {
  switch (route.kind) {
    case "library":
      return <LibraryPage account={account} params={route.params} />;
    case "discover":
      return <DiscoverPage params={route.params} />;
    case "storefront":
      return <StorefrontPage key={route.product} product={route.product} />;
    case "product":
      return (
        <ProductPage
          key={route.product}
          account={account}
          product={route.product}
          section={route.section}
          params={route.params}
        />
      );
    case "account":
      return (
        <AccountPage
          account={account}
          section={route.section}
          params={route.params}
        />
      );
  }
}
