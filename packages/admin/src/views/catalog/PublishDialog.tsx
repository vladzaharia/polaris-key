import * as React from "react";
import type { ProductCatalog } from "../../api.js";
import { api } from "../../api.js";
import { invalidate } from "../../context.js";
import {
  Button,
  Dialog,
  DialogActionBar,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  Textarea,
  useToast,
} from "../../components/ui/index.js";
import { parseCatalogDraft } from "./helpers.js";

/**
 * "Publish new version" flow. Seeds a JSON editor from the active catalog, bumps the
 * `schemaVersion` by one as a sensible default, validates client-side on every keystroke, and
 * on submit calls `publishSchema(slug, catalog)`. On success it toasts, invalidates the
 * `schema:<slug>` resource so the table reloads, and closes.
 */
export function PublishDialog({
  slug,
  catalog,
  open,
  onOpenChange,
}: {
  slug: string;
  catalog: ProductCatalog;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const toast = useToast();
  const seed = React.useMemo(
    () =>
      JSON.stringify(
        { ...catalog, schemaVersion: catalog.schemaVersion + 1 },
        null,
        2,
      ),
    [catalog],
  );
  const [text, setText] = React.useState(seed);
  const [submitting, setSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  // Re-seed whenever the dialog opens or the active catalog changes underneath it.
  React.useEffect(() => {
    if (open) {
      setText(seed);
      setServerError(null);
    }
  }, [open, seed]);

  const parsed = React.useMemo(() => parseCatalogDraft(text), [text]);
  const error = serverError ?? (parsed.ok ? null : parsed.error);

  const submit = async (): Promise<void> => {
    if (!parsed.ok || !parsed.catalog) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await api.publishSchema(slug, parsed.catalog);
      toast.success(
        "Catalog published",
        `Schema version is now v${res.schemaVersion}.`,
      );
      invalidate(`schema:${slug}`);
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Publish failed.";
      setServerError(message);
      toast.error("Publish failed", message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !submitting && onOpenChange(next)}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Publish new catalog version</DialogTitle>
          <DialogDescription>
            Edit the catalog JSON below. It is validated locally before
            publishing; the worker re-validates every fragment with Ajv on save.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <Field
            label="Catalog JSON"
            help="A ProductCatalog object: { schemaVersion, entries[] }."
            error={error ?? undefined}
          >
            <Textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setServerError(null);
              }}
              spellCheck={false}
              rows={18}
              className="min-h-[18rem] resize-y"
              aria-label="Catalog JSON"
            />
          </Field>
        </DialogBody>

        <DialogActionBar>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={submitting}
            disabled={!parsed.ok}
          >
            Publish
          </Button>
        </DialogActionBar>
      </DialogContent>
    </Dialog>
  );
}
