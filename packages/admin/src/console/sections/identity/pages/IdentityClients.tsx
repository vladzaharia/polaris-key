/**
 * Product → Sign-in → Clients (I-21.14; identity.clients): Sign in with <Product>. The issuer
 * switch and its addresses, then the registered clients: name, type, redirects, people in 30 days,
 * status. A manifest client reads "From .pkey" and is edited there. States: loading, error, the
 * issuer off, no client yet, and the list. A secret is never on this page.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { IdentityClient } from "../../../../api.js";
import { formatCount } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Section } from "../../../../ui/Section.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { useWriteGate } from "../../../access/useCan.js";
import { ProductSettingsSection } from "../../../components/ProductSettingsSection.js";
import { useProduct } from "../../../data/hooks.js";
import { Link, navigate } from "../../../router.js";
import { r } from "../../../routes.js";
import { identityClientsQuery } from "../data.js";
import { ClientDrawer } from "../clients/ClientForm.js";
import { hostOf, TYPE_LABEL } from "../clients/model.js";
import { IdentityClientPage } from "./IdentityClient.js";

export const ISSUER_AREA = "identity.platformSignIn";
export const ISSUER_KEY = "identity.issuer.enabled";

/** The route's record: the list, or one client. */
export function IdentityClientsRoute({
  slug,
  id,
}: {
  slug: string;
  id?: string;
}): React.ReactElement {
  return id ? (
    <IdentityClientPage slug={slug} id={id} />
  ) : (
    <IdentityClientsPage slug={slug} />
  );
}

/** One column template for the header and every row, in rem so it follows the text size. */
const COLS = "sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_6rem_6rem]";

export function clientStatus(c: IdentityClient): {
  tone: "neutral" | "info";
  label: string;
} | null {
  if (c.status === "disabled") return { tone: "neutral", label: "Disabled" };
  return null;
}

function Address({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
      <dt className="shrink-0 text-sm text-fg-muted sm:w-24">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2">
        <code className="min-w-0 break-all text-sm text-fg-strong">
          {value}
        </code>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </dd>
    </div>
  );
}

export function IdentityClientsPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const product = useProduct(slug);
  const q = useQuery(identityClientsQuery(slug));
  const gate = useWriteGate("signin", slug);
  const [open, setOpen] = React.useState(false);
  const name = product.data?.name ?? slug;
  const d = q.data;
  const full = !!d && d.clients.length >= d.limit;
  const offReason =
    d && !d.issuer.enabled
      ? "Turn on Sign in with this product first."
      : undefined;
  const registerReason =
    gate.disabledReason ??
    offReason ??
    (full ? `A product has at most ${d?.limit} clients.` : undefined);
  const register = (
    <Button
      iconStart={<Plus />}
      disabledReason={registerReason}
      onClick={() => setOpen(true)}
    >
      Register client
    </Button>
  );
  const header = (
    <PageHeader
      title={`Sign in with ${name}`}
      description="Let your websites and apps sign people in with their Polaris Locker account."
      primaryAction={d ? register : undefined}
      refetching={q.isFetching && !q.isPending}
    />
  );
  if (q.isPending)
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="Sign in with this product" />
      </div>
    );
  if (q.isError || !d)
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          context={{ thing: "Clients" }}
        />
      </div>
    );
  return (
    <div className="space-y-6">
      {header}
      <ProductSettingsSection
        slug={slug}
        area={ISSUER_AREA}
        keys={[ISSUER_KEY]}
        id="issuer"
        title="Provider"
        description="Off, no client can sign anyone in and no token is issued."
        copy={{
          [ISSUER_KEY]: {
            consequences: (to) =>
              to === true
                ? [
                    "Clients you register can sign people in, once they agree on the card.",
                  ]
                : [
                    "Every client stops working. Tokens already issued expire within 10 minutes, and refresh tokens are revoked.",
                  ],
          },
        }}
      />
      {d.issuer.enabled ? (
        <Section
          title="Addresses"
          description="What a relying party needs to find this provider."
        >
          <dl className="space-y-3">
            <Address label="Issuer" value={d.issuer.url} />
            <Address label="Discovery" value={d.issuer.discoveryUrl} />
          </dl>
        </Section>
      ) : d.clients.length > 0 ? (
        <Callout tone="warning" title="Sign in with this product is off">
          {formatCount(d.clients.length)}{" "}
          {d.clients.length === 1 ? "client is" : "clients are"} registered, and
          none can sign anyone in.
        </Callout>
      ) : null}
      <Section
        title="Clients"
        description={`${d.clients.length} of ${d.limit}`}
      >
        {d.clients.length === 0 ? (
          <EmptyState
            kind="first-run"
            variant="inline"
            title="No clients yet"
            description="Register a website or app, or declare clients in .pkey/product."
            primaryAction={d.issuer.enabled ? register : undefined}
            docs="/docs/features/sign-in/sign-in-with-product/"
          />
        ) : (
          <ul className="divide-y divide-border">
            <li
              aria-hidden
              className={`hidden gap-x-4 pb-2 text-xs text-fg-muted sm:grid ${COLS}`}
            >
              <span>Client</span>
              <span>Redirects to</span>
              <span className="text-end">People, 30 days</span>
              <span className="text-end">Status</span>
            </li>
            {d.clients.map((c) => {
              const s = clientStatus(c);
              return (
                <li key={c.id}>
                  <Link
                    to={r.identityClient(slug, c.id)}
                    className={`grid items-center gap-x-4 gap-y-1 py-3 hover:bg-hover ${COLS}`}
                  >
                    <span className="min-w-0">
                      <span className="font-medium text-accent-fg">
                        {c.name}
                      </span>
                      <span className="block text-xs text-fg-muted">
                        {TYPE_LABEL[c.type]}
                        {c.partner && c.developerName
                          ? ` · by ${c.developerName}`
                          : ""}
                        {c.origin === "manifest" ? " · From .pkey" : ""}
                      </span>
                    </span>
                    <span className="min-w-0 break-all text-xs text-fg-muted">
                      {c.redirectUris.map(hostOf).join(", ")}
                    </span>
                    <span className="text-sm text-fg sm:text-end">
                      <span className="sm:hidden text-fg-muted">
                        People, 30 days:{" "}
                      </span>
                      {formatCount(c.people30d)}
                    </span>
                    <span className="sm:text-end">
                      {s ? (
                        <StatusPill tone={s.tone} size="sm">
                          {s.label}
                        </StatusPill>
                      ) : (
                        <span className="text-sm text-fg-muted">Active</span>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <ClientDrawer
        slug={slug}
        open={open}
        onOpenChange={setOpen}
        onCreated={(c) => navigate(r.identityClient(slug, c.id))}
      />
    </div>
  );
}
