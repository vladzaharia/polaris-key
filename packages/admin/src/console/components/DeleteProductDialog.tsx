import * as React from "react";
import { Trash2 } from "lucide-react";
import { errorCopy } from "../../lib/errorCopy.js";
import { Button } from "../../ui/Button.js";
import { confirmFor } from "../../lib/actions.js";
import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import { toast } from "../../ui/toast.js";
import { mutate } from "../data/mutations.js";
import { useWriteGate } from "../access/useCan.js";
import { navigate } from "../router.js";
import { r } from "../routes.js";

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

/**
 * The product Settings danger zone's "Delete product…" and its dialog. ST-29: deleting a product
 * is the Settings area's (and a step-up route); a member without the area sees the button
 * disabled, its reason naming who can delete it.
 */
export function DeleteProductAction({
  slug,
  product,
}: {
  slug: string;
  product: { slug: string; name: string };
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const gate = useWriteGate("settings", slug);
  return (
    <>
      <Button
        variant="danger"
        iconStart={<Trash2 aria-hidden />}
        disabledReason={gate.disabledReason}
        onClick={() => setOpen(true)}
      >
        Delete product…
      </Button>
      {/* One wording and one guard for Delete product, here and in the Products registry. It
          sends the typed slug as `confirmSlug`. */}
      <DeleteProductDialog
        product={product}
        open={open}
        onOpenChange={setOpen}
        onDeleted={() => navigate(r.home())}
      />
    </>
  );
}
