import * as React from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../../api.js";
import { invalidate } from "../../context.js";
import { Button, ConfirmDialog, useToast } from "../../components/ui/index.js";

/**
 * Triggers `api.resyncProduct(slug)` — re-fetches the product's `.pkey/` manifest and re-applies
 * release config + catalog + minters from the linked repo. This is the canonical way to EDIT
 * release config (there is no per-field release API); the operator changes `.pkey/release.*` in
 * the repo, then resyncs here. Confirmed because it overwrites server-side rows from the repo.
 */
export function ResyncButton({ slug }: { slug: string }): React.ReactElement {
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.resyncProduct(slug);
      toast.success(
        "Resynced from repo",
        "Release config and catalog were re-applied from `.pkey/`.",
      );
      // Refresh anything derived from the product row + its catalog.
      invalidate(`product:${slug}`);
      invalidate(`schema:${slug}`);
      setOpen(false);
    } catch (err) {
      toast.error(
        "Resync failed",
        err instanceof Error ? err.message : "Request failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <RefreshCw aria-hidden />
        Resync from repo
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => !busy && setOpen(next)}
        title="Resync from the linked repo?"
        description="Re-fetches `.pkey/` and re-applies release config, the catalog, and minters. Server values are overwritten by what is in the repo."
        confirmLabel="Resync"
        confirmVariant="primary"
        loading={busy}
        onConfirm={confirm}
      />
    </>
  );
}
