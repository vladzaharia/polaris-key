/**
 * Product → Sign-in → Clients (I-21.14; identity.clients): Sign in with <Product>. The issuer
 * switch and its addresses, then the registered clients: name, type, redirects, people in 30 days,
 * status. A manifest client reads "From .pkey" and is edited there. States: loading, error, the
 * issuer off, no client yet, and the list. A secret is never on this page.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import type { IdentityClient } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { formatCount } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Section } from "../../../../ui/Section.js";
import { toast } from "../../../../ui/toast.js";
import { blocker, NEEDS_REASON } from "../../../../ui/confirmReasons.js";
import { ReasonField } from "../../../../ui/ReasonField.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { useWriteGate } from "../../../access/useCan.js";
import { ProductSettingsSection } from "../../../components/ProductSettingsSection.js";
import { useProduct } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { reads } from "../../../data/reads.js";
import { SettingsSection } from "../../../templates/Settings.js";
import { Link, navigate } from "../../../router.js";
import { r } from "../../../routes.js";
import { identityClientsQuery } from "../data.js";
import { ClientDrawer } from "../clients/ClientForm.js";
import { hostsOf, TYPE_LABEL } from "../clients/model.js";
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
const COLS = "sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_6rem_1rem]";

export function clientStatus(c: IdentityClient): {
  tone: "neutral" | "info";
  label: string;
} | null {
  if (c.status === "disabled") return { tone: "neutral", label: "Disabled" };
  return null;
}

/** An address that wraps at its slashes, never inside a word. */
function Breakable({ value }: { value: string }): React.ReactElement {
  const parts = value.split("/");
  return (
    <>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 ? (
            <>
              /<wbr />
            </>
          ) : null}
          {p}
        </React.Fragment>
      ))}
    </>
  );
}

function Address({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 text-sm text-fg-strong [overflow-wrap:break-word]">
          <Breakable value={value} />
        </code>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </dd>
    </div>
  );
}

/** What the switch's confirmation and the first-run action both say about turning the provider on. */
const providerCopy = (name: string) => ({
  label: `Sign in with ${name}`,
  claim: "This overrides .pkey/product until you revert it.",
  title: (to: unknown) =>
    to === true
      ? `Turn on Sign in with ${name}?`
      : `Turn off Sign in with ${name}?`,
  button: (to: unknown) => (to === true ? "Turn on" : "Turn off"),
  consequences: (to: unknown) =>
    to === true
      ? [
          "Clients you register can sign people in, once they agree on the card.",
        ]
      : [
          "Every client stops working. Tokens already issued expire within 10 minutes, and refresh tokens are revoked.",
        ],
});

/**
 * The first run's one step: turn the provider on. The same confirmation as the switch (a
 * caution, a reason for the activity log), saved against the version the switch row reads.
 */
function TurnOnDialog({
  slug,
  name,
  open,
  onOpenChange,
}: {
  slug: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const settings = useQuery(reads.productSettings(slug, ISSUER_AREA));
  const row = settings.data?.settings.find((x) => x.key === ISSUER_KEY);
  const [reason, setReason] = React.useState("");
  const copy = providerCopy(name);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setReason("");
        onOpenChange(o);
      }}
      intent="caution"
      title={copy.title(true)}
      consequences={[...copy.consequences(true), copy.claim]}
      confirmLabel={copy.button(true)}
      confirmDisabled={reason.trim() === "" || !row}
      confirmDisabledReason={blocker(
        [!row, "Wait for the setting to load"],
        [reason.trim() === "", NEEDS_REASON],
      )}
      stepUpKey={`identity-issuer-on:${slug}`}
      stepUpState={{ reason }}
      onRestore={(saved) => setReason(saved.reason ?? "")}
      describeError={(e) => errorCopy(e, { thing: "Setting" })}
      onConfirm={async () => {
        if (!row) return;
        await mutate("updateProductSetting", slug, ISSUER_KEY, {
          value: true,
          expectedVersion: row.version,
          reason: reason.trim(),
        });
        toast.success(`Sign in with ${name} is on`);
      }}
    >
      <ReasonField value={reason} onValueChange={setReason} />
    </ConfirmDialog>
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
  const keys = useWriteGate("keys", slug);
  const [open, setOpen] = React.useState(false);
  const [turnOn, setTurnOn] = React.useState(false);
  const name = product.data?.name ?? slug;
  const d = q.data;
  const full = !!d && d.clients.length >= d.limit;
  const offReason =
    d && !d.issuer.enabled ? `Turn on Sign in with ${name} first.` : undefined;
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
      title="Clients"
      description={`Websites and apps that sign people in with ${name}.`}
      // First run: the empty state's step is the one primary.
      primaryAction={
        d && !(!d.issuer.enabled && d.clients.length === 0)
          ? register
          : undefined
      }
      refetching={q.isFetching && !q.isPending}
    />
  );
  if (q.isPending)
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="Clients" />
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
  const copy = providerCopy(name);
  return (
    <div className="space-y-6">
      {header}
      <SettingsSection id="issuer" title={`Sign in with ${name}`}>
        <ProductSettingsSection
          bare
          slug={slug}
          area={ISSUER_AREA}
          keys={[ISSUER_KEY]}
          id="issuer"
          title="Provider"
          copy={{
            [ISSUER_KEY]: {
              label: copy.label,
              claim: copy.claim,
              consequences: copy.consequences,
              confirm: (to) => ({
                title: copy.title(to),
                confirmLabel: copy.button(to),
              }),
              saved: (to) => `Sign in with ${name} is ${to ? "on" : "off"}`,
            },
          }}
        />
        {d.issuer.enabled ? (
          <dl className="grid gap-4 px-5 py-4 lg:grid-cols-2">
            <Address label="Issuer" value={d.issuer.url} />
            <Address label="Discovery" value={d.issuer.discoveryUrl} />
          </dl>
        ) : null}
      </SettingsSection>
      {!d.issuer.enabled && d.clients.length > 0 ? (
        <Callout tone="warning" title={`Sign in with ${name} is off`}>
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
          d.issuer.enabled ? (
            <EmptyState
              kind="first-run"
              variant="inline"
              title="No clients yet"
              description="Register a website or app, or declare clients in .pkey/product."
              primaryAction={register}
              docs="/docs/features/sign-in/sign-in-with-product/"
            />
          ) : (
            <EmptyState
              kind="first-run"
              variant="inline"
              title={`Turn on Sign in with ${name} to register your first website or app`}
              description="Clients can sign people in with their Polaris Locker account once it is on. You can also declare clients in .pkey/product."
              primaryAction={
                <Button
                  disabledReason={keys.disabledReason}
                  onClick={() => setTurnOn(true)}
                >
                  {`Turn on Sign in with ${name}`}
                </Button>
              }
              docs="/docs/features/sign-in/sign-in-with-product/"
            />
          )
        ) : (
          <ul className="divide-y divide-border">
            <li
              aria-hidden
              className={`hidden gap-x-4 pb-2 text-xs text-fg-muted sm:grid ${COLS}`}
            >
              <span>Client</span>
              <span>Redirects to</span>
              <span className="text-end">People, 30 days</span>
              <span />
            </li>
            {d.clients.map((c) => {
              const s = clientStatus(c);
              const hosts = hostsOf(c.redirectUris);
              return (
                <li key={c.id}>
                  <Link
                    to={r.identityClient(slug, c.id)}
                    className={`grid items-center gap-x-4 gap-y-1 py-3 hover:bg-hover ${COLS}`}
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-medium text-accent-fg">
                          {c.name}
                        </span>
                        {s ? (
                          <StatusPill tone={s.tone} size="sm">
                            {s.label}
                          </StatusPill>
                        ) : null}
                      </span>
                      <span className="block text-xs text-fg-muted">
                        {TYPE_LABEL[c.type]}
                        {c.partner && c.developerName
                          ? ` · by ${c.developerName}`
                          : ""}
                        {c.origin === "manifest" ? " · From .pkey/product" : ""}
                      </span>
                      <span className="block break-words text-xs text-fg-muted sm:hidden">
                        {hosts}
                        {hosts ? " · " : ""}
                        {formatCount(c.people30d)} in 30 days
                      </span>
                    </span>
                    <span className="hidden min-w-0 break-words text-xs text-fg-muted sm:block">
                      <span className="sr-only">Redirects to: </span>
                      {hosts}
                    </span>
                    <span className="hidden text-end text-sm text-fg sm:block">
                      <span className="sr-only">People, 30 days: </span>
                      {formatCount(c.people30d)}
                    </span>
                    <ChevronRight
                      aria-hidden
                      className="hidden size-4 text-fg-muted sm:block"
                    />
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
      <TurnOnDialog
        slug={slug}
        name={name}
        open={turnOn}
        onOpenChange={setTurnOn}
      />
    </div>
  );
}
