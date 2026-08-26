import * as React from "react";
import { api, type ProductDetail } from "../../api.js";
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
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from "../../components/ui/index.js";
import { errorMessage, intOrUndefined, trimmedOrUndefined } from "./util.js";

/**
 * Edit a product's mutable registry fields (name, compat range, default policy, and the
 * non-authorizing admin-group label) via `updateProduct`. The slug + signing key are immutable
 * here. On success we toast and invalidate so the list + any detail re-fetch.
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
  const [maxOfflineDays, setMaxOfflineDays] = React.useState(
    String(product.defaultMaxOfflineDays ?? ""),
  );
  const [deviceLimit, setDeviceLimit] = React.useState(
    String(product.defaultDeviceLimit ?? ""),
  );
  const [adminGroup, setAdminGroup] = React.useState(product.adminGroup ?? "");
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState("basics");

  // Re-seed when the dialog opens for a (possibly different) product.
  React.useEffect(() => {
    if (open) {
      setName(product.name);
      setCompatMin(product.compatMin);
      setCompatMax(product.compatMax);
      setMaxOfflineDays(String(product.defaultMaxOfflineDays ?? ""));
      setDeviceLimit(String(product.defaultDeviceLimit ?? ""));
      setAdminGroup(product.adminGroup ?? "");
      setFormError(null);
      setActiveTab("basics");
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
        defaultDeviceLimit: intOrUndefined(deviceLimit),
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit “{product.slug}”</DialogTitle>
          <DialogDescription>
            Update the product&apos;s name, compatibility range, and default
            policy.
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
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="w-full">
                <TabsTrigger value="basics" className="flex-1">
                  Basics
                </TabsTrigger>
                <TabsTrigger value="compatibility" className="flex-1">
                  Compatibility
                </TabsTrigger>
                <TabsTrigger value="defaults" className="flex-1">
                  Defaults
                </TabsTrigger>
              </TabsList>

              <TabsContent value="basics" className="space-y-4">
                <Field label="Name">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={product.slug}
                    autoFocus
                  />
                </Field>
                {/* Manifest metadata only — it authorizes nothing. `admin/authz.ts` grants on
                    PLATFORM_ADMIN_GROUP alone and `canAdminProduct` takes no product argument;
                    per-product admin was removed. The old help text ("OIDC group that
                    administers this product") told the operator this field delegated
                    administration, and the server would cheerfully store the value and change
                    no access whatsoever. Matches the read-only wording in ProductOverview. */}
                <Field
                  label="Admin group (metadata only)"
                  help="Recorded on the product for reference. Grants no access — the console authorizes on PLATFORM_ADMIN_GROUP alone."
                >
                  <Input
                    value={adminGroup}
                    onChange={(e) => setAdminGroup(e.target.value)}
                    placeholder="pkey-admins"
                  />
                </Field>
              </TabsContent>

              <TabsContent
                value="compatibility"
                className="grid gap-4 sm:grid-cols-2"
              >
                <Field label="Compat min">
                  <Input
                    value={compatMin}
                    onChange={(e) => setCompatMin(e.target.value)}
                    placeholder="1.0.0"
                  />
                </Field>
                <Field label="Compat max">
                  <Input
                    value={compatMax}
                    onChange={(e) => setCompatMax(e.target.value)}
                    placeholder="2.0.0"
                  />
                </Field>
              </TabsContent>

              <TabsContent
                value="defaults"
                className="grid gap-4 sm:grid-cols-2"
              >
                <Field label="Default max offline days">
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={maxOfflineDays}
                    onChange={(e) => setMaxOfflineDays(e.target.value)}
                  />
                </Field>
                <Field label="Default device limit">
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={deviceLimit}
                    onChange={(e) => setDeviceLimit(e.target.value)}
                  />
                </Field>
              </TabsContent>
            </Tabs>

            {formError ? (
              <p
                role="alert"
                className="mt-4 text-sm font-medium text-destructive"
              >
                {formError}
              </p>
            ) : null}
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
              Save changes
            </Button>
          </DialogActionBar>
        </form>
      </DialogContent>
    </Dialog>
  );
}
