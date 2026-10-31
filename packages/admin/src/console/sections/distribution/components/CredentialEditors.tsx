/**
 * The credential editors (ST-12), shared by a channel's Setup tab and the Credentials page: the
 * list, the detail drawer, the set / rotate drawer, the pin dialog and delete. Values are
 * write-only: they are sent once, never read back, never rendered and never put in a URL.
 */

import * as React from "react";
import {
  type OutletCredentialInfo,
  type OutletCredentialsResponse,
} from "../../../../api.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import {
  DataTable,
  type DataColumn,
  type RowActionItem,
} from "../../../../ui/data-table/index.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../../ui/Drawer.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { Link, useSearchParam } from "../../../router.js";
import { codecs } from "../../../routes.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { hrefWithQuery, patchQuery, useCredentials } from "../data.js";
import {
  describe,
  kindLabel,
  pinField,
  sharedLine,
  type KindSpec,
} from "../model/credentialKinds.js";
import { humanField } from "../model/channelCopy.js";
import { PinDialog, SetCredentialDrawer } from "./CredentialForms.js";

export function LastResult({
  c,
}: {
  c: OutletCredentialInfo;
}): React.ReactElement {
  if (c.lastError)
    return (
      <span className="flex flex-col items-start gap-0.5">
        <StatusPill tone="danger" size="sm">
          Failed
        </StatusPill>
        <span
          // A long id in the text breaks anywhere; prose breaks between words. The end padding holds the clamp's
          // ellipsis, which Linux Chromium draws past the last full line.
          className={`line-clamp-2 max-w-64 pe-2 text-xs text-fg-muted${
            /\S{25,}/.test(c.lastError) ? " break-all" : ""
          }`}
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

function CredentialDetail({
  cred,
  missing,
  data,
  onClose,
  onRotate,
  onPin,
  showChannel,
  disabledReason,
}: {
  cred: OutletCredentialInfo | undefined;
  missing: string | null;
  data: OutletCredentialsResponse | undefined;
  onClose: () => void;
  onRotate: (c: OutletCredentialInfo) => void;
  onPin: (c: OutletCredentialInfo) => void;
  /** The outlet a credential is bound to. A channel page already says which channel it is. */
  showChannel: boolean;
  /** Why a change is unavailable to this reader. */
  disabledReason: string | undefined;
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
                  detail: cred.lastError ? (
                    <StatusPill tone="danger">Failing</StatusPill>
                  ) : (
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
                    term: humanField(k),
                    detail: (
                      <span className="font-mono text-xs break-all">{v}</span>
                    ),
                  })),
                ...(showChannel
                  ? [
                      {
                        term: "Channel",
                        detail:
                          cred.outletId ?? "Any of the product's channels",
                      },
                    ]
                  : []),
                {
                  term: "Created",
                  detail: (
                    <>
                      <Timestamp
                        at={fromSeconds(cred.createdAt)}
                        format="detail"
                      />
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
            <Button
              variant="outline"
              disabledReason={disabledReason}
              onClick={() => onPin(cred)}
            >
              Pin…
            </Button>
          ) : null}
          <Button
            disabledReason={disabledReason}
            onClick={() => onRotate(cred)}
          >
            Rotate…
          </Button>
        </DrawerFooter>
      ) : null}
    </Drawer>
  );
}

// ── The editor: state, dialogs and the table ───────────────────────────────────────────────────

const CREDENTIAL = codecs.string("");

export interface CredentialEditor {
  /** Opens the set drawer. */
  create: () => void;
  /** Every drawer and dialog; render it once, anywhere under the page. */
  dialogs: React.ReactElement;
  rowActions: (c: OutletCredentialInfo) => RowActionItem[];
  data: OutletCredentialsResponse | undefined;
}

/**
 * The credential editors for the credentials `rows` (the page's own slice of the product's list).
 * `kinds` are the kinds the set drawer offers; on a channel's page (`channelScoped`) the channel is
 * known, so the drawer has no channel field and the detail does not name one.
 */
export function useCredentialEditor({
  slug,
  creds,
  rows,
  kinds,
  channelScoped,
  channelName,
  disabledReason,
  alsoUsedBy,
}: {
  slug: string;
  creds: ReturnType<typeof useCredentials>;
  rows: readonly OutletCredentialInfo[];
  kinds: readonly KindSpec[];
  channelScoped: boolean;
  /** The channel the editors sit on (names the set drawer); omitted on the Credentials page. */
  channelName?: string;
  /** Why this reader cannot change a credential (the Ship edit gate); the controls show it. */
  disabledReason?: string;
  /** The other in-scope channels a kind's key also serves, named in the rotate and delete confirms. */
  alsoUsedBy?: (kind: string) => string[];
}): CredentialEditor {
  const [openId] = useSearchParam("credential", CREDENTIAL);
  const [drawer, setDrawer] = React.useState<
    { mode: "create" } | { mode: "rotate"; cred: OutletCredentialInfo } | null
  >(null);
  const [pinning, setPinning] = React.useState<OutletCredentialInfo | null>(
    null,
  );
  const [deleting, setDeleting] = React.useState<OutletCredentialInfo | null>(
    null,
  );
  const open = rows.find((c) => c.id === openId);
  const rowActions = (c: OutletCredentialInfo): RowActionItem[] => [
    {
      label: "Rotate…",
      disabledReason,
      onSelect: () => setDrawer({ mode: "rotate", cred: c }),
    },
    ...(pinField(creds.data, c.kind)
      ? [{ label: "Pin…", disabledReason, onSelect: () => setPinning(c) }]
      : []),
    { type: "separator" as const },
    {
      label: "Delete…",
      tone: "danger" as const,
      disabledReason,
      onSelect: () => setDeleting(c),
    },
  ];
  const dialogs = (
    <>
      <CredentialDetail
        cred={open}
        missing={openId !== "" && !open && !creds.isPending ? openId : null}
        data={creds.data}
        showChannel={!channelScoped}
        disabledReason={disabledReason}
        onClose={() => patchQuery({ credential: null })}
        onRotate={(c) => setDrawer({ mode: "rotate", cred: c })}
        onPin={setPinning}
      />
      {drawer ? (
        <SetCredentialDrawer
          slug={slug}
          existing={creds.data?.credentials ?? []}
          rotate={drawer.mode === "rotate" ? drawer.cred : null}
          kinds={kinds}
          channelScoped={channelScoped}
          channelName={channelName}
          alsoUsedBy={alsoUsedBy}
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
        title={`Delete the channel credential “${deleting?.id ?? ""}”?`}
        consequences={[
          "Connectors using it stop working until another is set.",
          ...sharedLine(deleting, alsoUsedBy),
          "The value cannot be recovered.",
        ]}
        confirmLabel={deleting ? `Delete ${deleting.id}` : "Delete"}
        describeError={describe}
        onConfirm={async () => {
          if (!deleting) return;
          await mutate("deleteOutletCredential", slug, deleting.id);
          toast.success(`Deleted the channel credential “${deleting.id}”`);
          if (openId === deleting.id) patchQuery({ credential: null });
        }}
      />
    </>
  );
  return {
    create: () => setDrawer({ mode: "create" }),
    dialogs,
    rowActions,
    data: creds.data,
  };
}

/** The credentials as a table: metadata and the last result as text, never a value. */
export function CredentialTable({
  editor,
  creds,
  rows,
  id,
  caption,
  channelColumn,
  outOfScope,
  kindChannels,
  filters,
  pending = false,
  empty,
}: {
  editor: CredentialEditor;
  creds: ReturnType<typeof useCredentials>;
  rows: readonly OutletCredentialInfo[];
  id: string;
  caption: string;
  /** The "Channel" column: the outlet a credential is bound to. Off on a channel's own page. */
  channelColumn: boolean;
  /** A held credential whose channel is out of scope for the product is flagged (A-20 R6). */
  outOfScope?: (c: OutletCredentialInfo) => string | undefined;
  /** The channel names a kind serves, for a credential bound to no outlet (instead of "Any"). */
  kindChannels?: (kind: string) => string;
  /** Search and the kind facet: on for the page that lists many, off for one channel's few. */
  filters: boolean;
  /** Something the rows depend on (the product's scope) is still loading. */
  pending?: boolean;
  empty: React.ReactNode;
}): React.ReactElement {
  const data = editor.data;
  const [state, setState] = useTableUrlState(id, {
    facets: filters ? ["kind"] : [],
  });
  const kinds = [...new Set(rows.map((c) => c.kind))];
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
        const field = pinField(data, row.original.kind);
        const shown = Object.entries(row.original.meta)
          .filter(([k]) => k !== field)
          .map(([, v]) => v);
        return (
          <span className="flex flex-col gap-0.5">
            <span>{kindLabel(row.original.kind)}</span>
            {shown.length ? (
              <span className="max-w-72 font-mono text-xs break-all text-fg-muted">
                {shown.join(" · ")}
              </span>
            ) : null}
            {outOfScope?.(row.original) ? (
              <span className="mt-0.5 flex max-w-72 flex-col items-start gap-1">
                <StatusPill tone="neutral" size="sm">
                  Out of scope
                </StatusPill>
                <span className="text-xs text-fg-muted">
                  {outOfScope(row.original)}
                </span>
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
        const f = pinField(data, c.kind);
        return f ? (c.meta[f] ?? "") : "";
      },
      meta: { priority: 1 },
      cell: ({ row }) => {
        const f = pinField(data, row.original.kind);
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
    ...(channelColumn
      ? [
          {
            id: "outlet",
            header: "Channel",
            accessorFn: (c: OutletCredentialInfo) => c.outletId ?? "",
            meta: { priority: 2 },
            cell: ({ row }: { row: { original: OutletCredentialInfo } }) =>
              row.original.outletId ??
              (kindChannels?.(row.original.kind) || (
                <span className="text-fg-subtle">Any</span>
              )),
          } satisfies DataColumn<OutletCredentialInfo>,
        ]
      : []),
    // A channel's few keys fit the page without the dates: the detail drawer has them.
    ...(channelColumn
      ? [
          {
            id: "createdAt",
            header: "Created",
            accessorKey: "createdAt",
            meta: { numeric: true, priority: 3 },
            cell: ({ row }: { row: { original: OutletCredentialInfo } }) => (
              <Timestamp at={fromSeconds(row.original.createdAt)} />
            ),
          } satisfies DataColumn<OutletCredentialInfo>,
          {
            id: "lastUsedAt",
            header: "Last used",
            accessorFn: (c: OutletCredentialInfo) => c.lastUsedAt ?? 0,
            meta: { numeric: true, priority: 2 },
            cell: ({ row }: { row: { original: OutletCredentialInfo } }) =>
              row.original.lastUsedAt !== null ? (
                <Timestamp at={fromSeconds(row.original.lastUsedAt)} />
              ) : (
                <span className="text-fg-subtle">Never</span>
              ),
          } satisfies DataColumn<OutletCredentialInfo>,
        ]
      : []),
    {
      id: "result",
      header: "Last result",
      accessorFn: (c) =>
        c.lastError ? `Failed: ${c.lastError}` : c.lastOkAt ? "OK" : "",
      meta: { priority: 1 },
      cell: ({ row }) => <LastResult c={row.original} />,
    },
  ];
  return (
    <DataTable<OutletCredentialInfo>
      id={id}
      caption={caption}
      data={[...rows]}
      columns={columns}
      getRowId={(c) => c.id}
      rowHref={(c) => hrefWithQuery({ credential: c.id })}
      linkComponent={Link}
      rowActions={editor.rowActions}
      state={state}
      onStateChange={setState}
      search={
        filters
          ? {
              placeholder: "Search credentials",
              columns: ["id", "kind", "outlet"],
            }
          : undefined
      }
      facets={
        filters
          ? [
              {
                id: "kind",
                label: "Kind",
                options: kinds.map((k) => ({ value: k, label: kindLabel(k) })),
              },
            ]
          : undefined
      }
      loading={creds.isPending || pending}
      error={creds.isError && !creds.data ? creds.error : undefined}
      onRetry={() => void creds.refetch()}
      exportCsv={false}
      mobile="cards"
      empty={empty}
    />
  );
}
