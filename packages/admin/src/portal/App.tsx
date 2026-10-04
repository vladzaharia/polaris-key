import * as React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "../components/theme.js";
import { Button } from "../ui/Button.js";
import { Announcer } from "../ui/LiveRegion.js";
import { AppToaster, toast } from "../ui/toast.js";
import type { PortalAccount } from "./api.js";
import { ActivateProvider, useActivate } from "./activate.js";
import { PortalShell } from "./components/PortalShell.js";
import { StarScreen } from "./components/States.js";
import { createPortalQueryClient, useLicenses, useSession } from "./data.js";
import { portalErrorCopy } from "./errors.js";
import { AccountPage } from "./pages/AccountPage.js";
import { DiscoverPage } from "./pages/DiscoverPage.js";
import { LibraryPage } from "./pages/LibraryPage.js";
import { ProductPage } from "./pages/ProductPage.js";
import { SignInPage } from "./pages/SignInPage.js";
import {
  rewriteActivatePath,
  setParams,
  useDocumentTitle,
  useRoute,
  type PortalRoute,
} from "./router.js";

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
    return createPortalQueryClient(() =>
      toast.info("You were signed out", {
        description: "Sign in again to carry on where you were.",
      }),
    );
  });
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <AppToaster />
        <Announcer />
        <Boot />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function Boot(): React.ReactElement {
  const session = useSession();
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
          Try again
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
  const licenses = useLicenses();
  const activate = useActivate();
  const libraryCount = licenses.data
    ? new Set(licenses.data.map((l) => l.product)).size
    : null;

  // `#/?activate=<key>` (and `/activate?key=…`, rewritten to it) opens the modal over the
  // Library with the key filled in; the parameter is consumed so a reload doesn't re-open it.
  const activateParam =
    route.kind === "library" ? route.params.get("activate") : null;
  const productParam =
    route.kind === "library" ? route.params.get("product") : null;
  React.useEffect(() => {
    if (activateParam === null) return;
    activate.open({
      key: activateParam || undefined,
      product: productParam ?? undefined,
    });
    setParams({ activate: null, product: null });
  }, [activateParam, productParam, activate]);

  return (
    <PortalShell account={account} route={route} libraryCount={libraryCount}>
      <Page route={route} account={account} />
    </PortalShell>
  );
}

function Page({
  route,
  account,
}: {
  route: PortalRoute;
  account: PortalAccount;
}): React.ReactElement {
  switch (route.kind) {
    case "library":
      return <LibraryPage account={account} />;
    case "discover":
      return <DiscoverPage />;
    case "product":
      return (
        <ProductPage
          key={route.product}
          product={route.product}
          section={route.section}
          params={route.params}
        />
      );
    case "account":
      return <AccountPage account={account} section={route.section} />;
  }
}
