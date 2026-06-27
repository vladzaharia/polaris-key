import * as React from "react";
import { api, type ProductDetail } from "../../api.js";
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
  Input,
  useToast,
} from "../../components/ui/index.js";
import { errorMessage } from "./util.js";

/**
 * Set a product secret. Both the name and value are write-only over the wire — the value is
 * never read back, so the input is a single-use field that clears on close. We do not echo or
 * persist the value in state beyond the submit.
 */
export function SecretDialog({
  product,
  open,
  onOpenChange,
}: {
  product: ProductDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const toast = useToast();
  const [name, setName] = React.useState("");
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName("");
      setValue("");
      setFormError(null);
    }
  }, [open]);

  const submit = async (): Promise<void> => {
    const n = name.trim();
    if (n === "") {
      setFormError("A secret name is required.");
      return;
    }
    if (value === "") {
      setFormError("A secret value is required.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api.putProductSecret(product.slug, n, value);
      toast.success("Secret set", `“${n}” stored for ${product.slug}.`);
      onOpenChange(false);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Set a secret for “{product.slug}”</DialogTitle>
          <DialogDescription>
            Secret values are write-only — they are stored encrypted and never
            read back.
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogBody>
            <div className="space-y-4">
              <Field
                label="Secret name"
                required
                help="e.g. GITHUB_APP_PRIVATE_KEY."
              >
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="SECRET_NAME"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                />
              </Field>
              <Field
                label="Secret value"
                required
                help="Written once; the value is not echoed back."
              >
                <Input
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                />
              </Field>

              {formError ? (
                <p
                  role="alert"
                  className="text-sm font-medium text-destructive"
                >
                  {formError}
                </p>
              ) : null}
            </div>
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
              Set secret
            </Button>
          </DialogActionBar>
        </form>
      </DialogContent>
    </Dialog>
  );
}
