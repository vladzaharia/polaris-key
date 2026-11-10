/**
 * Product → Sign-in → Clients → one client (I-21.14): its settings, its secrets, its usage, and
 * Disable and Delete. A secret is minted here and shown once (`pkeycs_` stays visible so a
 * scanner finds a leak); the list keeps the prefix and the last four characters, and the last use.
 * A web client holds up to two live secrets, so one can be replaced without a gap. A client from
 * `.pkey/product` is read-only, except that it can be disabled.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Pencil } from "lucide-react";
import { HttpError, type IdentityClientRecord } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { OneTimeSecretDialog } from "../../../../ui/OneTimeSecretPanel.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Section } from "../../../../ui/Section.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { toast } from "../../../../ui/toast.js";
import { useWriteGate } from "../../../access/useCan.js";
import { Breadcrumbs } from "../../../components/Breadcrumbs.js";
import { useProduct } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { Link, navigate } from "../../../router.js";
import { r } from "../../../routes.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { identityClientQuery, identityClientsQuery } from "../data.js";
import { ClientDrawer } from "../clients/ClientForm.js";
import { CLAIMS, scopeLabel, TYPE_LABEL } from "../clients/model.js";

const FROM_MANIFEST =
  "This client is declared in .pkey/product. Edit it there.";

/** Focus the element `find` returns once it exists (the page re-renders after a change). */
function focusSoon(find: () => HTMLElement | null | undefined): void {
  let tries = 0;
  const go = () => {
    const el = find();
    if (el) el.focus();
    else if (tries++ < 30) requestAnimationFrame(go);
  };
  // After the dialog has closed and handed focus back to a button that may be gone.
  window.setTimeout(go, 250);
}

const buttonNamed = (name: string) => () =>
  [...document.querySelectorAll<HTMLElement>("main button")].find(
    (b) => b.textContent?.trim() === name,
  );

function List({ items }: { items: string[] }): React.ReactElement {
  return items.length === 0 ? (
    <span className="text-fg-muted">None</span>
  ) : (
    <ul className="space-y-1">
      {items.map((x) => (
        <li key={x} className="break-all font-mono text-sm">
          {x}
        </li>
      ))}
    </ul>
  );
}

export function IdentityClientPage({
  slug,
  id,
}: {
  slug: string;
  id: string;
}): React.ReactElement {
  const q = useQuery(identityClientQuery(slug, id));
  const page = useQuery(identityClientsQuery(slug));
  const product = useProduct(slug);
  const gate = useWriteGate("signin", slug);
  const [editing, setEditing] = React.useState(false);
  const [confirm, setConfirm] = React.useState<
    | null
    | "disable"
    | "enable"
    | "delete"
    | "secret"
    | { revoke: { id: string; hint: string; lastUsedAt: number | null } }
  >(null);
  const [minted, setMinted] = React.useState<{
    value: string;
    hint: string;
  } | null>(null);
  const d: IdentityClientRecord | undefined = q.data;
  const c = d?.client;
  const crumbs = [
    { label: "Clients", to: r.identityClients(slug) },
    { label: c?.name ?? "Client" },
  ];
  if (q.isPending)
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={<Breadcrumbs items={crumbs} />} title="Client" />
        <PageSkeleton template="form" label="Client" />
      </div>
    );
  if (q.isError || !d || !c) {
    const missing = q.error instanceof HttpError && q.error.status === 404;
    return missing ? (
      <div className="space-y-6">
        <PageHeader
          eyebrow={
            <Breadcrumbs
              items={[
                { label: "Clients", to: r.identityClients(slug) },
                { label: "Not found" },
              ]}
            />
          }
          title="Client not found"
          description="It may have been deleted, or the address is wrong."
          primaryAction={
            <Button asChild>
              <Link to={r.identityClients(slug)}>Back to clients</Link>
            </Button>
          }
        />
      </div>
    ) : (
      <div className="space-y-6">
        <PageHeader eyebrow={<Breadcrumbs items={crumbs} />} title="Client" />
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          context={{ thing: "Client" }}
        />
      </div>
    );
  }
  const fromManifest = c.origin === "manifest";
  const revoking =
    typeof confirm === "object" && confirm !== null
      ? confirm.revoke
      : undefined;
  const issuerOff = page.data ? !page.data.issuer.enabled : false;
  const editReason =
    gate.disabledReason ?? (fromManifest ? FROM_MANIFEST : undefined);
  const secretReason =
    gate.disabledReason ??
    (c.status === "disabled"
      ? "Enable the client first."
      : d.secrets.length >= d.secretLimit
        ? `A client holds at most ${d.secretLimit} secrets. Revoke one first.`
        : undefined);
  const failure = (e: unknown) => errorCopy(e, { thing: "Client" });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<Breadcrumbs items={crumbs} />}
        title={c.name}
        titleAside={
          c.status === "disabled" ? (
            <StatusPill tone="neutral" size="sm">
              Disabled
            </StatusPill>
          ) : undefined
        }
        description={TYPE_LABEL[c.type]}
        meta={
          fromManifest ? (
            <StatusPill tone="neutral" size="sm">
              From .pkey/product
            </StatusPill>
          ) : undefined
        }
        secondaryActions={[
          {
            label: "Edit",
            icon: <Pencil aria-hidden />,
            disabledReason: editReason,
            onSelect: () => setEditing(true),
          },
          c.status === "disabled"
            ? {
                label: "Enable",
                disabledReason: gate.disabledReason,
                onSelect: () => setConfirm("enable"),
              }
            : {
                label: "Disable",
                disabledReason: gate.disabledReason,
                onSelect: () => setConfirm("disable"),
              },
        ]}
        dangerActions={[
          {
            label: "Delete",
            disabledReason:
              gate.disabledReason ??
              (fromManifest
                ? "Remove it from .pkey/product, or disable it here."
                : undefined),
            onSelect: () => setConfirm("delete"),
          },
        ]}
      />
      {issuerOff ? (
        <Callout tone="warning" title="Sign in is off">
          This client can't sign anyone in until you turn Sign in with{" "}
          {product.data?.name ?? slug} on.
        </Callout>
      ) : null}
      <Section title="Settings">
        <DescriptionList
          columns={2}
          items={[
            {
              term: "Client ID",
              detail: (
                <span className="flex items-center gap-2">
                  <code className="break-all text-sm">{c.id}</code>
                  <CopyButton value={c.id} label="Copy client ID" />
                </span>
              ),
            },
            ...(page.data
              ? [
                  {
                    term: "Discovery",
                    detail: (
                      <span className="flex items-start gap-2">
                        <code className="min-w-0 text-sm [overflow-wrap:break-word]">
                          {page.data.issuer.discoveryUrl}
                        </code>
                        <CopyButton
                          value={page.data.issuer.discoveryUrl}
                          label="Copy discovery address"
                        />
                      </span>
                    ),
                  },
                ]
              : []),
            { term: "Key", detail: <code className="text-sm">{c.key}</code> },
            {
              term: "Developer",
              detail: c.developerName ?? "The product's developer",
            },
            {
              term: "Redirect addresses",
              detail: <List items={c.redirectUris} />,
            },
            {
              term: "Sign-out addresses",
              detail: <List items={c.postLogoutRedirectUris} />,
            },
            {
              term: "What it gets",
              detail: c.scopes
                .map((x, i) =>
                  i === 0 ? scopeLabel(x) : scopeLabel(x).toLowerCase(),
                )
                .join(", "),
            },
            {
              term: "Always shared",
              detail:
                c.claimsRequired.length === 0
                  ? "None"
                  : c.claimsRequired
                      .map((x) => CLAIMS.find((k) => k.id === x)?.label ?? x)
                      .join(", "),
            },
          ]}
        />
      </Section>
      <Section
        title="Client secret"
        description={
          c.type === "web"
            ? "The client proves itself with a secret, from its server only. Two can be live, so one can replace the other."
            : undefined
        }
        actions={
          c.type === "web" ? (
            <Button
              id="generate-secret"
              size="sm"
              iconStart={<KeyRound />}
              disabledReason={secretReason}
              onClick={() => setConfirm("secret")}
            >
              Generate secret
            </Button>
          ) : undefined
        }
      >
        {c.type !== "web" ? (
          <p className="text-sm text-fg-muted">
            {c.type === "spa" ? "A single-page app" : "A native app"} holds no
            secret: it proves the sign-in with PKCE.
          </p>
        ) : d.secrets.length === 0 ? (
          <EmptyState
            kind="first-run"
            variant="inline"
            title="No secret yet"
            description="Generate one for the client's server. It is shown once."
          />
        ) : (
          <ul className="divide-y divide-border">
            {d.secrets.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3"
              >
                <div className="min-w-0">
                  <code className="text-sm text-fg-strong">{s.hint}</code>
                  <p className="text-xs text-fg-muted">
                    Created{" "}
                    <Timestamp at={fromSeconds(s.createdAt)} format="date" />
                    {" · "}
                    {s.lastUsedAt === null ? (
                      "Never used"
                    ) : (
                      <>
                        Last used{" "}
                        <Timestamp
                          at={fromSeconds(s.lastUsedAt)}
                          format="relative"
                        />
                      </>
                    )}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Revoke secret ending ${s.hint.slice(-4)}`}
                  disabledReason={gate.disabledReason}
                  onClick={() =>
                    setConfirm({
                      revoke: {
                        id: s.id,
                        hint: s.hint,
                        lastUsedAt: s.lastUsedAt,
                      },
                    })
                  }
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Usage">
        <DescriptionList
          columns={2}
          items={[
            { term: "People, last 30 days", detail: formatCount(c.people30d) },
            { term: "People who agreed", detail: formatCount(c.people) },
            {
              term: "Last sign-in",
              detail:
                d.lastUsedAt === null ? (
                  "None yet"
                ) : (
                  <Timestamp at={fromSeconds(d.lastUsedAt)} format="relative" />
                ),
            },
            {
              term: "Refresh tokens end after",
              detail: `${d.refreshIdleDays} days idle`,
            },
          ]}
        />
      </Section>

      <ClientDrawer
        slug={slug}
        client={c}
        open={editing}
        onOpenChange={setEditing}
      />
      <OneTimeSecretDialog
        open={minted !== null}
        onOpenChange={(o) => {
          if (!o) setMinted(null);
        }}
        title={`Copy ${c.name}'s secret`}
        label="Client secret"
        value={minted?.value ?? ""}
        hint="Shown once. Polaris Key stores only its hash. Keep it on the client's server."
        onDone={() => setMinted(null)}
      />
      <ConfirmDialog
        open={confirm === "secret"}
        onOpenChange={(o) => setConfirm(o ? "secret" : null)}
        stepUpKey={`identity-client-secret:${c.id}`}
        intent="caution"
        title="Generate a secret?"
        consequences={[
          "It is shown once, on the next screen.",
          d.secrets.length > 0
            ? "The current secret keeps working until you revoke it."
            : "The client can then sign people in from its server.",
        ]}
        confirmLabel="Generate secret"
        describeError={failure}
        onConfirm={async () => {
          const res = await mutate("mintIdentityClientSecret", slug, c.id);
          setMinted({ value: res.secret.value, hint: res.secret.hint });
        }}
      />
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(o) => !o && setConfirm(null)}
        intent="danger"
        title={`Revoke ${revoking?.hint ?? "this secret"}?`}
        consequences={[
          revoking?.lastUsedAt == null ? (
            "It has never been used."
          ) : (
            <>
              Last used{" "}
              <Timestamp
                at={fromSeconds(revoking.lastUsedAt)}
                format="relative"
              />
              : the client may still be using it.
            </>
          ),
          "The client can no longer use it. A sign-in in progress that depends on it fails.",
        ]}
        confirmLabel="Revoke secret"
        describeError={failure}
        onConfirm={async () => {
          if (typeof confirm !== "object" || confirm === null) return;
          await mutate(
            "revokeIdentityClientSecret",
            slug,
            c.id,
            confirm.revoke.id,
          );
          toast.success("Secret revoked");
          focusSoon(() => document.getElementById("generate-secret"));
        }}
      />
      <ConfirmDialog
        open={confirm === "disable"}
        onOpenChange={(o) => !o && setConfirm(null)}
        intent="caution"
        title={`Disable ${c.name}?`}
        consequences={[
          "People can't sign in through it. Everyone it holds a refresh token for is signed out of it.",
          "Access tokens already issued expire within 10 minutes.",
          "You can enable it again. Nobody is asked to agree twice.",
        ]}
        confirmLabel="Disable client"
        describeError={failure}
        onConfirm={async () => {
          await mutate("disableIdentityClient", slug, c.id);
          toast.success("Client disabled");
          focusSoon(buttonNamed("Enable"));
        }}
      />
      <ConfirmDialog
        open={confirm === "enable"}
        onOpenChange={(o) => setConfirm(o ? "enable" : null)}
        stepUpKey={`identity-client-enable:${c.id}`}
        title={`Enable ${c.name}?`}
        consequences={["People can sign in through it again."]}
        confirmLabel="Enable client"
        describeError={failure}
        onConfirm={async () => {
          await mutate("enableIdentityClient", slug, c.id);
          toast.success("Client enabled");
          focusSoon(buttonNamed("Disable"));
        }}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => setConfirm(o ? "delete" : null)}
        stepUpKey={`identity-client-delete:${c.id}`}
        intent="danger"
        title={`Delete ${c.name}?`}
        consequences={[
          "Its secrets, every refresh token and what people agreed to are deleted.",
          "People are no longer signed in to it, and it can't be recovered.",
        ]}
        typedConfirmation={{ value: c.key, label: "Type the client key" }}
        focusTyped
        confirmLabel="Delete client"
        describeError={failure}
        onConfirm={async () => {
          await mutate("deleteIdentityClient", slug, c.id, c.key);
          toast.success("Client deleted");
          navigate(r.identityClients(slug));
        }}
      />
    </div>
  );
}
