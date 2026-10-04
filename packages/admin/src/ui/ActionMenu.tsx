import * as React from "react";
import { DropdownMenu as Menu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import { cn } from "../lib/cn.js";
import type { ButtonSize } from "./Button.js";
import { IconButton } from "./IconButton.js";

export interface ActionMenuItem {
  type?: "item";
  label: string;
  onSelect: () => void;
  /** Destructive actions: styled danger. Put them last, after a separator. */
  tone?: "danger";
  /** Why the action is unavailable: the item stays visible, with this as a second line. */
  disabledReason?: string;
  icon?: React.ReactNode;
  /** A short secondary line for an enabled item. */
  description?: string;
}

export interface ActionMenuSeparator {
  type: "separator";
}

export type ActionMenuEntry = ActionMenuItem | ActionMenuSeparator;

export interface ActionMenuProps {
  /** Names the trigger and the menu: "Actions for release 2.4.0", "More actions". */
  label: string;
  items: ActionMenuEntry[];
  /** A custom trigger; it must accept a ref and forward props (a `Button`). */
  trigger?: React.ReactElement;
  align?: "start" | "center" | "end";
  size?: ButtonSize;
}

/**
 * The kebab and overflow menu (components.md §2.3). Disabled items are never hidden: they show
 * their reason as a visible second line and cannot be selected. Danger items come last, after a
 * separator, in the danger colour.
 */
export function ActionMenu({
  label,
  items,
  trigger,
  align = "end",
  size = "sm",
}: ActionMenuProps): React.ReactElement {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        {trigger ?? (
          <IconButton label={label} icon={<MoreHorizontal />} size={size} />
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align={align}
          sideOffset={4}
          aria-label={label}
          className="z-50 min-w-48 max-w-xs rounded-md border border-border bg-surface-overlay p-1 text-sm text-fg shadow-elevation-2 animate-pk-in"
        >
          {items.map((item, i) =>
            item.type === "separator" ? (
              <Menu.Separator
                key={`sep-${i}`}
                className="-mx-1 my-1 h-px bg-border"
              />
            ) : (
              <Menu.Item
                key={`${item.label}-${i}`}
                disabled={Boolean(item.disabledReason)}
                onSelect={() => item.onSelect()}
                className={cn(
                  "relative flex cursor-pointer select-none items-start gap-2 rounded-sm px-2 py-1.5 outline-hidden",
                  "focus:bg-hover data-[disabled]:cursor-not-allowed",
                  "[&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0",
                  item.tone === "danger"
                    ? "text-danger focus:bg-danger-subtle"
                    : "focus:text-fg-strong",
                )}
              >
                {item.icon ? (
                  <span aria-hidden className="contents">
                    {item.icon}
                  </span>
                ) : null}
                <span className="flex min-w-0 flex-col">
                  <span className={cn(item.disabledReason && "text-fg-muted")}>
                    {item.label}
                  </span>
                  {item.disabledReason || item.description ? (
                    <span className="text-xs text-fg-subtle">
                      {item.disabledReason ?? item.description}
                    </span>
                  ) : null}
                </span>
              </Menu.Item>
            ),
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
