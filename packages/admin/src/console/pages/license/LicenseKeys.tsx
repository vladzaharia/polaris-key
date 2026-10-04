/**
 * The license's Keys tab (ADMIN.md §6.5.2): label, hash (first 6 … last 4, LDT-11), status,
 * created, created by (named where the actor is known) and last used. Revoked keys collapse
 * under "Show N revoked". Revoke is L2 danger; Mint key shows the key once (LIC-2).
 */

import * as React from "react";
import { KeyRound } from "lucide-react";
import type { KeyDto, LicenseDetail } from "../../../api.js";
import { useMe } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { confirmFor } from "../../../lib/actions.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { fromSeconds } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { Dialog, DialogBody, DialogFooter } from "../../../ui/Dialog.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { FormField } from "../../../ui/form.js";
import { Hash } from "../../../ui/Hash.js";
import { Input } from "../../../ui/Input.js";
import { OneTimeSecretPanel } from "../../../ui/OneTimeSecretPanel.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { DataTable, type DataColumn } from "../../../ui/data-table/index.js";
import { actorName } from "./shared.js";

export function LicenseKeys({
  slug,
  license,
}: {
  slug: string;
  license: LicenseDetail;
}): React.ReactElement {
  const me = useMe().data;
  const [state, setState] = useTableUrlState("keys", { namespace: true });
  const [showRevoked, setShowRevoked] = React.useState(false);
  const [mintOpen, setMintOpen] = React.useState(false);
  const [revoking, setRevoking] = React.useState<KeyDto | null>(null);

  const active = license.keys.filter((k) => k.status === "active");
  const revoked = license.keys.filter((k) => k.status !== "active");
  const rows = showRevoked ? [...active, ...revoked] : active;

  const columns = React.useMemo<DataColumn<KeyDto>[]>(
    () => [
      {
        id: "label",
        header: "Label",
        accessorFn: (k) => k.label ?? "",
        meta: { priority: 1 },
        cell: ({ getValue }) =>
          (getValue() as string) || <span className="text-fg-muted">—</span>,
      },
      {
        id: "hash",
        header: "Hash",
        accessorKey: "hash",
        meta: { priority: 1 },
        cell: ({ row }) => <Hash value={row.original.hash} label="key hash" />,
      },
      {
        id: "status",
        header: "Status",
        accessorKey: "status",
        meta: { priority: 1 },
        cell: ({ row }) => (
          <StatusPill domain="key" state={row.original.status} />
        ),
      },
      {
        id: "createdAt",
        header: "Created",
        accessorKey: "createdAt",
        meta: { priority: 2 },
        cell: ({ row }) => (
          <Timestamp at={fromSeconds(row.original.createdAt)} />
        ),
      },
      {
        id: "createdBy",
        header: "Created by",
        accessorFn: (k) => actorName(k.createdBy, me) ?? "",
        meta: { priority: 3 },
      },
      {
        id: "lastUsedAt",
        header: "Last used",
        accessorFn: (k) => k.lastUsedAt ?? 0,
        meta: { priority: 2 },
        cell: ({ row }) =>
          row.original.lastUsedAt ? (
            <Timestamp at={fromSeconds(row.original.lastUsedAt)} />
          ) : (
            <span className="text-fg-muted">Never</span>
          ),
      },
    ],
    [me],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">
          A key activates devices on this license. Polaris Key keeps only its
          hash.
        </p>
        {license.keys.length > 0 ? (
          <Button
            variant="outline"
            iconStart={<KeyRound />}
            onClick={() => setMintOpen(true)}
          >
            Mint key
          </Button>
        ) : null}
      </div>
      <DataTable<KeyDto>
        id="license-keys"
        caption="Keys"
        data={rows}
        columns={columns}
        getRowId={(k) => k.hash}
        rowLabel={(k) => k.label || k.hash.slice(0, 6)}
        state={state}
        onStateChange={setState}
        exportCsv={false}
        rowActions={(k) =>
          k.status === "active"
            ? [
                {
                  label: "Revoke",
                  tone: "danger",
                  onSelect: () => setRevoking(k),
                },
              ]
            : []
        }
        empty={
          <EmptyState
            kind="first-run"
            title={revoked.length ? "No active keys" : "No keys yet"}
            description="Mint a key to activate a device on this license."
            primaryAction={
              <Button
                iconStart={<KeyRound />}
                onClick={() => setMintOpen(true)}
              >
                Mint key
              </Button>
            }
            docs={docsUrl("mintKey")}
          />
        }
        mobile="cards"
      />
      {revoked.length > 0 ? (
        <Button
          variant="link"
          size="sm"
          aria-expanded={showRevoked}
          onClick={() => setShowRevoked((s) => !s)}
        >
          {showRevoked ? "Hide" : "Show"} {revoked.length} revoked
        </Button>
      ) : null}

      <MintKeyDialog
        slug={slug}
        licenseId={license.id}
        open={mintOpen}
        onOpenChange={setMintOpen}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        intent={confirmFor("key.revoke").intent as "danger"}
        title={`Revoke key ${revoking?.label ? `“${revoking.label}”` : (revoking?.hash.slice(0, 6) ?? "")}?`}
        consequences={[
          "Devices using this key must activate again with another key.",
          "A revoked key can't be restored.",
        ]}
        confirmLabel="Revoke key"
        describeError={(e) => errorCopy(e, { thing: "Key" })}
        onConfirm={async () => {
          if (!revoking) return;
          await mutate("revokeKey", slug, license.id, revoking.hash);
          toast.success("Key revoked");
        }}
      />
    </div>
  );
}

/** Mint a key with an optional label, then show it once (LIC-2). */
export function MintKeyDialog({
  slug,
  licenseId,
  open,
  onOpenChange,
}: {
  slug: string;
  licenseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [label, setLabel] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [minted, setMinted] = React.useState<string | null>(null);
  const [ack, setAck] = React.useState(false);
  const [asking, setAsking] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setLabel("");
      setBusy(false);
      setError(null);
      setMinted(null);
      setAck(false);
      setAsking(false);
    }
  }, [open]);

  const mint = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await mutate(
        "mintKey",
        slug,
        licenseId,
        label.trim() || undefined,
      );
      setMinted(res.key);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={minted ? "Key minted" : "Mint key"}
      description={
        minted
          ? "Copy it now. It is shown only once."
          : "A new key for this license. Existing keys keep working."
      }
      dismissible={!busy}
      onOpenChange={(o) => {
        if (o) return onOpenChange(true);
        if (minted && !ack) return setAsking(true);
        onOpenChange(false);
      }}
    >
      {minted ? (
        <OneTimeSecretPanel
          label="License key"
          value={minted}
          acknowledged={ack}
          onAcknowledgedChange={(v) => {
            setAck(v);
            if (v) setAsking(false);
          }}
          closeRequested={asking}
          onCancelClose={() => setAsking(false)}
          onConfirmClose={() => onOpenChange(false)}
          onDone={() => onOpenChange(false)}
        />
      ) : (
        <form
          noValidate
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void mint();
          }}
        >
          <DialogBody className="space-y-4">
            <FormField
              name="label"
              label="Label"
              help="Optional. Where the key is used: “Studio laptop”."
              value={label}
              onChange={(v: string) => setLabel(v)}
            >
              {(f) => <Input {...f} autoFocus />}
            </FormField>
            {error ? (
              <Callout tone="danger" title="The key wasn't minted" live>
                {errorCopy(error, { thing: "License" }).description}
              </Callout>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Mint key
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
