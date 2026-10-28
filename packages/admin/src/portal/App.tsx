import * as React from "react";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ThemeProvider } from "../components/theme.js";
import { Button } from "../ui/Button.js";
import { Announcer } from "../ui/LiveRegion.js";
import { AppToaster, toast } from "../ui/toast.js";
import type { PortalAccount } from "./api.js";
import { ActivateProvider, useActivate } from "./activate.js";
import { JumpIconButton, JumpPalette } from "./components/JumpPalette.js";
import { PortalShell } from "./components/PortalShell.js";
import { useLibrary } from "./library.js";
import { PortalErrorBoundary } from "./components/PortalErrorBoundary.js";
import { SCALE_THRESHOLD } from "./model/libraryView.js";
import { StarScreen } from "./components/States.js";
import { announceSignedIn } from "./session.js";
import {
  endSecondSignIn,
  secondSignInEmail,
  secondSignInFrom,
} from "./linkSecond.js";
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
import { AddMethodNudge } from "./components/AddMethodNudge.js";
import { ApproveDeviceDialog } from "./components/ApproveDeviceDialog.js";
import { LinkAccountsDialog } from "./components/LinkAccountsDialog.js";
import { consumeStepUpReturn } from "./focus.js";
import { commitLastMethod } from "./lastMethod.js";
import { SignInPage } from "./pages/SignInPage.js";
import { RequestFlow } from "./components/signin/RequestFlow.js";
import { requestHandleFromUrl } from "./model/signInRequest.js";
import { StorefrontPage } from "./pages/StorefrontPage.js";
import { restoreCarriedKey } from "./carriedKey.js";
import {
  activateContext,
  rewriteActivatePath,
  focusPageHeading,
  navigate,
  setParams,
  type ActivateContext,
  useDocumentTitle,
  useRoute,
  type PortalRoute,
} from "./router.js";
import { bindWriteInvalidation, mutate } from "./mutations.js";
import { portalVoice } from "./errors.js";
import { ErrorVoiceProvider } from "../ui/errorVoice.js";
import { qkFamily } from "./queries.js";
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
  // Writes made outside a hook (`mutate`) invalidate in this tree's client.
  React.useEffect(() => bindWriteInvalidation(client), [client]);
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <ErrorVoiceProvider voice={portalVoice}>
          <AppToaster phoneBottom />
          <Announcer />
          <Boot />
        </ErrorVoiceProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function Boot(): React.ReactElement {
  const session = useSession();
  const qc = useQueryClient();
  const signedOut = session.data === null;
  // The join's second proof: the login card while still signed in (linkSecond.ts).
  const route = useRoute();
  const csrf = session.data?.csrf ?? null;
  const from = secondSignInFrom();
  const onLink = route.kind === "account" && route.params.get("link") !== null;
  const second = from !== null && csrf !== null && from === csrf && onLink;
  React.useEffect(() => {
    // Somewhere else, or a different session now (the sign-in happened): the mode is over.
    if (from !== null && (!onLink || (csrf !== null && from !== csrf)))
      endSecondSignIn();
  }, [from, csrf, onLink]);
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
      qc.removeQueries({ queryKey: qkFamily(key) });
  }, [signedOut, qc]);
  // B-065: this tab was signed out and is signed in now. The code or sign-in control that had focus
  // is gone, so focus would fall to `body`: it goes to the page's h1 instead, as a navigation does.
  // A load that is already signed in keeps the browser's own start (the skip link). An app's
  // sign-in (`/signin?request=`) manages its own focus.
  const sawSignedOut = React.useRef(false);
  // The same for an app's sign-in, whose card is not mounted yet: its first step takes the focus.
  const [signedInHere, setSignedInHere] = React.useState(false);
  React.useEffect(() => {
    if (session.data === null) sawSignedOut.current = true;
    else if (session.data && sawSignedOut.current) {
      sawSignedOut.current = false;
      if (window.location.pathname !== "/signin") focusPageHeading();
      else setSignedInHere(true);
    }
  }, [session.data]);
  if (session.isPending) {
    return <StarScreen title="Opening Polaris Locker" busy />;
  }
  if (session.error) {
    const found = portalErrorCopy(session.error);
    // The catch-all names what failed ("Couldn't open Polaris Locker"); a network failure or a
    // specific refusal keeps the catalog's own sentence.
    const copy = found.generic
      ? {
          title: t("locker.error.boot.title"),
          description: t("locker.error.boot.body"),
        }
      : found;
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
  // An app's sign-in (`/signin?request=rq_…`) continues in the card, not in the library.
  if (window.location.pathname === "/signin") {
    const handle = requestHandleFromUrl();
    if (handle)
      return (
        <RequestFlow
          account={session.data.account}
          handle={handle}
          focusOnArrival={signedInHere}
        />
      );
  }
  if (second)
    return (
      <SignInPage
        other={{
          email: secondSignInEmail() ?? undefined,
          onCancel: () => {
            endSecondSignIn();
            void mutate("linkCancel").catch(() => undefined);
            navigate("#/account");
            // Say which account this browser is still signed in to, once; focus goes to the page.
            toast.info(
              t("signin.join.stillSignedIn", {
                email: session.data?.account.email ?? "",
              }),
            );
            focusPageHeading();
          },
        }}
      />
    );
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
  // Back from a provider's step-up (a fresh load): focus goes to the page heading, not the top of
  // the document. A link that asks for its own focus (`?add=`, `?connect=`) keeps it.
  React.useEffect(() => {
    if (!consumeStepUpReturn()) return;
    const p = "params" in route ? route.params : null;
    if (p?.has("add") || p?.has("connect")) return;
    focusPageHeading();
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The way this tab signed in is remembered for next time's hint (lastMethod.ts).
  React.useEffect(() => {
    void commitLastMethod(account);
  }, [account.email]);
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
  // The Library's data is read in SignedInShell, so a malformed field throws above the page
  // outlet: the boundary's fallback is the shell itself, with the header and menus intact.
  return (
    <PortalErrorBoundary
      resetKey={window.location.hash}
      frame={(body) => (
        <PortalShell
          account={account}
          route={route}
          libraryCount={null}
          discoverCount={null}
        >
          {body}
        </PortalShell>
      )}
    >
      <SignedInShell account={account} route={route} />
    </PortalErrorBoundary>
  );
}

function SignedInShell({
  account,
  route,
}: {
  account: PortalAccount;
  route: Exclude<PortalRoute, { kind: "focused" }>;
}): React.ReactElement {
  const activate = useActivate();
  // `#/account?approve=<code>` (the QR's link, or Approve a new device): the dialog over Account.
  const approve = "params" in route ? route.params.get("approve") : null;
  // `#/account?link=1` (Link an existing account, and where the other sign-in returns).
  const link = "params" in route ? route.params.get("link") : null;

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
        // The Library's toolbar search takes ⌘K while it is on screen (LibraryToolbar).
        if (document.querySelector("[data-library-search]")) return;
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
      phoneHeaderExtra={
        scaled && route.kind !== "library" ? (
          <JumpIconButton onOpen={() => setJumpOpen(true)} />
        ) : null
      }
    >
      <AddMethodNudge route={route} accountId={account.id} />
      <Page route={route} account={account} />
      {route.kind === "account" && link !== null ? (
        <LinkAccountsDialog
          undoId={route.params.get("undo") ?? undefined}
          onClose={() => setParams({ link: null, undo: null })}
        />
      ) : null}
      {route.kind === "account" && approve !== null ? (
        <ApproveDeviceDialog
          code={approve}
          onClose={() => setParams({ approve: null })}
        />
      ) : null}
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
      return <DiscoverPage params={route.params} account={account} />;
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
