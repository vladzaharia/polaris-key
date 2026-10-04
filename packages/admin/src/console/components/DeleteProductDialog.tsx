import * as React from "react";
import { errorCopy } from "../../lib/errorCopy.js";
import { confirmFor } from "../../lib/actions.js";
import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import { toast } from "../../ui/toast.js";
import { mutate } from "../data/mutations.js";

/**
 * Delete product: the console's one L3 confirmation for it (ADMIN.md §5.2), shared by the
 * Products registry and the product's Settings danger zone so the two can never word or guard it
 * differently (PRD-3, PRD-5).
 *
 * The operator types the slug; that typed value is what reaches the worker as `confirmSlug`
 * (PRD-4: the client used to fill it in itself, so the server's guard guarded nothing). One verb
 * everywhere: "Delete product", toast "Product deleted". The docs explain that it is a tombstone.
 */
export function DeleteProductDialog({
  product,
  open,
  onOpenChange,
  onDeleted,
}: {
  product: { slug: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After the server confirms: navigate away, focus the list heading… */
  onDeleted?: (slug: string) => void;
}): React.ReactElement {
  const policy = confirmFor("product.delete");
  const slug = product?.slug ?? "";
  const name = product?.name || slug;
  return (
    <ConfirmDialog
      open={open && product !== null}
      onOpenChange={onOpenChange}
      intent={policy.intent === "none" ? "danger" : policy.intent}
      title={`Delete ${name}?`}
      description="The product is tombstoned: its slug stays reserved and its history is kept, but it stops serving."
      consequences={[
        "Every license of this product is disabled.",
        "Every device token is evicted; devices can no longer refresh or activate.",
        "Its public routes stop answering, and it leaves the console.",
        "Audit and runtime history are preserved.",
      ]}
      typedConfirmation={{ value: slug, label: "Type the product slug" }}
      confirmLabel="Delete product"
      describeError={(e) => errorCopy(e, { thing: "Product" })}
      onConfirm={async () => {
        // The dialog only enables Confirm once the typed value equals the slug, so this IS the
        // operator's typed value.
        await mutate("deleteProduct", slug, slug);
        toast.success("Product deleted", {
          description: `${name} (${slug}) is tombstoned.`,
        });
        onDeleted?.(slug);
      }}
    />
  );
}
