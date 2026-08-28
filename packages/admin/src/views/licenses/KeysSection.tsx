import * as React from "react";
import { KeyRound, Plus } from "lucide-react";
import { api, type KeyDto } from "../../api.js";
import { docsUrl } from "../../lib/docsLinks.js";
import {
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogActionBar,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  useToast,
  type ColumnDef,
} from "../../components/ui/index.js";
import {
  CopyButton,
  formatStamp,
  KeyStatusBadge,
  OneTimeKeyPanel,
} from "./shared.js";

/**
 * The license keys table: lists each issued key (by its hash, never the secret), supports minting
 * a new key (the secret is revealed ONCE) and revoking an active key behind a confirm. Mutations
 * toast + call `onChanged` so the parent can invalidate the license resource.
 */
export function KeysSection({
  slug,
  id,
  keys,
  onChanged,
}: {
  slug: string;
  id: string;
  keys: KeyDto[];
  onChanged: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [mintOpen, setMintOpen] = React.useState(false);
  const [revoking, setRevoking] = React.useState<KeyDto | null>(null);
  const [busy, setBusy] = React.useState(false);

  const revoke = async (): Promise<void> => {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.revokeKey(slug, id, revoking.hash);
      toast.success("Key revoked");
      onChanged();
      setRevoking(null);
    } catch (err) {
      toast.error(
        "Could not revoke key",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<KeyDto>[] = [
    {
      id: "hash",
      header: "Key (hash)",
      cell: (r) => (
        <div className="flex items-center gap-2">
          <code className="font-mono text-xs">{r.hash.slice(0, 16)}…</code>
          <CopyButton value={r.hash} label="Copy hash" className="h-7 px-2" />
        </div>
      ),
    },
    {
      id: "label",
      header: "Label",
      cell: (r) => r.label || <span className="text-muted-foreground">—</span>,
    },
    {
      id: "status",
      header: "Status",
      cell: (r) => <KeyStatusBadge status={r.status} />,
    },
    {
      id: "createdAt",
      header: "Created",
      accessor: (r) => r.createdAt,
      sortable: true,
      cell: (r) => formatStamp(r.createdAt),
    },
    { id: "createdBy", header: "By", cell: (r) => r.createdBy || "—" },
    {
      id: "lastUsedAt",
      header: "Last used",
      cell: (r) => formatStamp(r.lastUsedAt),
    },
    {
      id: "actions",
      header: "",
      headerClassName: "text-right",
      className: "text-right",
      cell: (r) =>
        r.status === "active" ? (
          <Button size="sm" variant="outline" onClick={() => setRevoking(r)}>
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setMintOpen(true)}>
          <Plus aria-hidden />
          Mint key
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={keys}
        rowKey={(r) => r.hash}
        empty={
          <EmptyState
            icon={<KeyRound aria-hidden />}
            title="No keys"
            description="Mint a key to let this license activate a device."
          />
        }
      />

      <MintKeyDialog
        slug={slug}
        id={id}
        open={mintOpen}
        onOpenChange={setMintOpen}
        onMinted={onChanged}
      />

      <ConfirmDialog
        open={revoking != null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke this key?"
        description="The key stops working immediately. Devices using it must re-activate with a new key. This cannot be undone."
        confirmLabel="Revoke key"
        loading={busy}
        onConfirm={revoke}
      />
    </div>
  );
}

function MintKeyDialog({
  slug,
  id,
  open,
  onOpenChange,
  onMinted,
}: {
  slug: string;
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMinted: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [label, setLabel] = React.useState("");
  const [minted, setMinted] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setLabel("");
      setMinted(null);
      setBusy(false);
    }
  }, [open]);

  const mint = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.mintKey(slug, id, label.trim() || undefined);
      setMinted(res.key);
      toast.success("Key minted");
      onMinted();
    } catch (err) {
      toast.error(
        "Could not mint key",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Mint license key</DialogTitle>
          <DialogDescription>
            {minted
              ? "Copy the key now — it is shown only once."
              : "Issue a new key for this license."}{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("mintKey")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </DialogDescription>
        </DialogHeader>
        {minted ? (
          <>
            <DialogBody>
              <div className="space-y-4">
                <OneTimeKeyPanel value={minted} />
              </div>
            </DialogBody>
            <DialogActionBar>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogActionBar>
          </>
        ) : (
          <form onSubmit={mint} className="contents">
            <DialogBody>
              <Field
                label="Label"
                help="Optional. A note to identify this key (e.g. “studio laptop”)."
              >
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="studio laptop"
                  autoFocus
                />
              </Field>
            </DialogBody>
            <DialogActionBar>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Mint key
              </Button>
            </DialogActionBar>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
