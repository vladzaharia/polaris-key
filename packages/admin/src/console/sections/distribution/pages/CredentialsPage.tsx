/**
 * Distribution → Outlet credentials (ADMIN.md §6.4, T2 + drawer), moved from Keys & secrets.
 * Fixes OUT-1 to OUT-7.
 *
 * The keys a store connector signs in with (App Store Connect, Google Play, the Microsoft Store,
 * the App Store In-App Purchase key, Steam) and the Sentry integration whose alerts open halt
 * candidates (OUT-7). Sealed apart from product secrets, opened only by Distribution, every use
 * audited, values write-only: the table shows metadata and health, never a value.
 *
 * - A `DataTable` with the last result as visible text (OUT-1, OUT-6).
 * - **Set credential** is a drawer: kind first, then its fields, then the pin with the right
 *   `inputMode` (OUT-3, OUT-4). Required fields are marked and every error shows at once (OUT-5).
 *   Reusing an existing id warns that saving rotates it (OUT-2); **Rotate…** is a row action.
 * - **Pin…** changes the one store app a key may act on, without its value (P5-02f).
 * - Delete is L2 and invalidates only after the server confirms (OUT-7).
 * - The connector cards: each store connector's status and configuration actions.
 *
 * A product with no credential of a kind can use the platform's team key for its assigned app
 * (the platform store connections, A-16); a connector card says which key it is using, and the
 * pin form words the `app_assigned_elsewhere` refusal.
 */

import * as React from "react";
import { Plus } from "lucide-react";
import {
  ApiError,
  type OutletCredentialInfo,
  type OutletCredentialKind,
  type OutletCredentialsResponse,
  type PutOutletCredentialBody,
} from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import {
  DataTable,
  type DataColumn,
  type RowActionItem,
} from "../../../../ui/data-table/index.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { Dialog, DialogBody, DialogFooter } from "../../../../ui/Dialog.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../../ui/Drawer.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { SecretInput } from "../../../../ui/SecretInput.js";
import { Select } from "../../../../ui/Select.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { toast } from "../../../../ui/toast.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { mutate } from "../../../data/mutations.js";
import { Link, useSearchParam } from "../../../router.js";
import { codecs } from "../../../routes.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import {
  hrefWithQuery,
  patchQuery,
  useConnectors,
  useCredentials,
  useOutlets,
  useReleaseStore,
} from "../data.js";
import { ConnectorCard } from "../components/StoreControls.js";

// ── The kinds ──────────────────────────────────────────────────────────────────────────────────

interface FieldSpec {
  key: string;
  label: string;
  secret?: boolean;
  multiline?: boolean;
  help?: string;
}

interface PinSpec {
  label: string;
  help: string;
  /** The pin's keyboard: an Apple ID and a Steam app id are digits; the rest are not (OUT-4). */
  inputMode: "numeric" | "text";
}

interface KindSpec {
  value: OutletCredentialKind;
  label: string;
  description: string;
  fields: FieldSpec[];
  pin?: PinSpec;
  /** `asc-webhook-secret`: the Worker can generate the value. */
  generate?: boolean;
}

export const KINDS: KindSpec[] = [
  {
    value: "asc-api-key",
    label: "App Store Connect API key",
    description: "Reads review and release state; drives phased releases.",
    pin: {
      label: "App Store Connect app id (Apple ID)",
      help: "The numeric Apple ID of the one app this key may read and act on for this product. The connector stays off unless .pkey/distribution names the same app.",
      inputMode: "numeric",
    },
    fields: [
      { key: "keyId", label: "Key ID" },
      { key: "issuerId", label: "Issuer ID" },
      {
        key: "p8",
        label: ".p8 private key",
        secret: true,
        multiline: true,
        help: "Paste the whole .p8 file. Use a team key with the App Manager role.",
      },
    ],
  },
  {
    value: "asc-webhook-secret",
    label: "App Store webhook secret",
    description: "Verifies App Store Connect's webhook calls.",
    generate: true,
    fields: [{ key: "secret", label: "Secret", secret: true }],
  },
  {
    value: "google-service-account",
    label: "Google service account",
    description:
      "Reads tracks and vitals; drives staged rollouts on Google Play.",
    pin: {
      label: "Google Play package name",
      help: "The package name (application id) of the one Play app this service account may read and act on for this product. The connector stays off unless .pkey/distribution names the same package.",
      inputMode: "text",
    },
    fields: [
      {
        key: "json",
        label: "JSON key file",
        secret: true,
        multiline: true,
        help: "Paste the service account's JSON key. Invite it to one app with release permissions only.",
      },
    ],
  },
  {
    value: "ms-partner-center",
    label: "Microsoft Partner Center app",
    description: "Reads Microsoft Store submissions and availability.",
    pin: {
      label: "Microsoft Store product id (Store ID)",
      help: "The 12-character Store ID of the one Microsoft Store app this Entra app may read for this product. The connector stays off unless .pkey/distribution names the same productId.",
      inputMode: "text",
    },
    fields: [
      { key: "tenantId", label: "Tenant ID" },
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "sellerId", label: "Seller ID" },
    ],
  },
  {
    value: "sentry-integration",
    label: "Sentry internal integration",
    description:
      "Verifies Sentry's alert webhooks, which open halt candidates.",
    fields: [
      {
        key: "clientSecret",
        label: "Client secret",
        secret: true,
        help: "The internal integration's client secret. Sentry signs its alert webhooks with it; Polaris Key never calls Sentry. An alert only opens a halt candidate for you to confirm.",
      },
    ],
  },
  {
    value: "app-store-server-key",
    label: "App Store In-App Purchase key",
    description: "Confirms App Store purchases for the commerce bridge.",
    pin: {
      label: "App Store bundle id",
      help: "The bundle id of the one app whose purchases this key may confirm for this product. The commerce bridge stays off for the App Store unless its settings name the same bundle id.",
      inputMode: "text",
    },
    fields: [
      { key: "keyId", label: "Key ID" },
      { key: "issuerId", label: "Issuer ID" },
      {
        key: "p8",
        label: ".p8 private key",
        secret: true,
        multiline: true,
        help: "App Store Connect → Users and Access → Integrations → In-App Purchase. Not the App Store Connect API key.",
      },
    ],
  },
  {
    value: "steam-publisher-key",
    label: "Steamworks Web API publisher key",
    description: "Checks DLC ownership for the commerce bridge.",
    pin: {
      label: "Steam app id",
      help: "The app id of the one game whose DLC ownership this key may check for this product. The commerce bridge stays off for Steam unless its settings name the same app id.",
      inputMode: "numeric",
    },
    fields: [
      {
        key: "key",
        label: "Publisher key",
        secret: true,
        help: "Steamworks → Users & Permissions → Manage Groups → Web API key (32 hex digits).",
      },
    ],
  },
];

const KIND = new Map(KINDS.map((k) => [k.value as string, k]));
const kindLabel = (k: string) => KIND.get(k)?.label ?? k;

/** The `meta` field a kind's pin is kept under: the server's word first. */
function pinField(
  data: OutletCredentialsResponse | undefined,
  kind: string,
): string | null {
  return (
    data?.pins?.[kind]?.field ??
    (
      {
        "asc-api-key": "appleId",
        "google-service-account": "packageName",
        "ms-partner-center": "productId",
        "app-store-server-key": "bundleId",
        "steam-publisher-key": "appId",
      } as Record<string, string>
    )[kind] ??
    null
  );
}

/** The error copy, with the platform store connection's refusal worded (A-16). */
function describe(e: unknown): { title: string; description?: string } {
  if (e instanceof ApiError && e.code === "app_assigned_elsewhere")
    return {
      title: "That app belongs to another product",
      description:
        e.message && e.message !== `api ${e.status}`
          ? e.message
          : "It is assigned to another product through the platform's store connection. Unassign it there first.",
    };
  return errorCopy(e, { area: "distribution", thing: "Outlet credential" });
}

const CREDENTIAL = codecs.string("");

function LastResult({ c }: { c: OutletCredentialInfo }): React.ReactElement {
  if (c.lastError)
    return (
      <span className="flex flex-col items-start gap-0.5">
        <StatusPill tone="danger" size="sm">
          Failed
        </StatusPill>
        <span
          className="line-clamp-2 max-w-64 text-xs text-fg-muted"
          title={c.lastError}
        >
          {c.lastError}
        </span>
      </span>
    );
  if (c.lastOkAt !== null)
    return (
      <span className="flex flex-col items-start gap-0.5">
        <StatusPill tone="success" size="sm">
          OK
        </StatusPill>
        <span className="text-xs text-fg-muted">
          <Timestamp at={fromSeconds(c.lastOkAt)} />
        </span>
      </span>
    );
  return <span className="text-fg-subtle">Not used yet</span>;
}

export function CredentialsPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const creds = useCredentials(slug);
  const connectors = useConnectors(slug);
  const store = useReleaseStore(slug);
  const [openId] = useSearchParam("credential", CREDENTIAL);
  const [state, setState] = useTableUrlState("credentials", {
    facets: ["kind"],
  });
  const [drawer, setDrawer] = React.useState<
    { mode: "create" } | { mode: "rotate"; cred: OutletCredentialInfo } | null
  >(null);
  const [pinning, setPinning] = React.useState<OutletCredentialInfo | null>(
    null,
  );
  const [deleting, setDeleting] = React.useState<OutletCredentialInfo | null>(
    null,
  );

  const list = creds.data?.credentials ?? [];
  const open = list.find((c) => c.id === openId);
  const kinds = [...new Set(list.map((c) => c.kind))];

  const columns: DataColumn<OutletCredentialInfo>[] = [
    {
      id: "id",
      header: "ID",
      accessorKey: "id",
      meta: { priority: 1, primary: true, mono: true },
    },
    {
      id: "kind",
      header: "Kind",
      accessorKey: "kind",
      meta: { priority: 1, csv: (c) => kindLabel(c.kind) },
      cell: ({ row }) => {
        const field = pinField(creds.data, row.original.kind);
        const shown = Object.entries(row.original.meta)
          .filter(([k]) => k !== field)
          .map(([, v]) => v);
        return (
          <span className="flex flex-col gap-0.5">
            <span>{kindLabel(row.original.kind)}</span>
            {shown.length ? (
              <span className="font-mono text-xs text-fg-muted">
                {shown.join(" · ")}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "pin",
      header: "Pinned to",
      accessorFn: (c) => {
        const f = pinField(creds.data, c.kind);
        return f ? (c.meta[f] ?? "") : "";
      },
      meta: { priority: 1 },
      cell: ({ row }) => {
        const f = pinField(creds.data, row.original.kind);
        if (!f) return <span className="text-fg-subtle">—</span>;
        const v = row.original.meta[f];
        return v ? (
          <span className="font-mono text-xs">{v}</span>
        ) : (
          <StatusPill tone="warning" size="sm">
            Not pinned
          </StatusPill>
        );
      },
    },
    {
      id: "outlet",
      header: "Outlet",
      accessorFn: (c) => c.outletId ?? "",
      meta: { priority: 2 },
      cell: ({ row }) =>
        row.original.outletId ?? <span className="text-fg-subtle">Any</span>,
    },
    {
      id: "createdAt",
      header: "Created",
      accessorKey: "createdAt",
      meta: { numeric: true, priority: 3 },
      cell: ({ row }) => <Timestamp at={fromSeconds(row.original.createdAt)} />,
    },
    {
      id: "lastUsedAt",
      header: "Last used",
      accessorFn: (c) => c.lastUsedAt ?? 0,
      meta: { numeric: true, priority: 2 },
      cell: ({ row }) =>
        row.original.lastUsedAt !== null ? (
          <Timestamp at={fromSeconds(row.original.lastUsedAt)} />
        ) : (
          <span className="text-fg-subtle">Never</span>
        ),
    },
    {
      id: "result",
      header: "Last result",
      accessorFn: (c) =>
        c.lastError ? `Failed: ${c.lastError}` : c.lastOkAt ? "OK" : "",
      meta: { priority: 1 },
      cell: ({ row }) => <LastResult c={row.original} />,
    },
  ];

  const rowActions = (c: OutletCredentialInfo): RowActionItem[] => [
    {
      label: "Rotate…",
      onSelect: () => setDrawer({ mode: "rotate", cred: c }),
    },
    ...(pinField(creds.data, c.kind)
      ? [{ label: "Pin…", onSelect: () => setPinning(c) }]
      : []),
    { type: "separator" as const },
    {
      label: "Delete…",
      tone: "danger" as const,
      onSelect: () => setDeleting(c),
    },
  ];

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Outlet credentials"
          titleAside={
            creds.data ? (
              <span className="text-sm tabular-nums text-fg-muted">
                {list.length}
              </span>
            ) : undefined
          }
          description="Store keys and the Sentry secret. Values are never shown again."
          primaryAction={
            <Button
              iconStart={<Plus aria-hidden />}
              onClick={() => setDrawer({ mode: "create" })}
            >
              Set credential…
            </Button>
          }
          refetching={creds.isFetching && !creds.isPending}
        />
      }
    >
      <DataTable<OutletCredentialInfo>
        id="credentials"
        caption="Outlet credentials"
        data={list}
        columns={columns}
        getRowId={(c) => c.id}
        rowHref={(c) => hrefWithQuery({ credential: c.id })}
        linkComponent={Link}
        rowActions={rowActions}
        state={state}
        onStateChange={setState}
        search={{
          placeholder: "Search credentials",
          columns: ["id", "kind", "outlet"],
        }}
        facets={[
          {
            id: "kind",
            label: "Kind",
            options: kinds.map((k) => ({ value: k, label: kindLabel(k) })),
          },
        ]}
        loading={creds.isPending}
        error={creds.isError && !creds.data ? creds.error : undefined}
        onRetry={() => void creds.refetch()}
        exportCsv={false}
        mobile="cards"
        empty={
          <EmptyState
            kind="first-run"
            title="No outlet credentials yet"
            description="A store connector needs its store's key to read review and release state and to drive staged rollouts; Sentry needs its integration secret to send alerts."
            primaryAction={
              <Button onClick={() => setDrawer({ mode: "create" })}>
                Set credential…
              </Button>
            }
            docs="/docs/admin/secrets-and-keys/"
          />
        }
      />

      <section aria-labelledby="connectors-title" className="space-y-3">
        <div className="space-y-1">
          <h2
            id="connectors-title"
            className="text-lg font-semibold text-fg-strong"
          >
            Store connectors
          </h2>
          <p className="text-sm text-fg-muted">
            A connector uses this product's own key of its kind when there is
            one; otherwise the platform's team key, for the one app assigned to
            this product.{" "}
            <a
              className="text-accent-fg underline-offset-4 hover:underline"
              href="/docs/admin/store-connections/"
              target="_blank"
              rel="noreferrer"
            >
              About store connections
            </a>
          </p>
        </div>
        {connectors.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : connectors.isError ? (
          <ErrorState
            compact
            error={connectors.error}
            onRetry={() => void connectors.refetch()}
            context={{ area: "distribution" }}
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {(connectors.data?.connectors ?? []).map((c) => (
              <ConnectorCard
                key={c.kind}
                slug={slug}
                connector={c}
                releases={store.data}
              />
            ))}
          </div>
        )}
      </section>

      <CredentialDetail
        cred={open}
        missing={openId !== "" && !open && !creds.isPending ? openId : null}
        data={creds.data}
        onClose={() => patchQuery({ credential: null })}
        onRotate={(c) => setDrawer({ mode: "rotate", cred: c })}
        onPin={setPinning}
      />
      {drawer ? (
        <SetCredentialDrawer
          slug={slug}
          existing={list}
          rotate={drawer.mode === "rotate" ? drawer.cred : null}
          onClose={() => setDrawer(null)}
        />
      ) : null}
      {pinning ? (
        <PinDialog
          slug={slug}
          cred={pinning}
          data={creds.data}
          onClose={() => setPinning(null)}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        intent="danger"
        title={deleting ? `Delete the outlet credential “${deleting.id}”?` : ""}
        consequences={[
          "Connectors using it stop working until another is set.",
          "The value cannot be recovered.",
        ]}
        confirmLabel={deleting ? `Delete ${deleting.id}` : "Delete"}
        describeError={describe}
        onConfirm={async () => {
          if (!deleting) return;
          await mutate("deleteOutletCredential", slug, deleting.id);
          toast.success(`Deleted the outlet credential “${deleting.id}”`);
          if (openId === deleting.id) patchQuery({ credential: null });
        }}
      />
    </CollectionTemplate>
  );
}

function CredentialDetail({
  cred,
  missing,
  data,
  onClose,
  onRotate,
  onPin,
}: {
  cred: OutletCredentialInfo | undefined;
  missing: string | null;
  data: OutletCredentialsResponse | undefined;
  onClose: () => void;
  onRotate: (c: OutletCredentialInfo) => void;
  onPin: (c: OutletCredentialInfo) => void;
}): React.ReactElement {
  const field = cred ? pinField(data, cred.kind) : null;
  return (
    <Drawer
      open={Boolean(cred) || missing !== null}
      onOpenChange={(o) => !o && onClose()}
      title={cred ? cred.id : "Credential not found"}
      description={cred ? kindLabel(cred.kind) : undefined}
    >
      <DrawerBody className="space-y-5">
        {!cred ? (
          <Callout tone="warning" title={`No credential ${missing ?? ""}`}>
            It was deleted, or the link is out of date.
          </Callout>
        ) : (
          <>
            {cred.lastError ? (
              <Callout tone="danger" title="The last use failed">
                {cred.lastError}
              </Callout>
            ) : null}
            <DescriptionList
              items={[
                {
                  term: "Status",
                  detail: (
                    <StatusPill
                      tone={cred.status === "active" ? "success" : "neutral"}
                    >
                      {cred.status === "active" ? "Active" : cred.status}
                    </StatusPill>
                  ),
                },
                ...(field
                  ? [
                      {
                        term: data?.pins?.[cred.kind]?.label ?? "Pinned to",
                        detail: cred.meta[field] ? (
                          <span className="font-mono text-xs">
                            {cred.meta[field]}
                          </span>
                        ) : (
                          "Not pinned: its connector stays off"
                        ),
                      },
                    ]
                  : []),
                ...Object.entries(cred.meta)
                  .filter(([k]) => k !== field)
                  .map(([k, v]) => ({
                    term: k,
                    detail: <span className="font-mono text-xs">{v}</span>,
                  })),
                {
                  term: "Outlet",
                  detail: cred.outletId ?? "Any of the product's outlets",
                },
                {
                  term: "Created",
                  detail: (
                    <>
                      <Timestamp
                        at={fromSeconds(cred.createdAt)}
                        format="detail"
                      />{" "}
                      by {cred.createdBy}
                    </>
                  ),
                },
                {
                  term: "Rotated",
                  detail:
                    cred.rotatedAt !== null ? (
                      <Timestamp
                        at={fromSeconds(cred.rotatedAt)}
                        format="detail"
                      />
                    ) : (
                      "Never"
                    ),
                },
                {
                  term: "Last used",
                  detail:
                    cred.lastUsedAt !== null ? (
                      <Timestamp
                        at={fromSeconds(cred.lastUsedAt)}
                        format="detail"
                      />
                    ) : (
                      "Never"
                    ),
                },
                {
                  term: "Last success",
                  detail:
                    cred.lastOkAt !== null ? (
                      <Timestamp
                        at={fromSeconds(cred.lastOkAt)}
                        format="detail"
                      />
                    ) : (
                      "Never"
                    ),
                },
              ]}
            />
          </>
        )}
      </DrawerBody>
      {cred ? (
        <DrawerFooter>
          {field ? (
            <Button variant="outline" onClick={() => onPin(cred)}>
              Pin…
            </Button>
          ) : null}
          <Button onClick={() => onRotate(cred)}>Rotate…</Button>
        </DrawerFooter>
      ) : null}
    </Drawer>
  );
}

function SetCredentialDrawer({
  slug,
  existing,
  rotate,
  onClose,
}: {
  slug: string;
  existing: OutletCredentialInfo[];
  rotate: OutletCredentialInfo | null;
  onClose: () => void;
}): React.ReactElement {
  const outlets = useOutlets(slug);
  const [kind, setKind] = React.useState<OutletCredentialKind | null>(
    (rotate?.kind as OutletCredentialKind | undefined) ?? null,
  );
  const [id, setId] = React.useState(rotate?.id ?? "");
  const [outletId, setOutletId] = React.useState<string | null>(
    rotate?.outletId ?? null,
  );
  // Kept across kind changes, so switching kind never loses what was typed (OUT-3).
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [pin, setPin] = React.useState("");
  const [generate, setGenerate] = React.useState(true);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [failure, setFailure] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmRotate, setConfirmRotate] = React.useState(false);

  const spec = kind ? KIND.get(kind) : undefined;
  const generating = Boolean(spec?.generate && generate);
  const reused = !rotate && existing.find((c) => c.id === id.trim());

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!kind) e.kind = "Choose a kind.";
    if (!rotate && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id.trim()))
      e.id =
        "Use up to 64 lowercase letters, digits, dots, dashes or underscores, e.g. asc-team-key.";
    if (spec && !generating)
      for (const f of spec.fields)
        if (!(values[f.key] ?? "").trim()) e[f.key] = `Enter the ${f.label}.`;
    if (spec?.pin && !rotate && !pin.trim())
      e.pin = `Enter the ${spec.pin.label}.`;
    return e;
  };

  const send = async (): Promise<void> => {
    if (!spec || !kind) return;
    setBusy(true);
    setFailure(null);
    try {
      const body: PutOutletCredentialBody = generating
        ? { kind, generate: true }
        : {
            kind,
            value:
              kind === "google-service-account"
                ? values.json!
                : Object.fromEntries(
                    spec.fields.map((f) => [f.key, values[f.key] ?? ""]),
                  ),
          };
      if (spec.pin && pin.trim()) body.pin = pin.trim();
      if (!rotate || outletId !== rotate.outletId) body.outletId = outletId;
      const credentialId = rotate?.id ?? id.trim();
      await mutate("putOutletCredential", slug, credentialId, body);
      toast.success(
        rotate || reused
          ? `Rotated “${credentialId}”`
          : `Saved “${credentialId}”`,
        { description: "Its value is never shown again." },
      );
      onClose();
    } catch (err) {
      setFailure(err);
      if (err instanceof ApiError && err.fields?.length) {
        setErrors(
          Object.fromEntries(
            err.fields.map((f) => [
              f === "value" ? (spec.fields[0]?.key ?? f) : f,
              describe(err).description ?? "Check this value.",
            ]),
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    if (rotate || reused) setConfirmRotate(true);
    else void send();
  };

  const copy = failure ? describe(failure) : null;
  const title = rotate ? `Rotate “${rotate.id}”` : "Set an outlet credential";

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      dismissible={!busy}
      size="lg"
      title={title}
      description="Values are sent once and never shown again."
    >
      <form
        noValidate
        onSubmit={submit}
        className="flex min-h-0 flex-1 flex-col"
        aria-label={title}
      >
        <DrawerBody className="space-y-4">
          <FormField<string | null>
            name="kind"
            label="Kind"
            required
            value={kind}
            onChange={(v) => setKind(v as OutletCredentialKind | null)}
            error={errors.kind}
            announceError
            disabled={Boolean(rotate)}
          >
            {(field) => (
              <Select
                {...field}
                ref={undefined}
                placeholder="Choose a kind"
                options={KINDS.map((k) => ({
                  value: k.value,
                  label: k.label,
                  description: k.description,
                }))}
              />
            )}
          </FormField>
          {spec ? (
            <>
              {!rotate ? (
                <FormField<string>
                  name="id"
                  label="Credential ID"
                  required
                  help="Lowercase, e.g. asc-team-key."
                  value={id}
                  onChange={setId}
                  error={errors.id}
                  announceError
                >
                  {(field) => (
                    <Input
                      id={field.id}
                      value={id}
                      mono
                      autoComplete="off"
                      spellCheck={false}
                      onValueChange={setId}
                      aria-describedby={field["aria-describedby"]}
                      aria-invalid={field["aria-invalid"]}
                      aria-required
                    />
                  )}
                </FormField>
              ) : null}
              {reused ? (
                <Callout
                  tone="warning"
                  title="A credential with this id exists"
                >
                  Saving rotates it: the new value replaces “{reused.id}” (
                  {kindLabel(reused.kind)}).
                </Callout>
              ) : null}
              <FormField<string | null>
                name="outlet"
                label="Outlet"
                help="Bind it to one outlet, or leave Any to let the connector choose."
                value={outletId}
                onChange={setOutletId}
              >
                {(field) => (
                  <Select
                    {...field}
                    ref={undefined}
                    allowEmpty
                    emptyLabel="Any"
                    options={(outlets.data?.outlets ?? [])
                      .filter((o) => o.removedAt === null)
                      .map((o) => ({ value: o.outletId, label: o.outletId }))}
                  />
                )}
              </FormField>
              {spec.generate ? (
                <Checkbox
                  checked={generate}
                  onCheckedChange={setGenerate}
                  label="Generate the secret"
                  description="The Worker creates a random secret and keeps it; Webhook setup hands it to Apple. Recommended."
                />
              ) : null}
              {!generating
                ? spec.fields.map((f) => (
                    <FormField<string>
                      key={f.key}
                      name={f.key}
                      label={f.label}
                      required
                      help={f.help}
                      value={values[f.key] ?? ""}
                      onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                      error={errors[f.key]}
                      announceError
                    >
                      {(field) =>
                        f.multiline ? (
                          <Textarea
                            id={field.id}
                            value={values[f.key] ?? ""}
                            mono
                            rows={5}
                            autoComplete="off"
                            spellCheck={false}
                            onValueChange={(v) =>
                              setValues((s) => ({ ...s, [f.key]: v }))
                            }
                            aria-describedby={field["aria-describedby"]}
                            aria-invalid={field["aria-invalid"]}
                            aria-required
                          />
                        ) : f.secret ? (
                          <SecretInput
                            id={field.id}
                            value={values[f.key] ?? ""}
                            onChange={(v) =>
                              setValues((s) => ({ ...s, [f.key]: v }))
                            }
                            aria-describedby={field["aria-describedby"]}
                            aria-invalid={field["aria-invalid"]}
                            aria-required
                          />
                        ) : (
                          <Input
                            id={field.id}
                            value={values[f.key] ?? ""}
                            mono
                            autoComplete="off"
                            spellCheck={false}
                            onValueChange={(v) =>
                              setValues((s) => ({ ...s, [f.key]: v }))
                            }
                            aria-describedby={field["aria-describedby"]}
                            aria-invalid={field["aria-invalid"]}
                            aria-required
                          />
                        )
                      }
                    </FormField>
                  ))
                : null}
              {spec.pin ? (
                <FormField<string>
                  name="pin"
                  label={spec.pin.label}
                  required={!rotate}
                  help={
                    rotate
                      ? `${spec.pin.help} Leave blank to keep the current pin.`
                      : spec.pin.help
                  }
                  value={pin}
                  onChange={setPin}
                  error={errors.pin}
                  announceError
                >
                  {(field) => (
                    <Input
                      id={field.id}
                      value={pin}
                      mono
                      inputMode={spec.pin!.inputMode}
                      autoComplete="off"
                      spellCheck={false}
                      onValueChange={setPin}
                      aria-describedby={field["aria-describedby"]}
                      aria-invalid={field["aria-invalid"]}
                      aria-required={!rotate || undefined}
                    />
                  )}
                </FormField>
              ) : null}
            </>
          ) : null}
          {copy ? (
            <Callout tone="danger" title={copy.title} live>
              {copy.description}
            </Callout>
          ) : null}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            {rotate || reused ? "Rotate credential…" : "Set credential"}
          </Button>
        </DrawerFooter>
      </form>
      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        intent="caution"
        title={`Rotate “${rotate?.id ?? id.trim()}”?`}
        consequences={[
          "The new value replaces the stored one at once; the old one cannot be recovered.",
          "Connectors use the new value from their next call.",
        ]}
        confirmLabel="Rotate credential"
        describeError={describe}
        onConfirm={async () => {
          await send();
        }}
      />
    </Drawer>
  );
}

function PinDialog({
  slug,
  cred,
  data,
  onClose,
}: {
  slug: string;
  cred: OutletCredentialInfo;
  data: OutletCredentialsResponse | undefined;
  onClose: () => void;
}): React.ReactElement {
  const field = pinField(data, cred.kind);
  const spec = KIND.get(cred.kind)?.pin;
  const [value, setValue] = React.useState(
    field ? (cred.meta[field] ?? "") : "",
  );
  const [error, setError] = React.useState<string | undefined>();
  const [failure, setFailure] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const label = spec?.label ?? data?.pins?.[cred.kind]?.label ?? "App id";
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!value.trim()) {
      setError(`Enter the ${label}.`);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await mutate("putOutletCredential", slug, cred.id, {
        kind: cred.kind as OutletCredentialKind,
        pin: value.trim(),
      });
      toast.success(`Pinned “${cred.id}” to ${value.trim()}`);
      onClose();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };
  const copy = failure ? describe(failure) : null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      dismissible={!busy}
      title={`Pin “${cred.id}” to an app`}
      description="The connector reads and acts on this app only, and stays off while .pkey/distribution names another. Check that this is the product's app: store release controls cannot be undone. The change is audited."
    >
      <form
        noValidate
        onSubmit={(e) => void submit(e)}
        aria-label="Pin credential"
      >
        <DialogBody className="space-y-3">
          <FormField<string>
            name="pin"
            label={label}
            required
            value={value}
            onChange={(v) => {
              setValue(v);
              setError(undefined);
            }}
            error={error}
            announceError
          >
            {(f) => (
              <Input
                id={f.id}
                value={value}
                mono
                inputMode={spec?.inputMode ?? "text"}
                autoComplete="off"
                spellCheck={false}
                onValueChange={(v) => {
                  setValue(v);
                  setError(undefined);
                }}
                aria-describedby={f["aria-describedby"]}
                aria-invalid={f["aria-invalid"]}
                aria-required
              />
            )}
          </FormField>
          {copy ? (
            <Callout tone="danger" title={copy.title} live>
              {copy.description}
            </Callout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Pin
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
