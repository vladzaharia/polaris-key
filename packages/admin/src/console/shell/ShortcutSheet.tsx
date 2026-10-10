import * as React from "react";
import { Dialog, DialogBody } from "../../ui/Dialog.js";
import { PRODUCT_PAGES } from "../nav.js";
import { GLOBAL_SHORTCUTS, type ShortcutDef } from "../shortcuts.js";
import { Kbd } from "../../ui/Kbd.js";

/** The product `g` shortcuts, read from nav.ts so the sheet cannot drift from the handlers. */
export function productShortcuts(): ShortcutDef[] {
  return PRODUCT_PAGES.filter((p) => p.shortcut).map((p) => ({
    keys: `g ${p.shortcut}`,
    label: `Go to ${p.shortcutLabel ?? p.label}`,
    scope: "product" as const,
  }));
}

/** The keyboard shortcut sheet (`?`, ADMIN.md §5.5). */
export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const groups: { title: string; items: ShortcutDef[] }[] = [
    { title: "Everywhere", items: GLOBAL_SHORTCUTS },
    {
      title: "In a product (when its section is enabled)",
      items: productShortcuts(),
    },
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description="Shortcuts never fire while you type in a field."
    >
      <DialogBody className="space-y-4 pb-6">
        {groups.map((g) => (
          <section key={g.title}>
            <h3 className="mb-1 text-xs font-semibold text-fg-muted">
              {g.title}
            </h3>
            <dl className="divide-y divide-border">
              {g.items.map((s) => (
                <div
                  key={`${s.keys}:${s.label}`}
                  className="flex items-center gap-3 py-1.5 text-sm"
                >
                  <dt className="flex-1">{s.label}</dt>
                  <dd>
                    <Kbd keys={s.keys} />
                    <span className="sr-only">{s.keys}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogBody>
    </Dialog>
  );
}
