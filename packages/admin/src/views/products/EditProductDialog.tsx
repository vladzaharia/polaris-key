import * as React from "react";
import { api, type ProductDetail } from "../../api.js";
import { invalidate } from "../../context.js";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  useToast,
} from "../../components/ui/index.js";
import { errorMessage, intOrUndefined, trimmedOrUndefined } from "./util.js";

/**
 * Edit a product's mutable registry fields (name, compat range, default policy, admin group)
 * via `updateProduct`. The slug + signing key are immutable here. On success we toast and
 * invalidate so the list + any detail re-fetch.
 */
export function EditProductDialog({
  product,
  open,
  onOpenChange,
}: {
  product: ProductDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const toast = useToast();
  const [name, setName] = React.useState(product.name);
  const [compatMin, setCompatMin] = React.useState(product.compatMin);
  const [compatMax, setCompatMax] = React.useState(product.compatMax);
  const [maxOfflineDays, setMaxOfflineDays] = React.useState(String(product.defaultMaxOfflineDays ?? ""));
  const [machineLimit, setMachineLimit] = React.useState(String(product.defaultMachineLimit ?? ""));
  const [adminGroup, setAdminGroup] = React.useState(product.adminGroup ?? "");
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // Re-seed when the dialog opens for a (possibly different) product.
  React.useEffect(() => {
    if (open) {
      setName(product.name);
      setCompatMin(product.compatMin);
      setCompatMax(product.compatMax);
      setMaxOfflineDays(String(product.defaultMaxOfflineDays ?? ""));
      setMachineLimit(String(product.defaultMachineLimit ?? ""));
      setAdminGroup(product.adminGroup ?? "");
      setFormError(null);
    }
  }, [open, product]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setFormError(null);
    try {
      await api.updateProduct(product.slug, {
        name: trimmedOrUndefined(name),
        compatMin: trimmedOrUndefined(compatMin),
        compatMax: trimmedOrUndefined(compatMax),
        defaultMaxOfflineDays: intOrUndefined(maxOfflineDays),
        defaultMachineLimit: intOrUndefined(machineLimit),
        adminGroup: trimmedOrUndefined(adminGroup),
      });
      invalidate("products");
      toast.success("Product updated", `“${product.slug}” saved.`);
      onOpenChange(false);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit “{product.slug}”</DialogTitle>
          <DialogDescription>Update the product&apos;s name, compatibility range, and default policy.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={product.slug} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Compat min">
              <Input value={compatMin} onChange={(e) => setCompatMin(e.target.value)} placeholder="1.0.0" />
            </Field>
            <Field label="Compat max">
              <Input value={compatMax} onChange={(e) => setCompatMax(e.target.value)} placeholder="2.0.0" />
            </Field>
            <Field label="Default max offline days">
              <Input
                type="number"
                inputMode="numeric"
                value={maxOfflineDays}
                onChange={(e) => setMaxOfflineDays(e.target.value)}
              />
            </Field>
            <Field label="Default machine limit">
              <Input
                type="number"
                inputMode="numeric"
                value={machineLimit}
                onChange={(e) => setMachineLimit(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Admin group" help="OIDC group that administers this product.">
            <Input value={adminGroup} onChange={(e) => setAdminGroup(e.target.value)} placeholder="pkey-admins" />
          </Field>

          {formError ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {formError}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Save changes
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
