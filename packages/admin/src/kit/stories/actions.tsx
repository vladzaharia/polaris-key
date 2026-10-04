import { Copy, Plus, Trash2 } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { IconButton } from "../../ui/IconButton.js";
import { ActionMenu } from "../../ui/ActionMenu.js";
import { CopyButton } from "../../ui/CopyButton.js";
import { Pin, Rocket } from "lucide-react";
import { SERVICE_TABLE } from "../../services.generated.js";
import type { Story } from "../types.js";

const VARIANTS = [
  "primary",
  "secondary",
  "outline",
  "ghost",
  "danger",
  "link",
] as const;

export const stories: Story[] = [
  {
    id: "button-variants",
    group: "Actions",
    title: "Button: variants and sizes",
    description:
      "Primary takes the section accent; danger is always the danger status.",
    render: () => (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {VARIANTS.map((v) => (
            <Button key={v} variant={v}>
              {v === "danger"
                ? "Delete product…"
                : `${v[0]!.toUpperCase()}${v.slice(1)}`}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {(["xs", "sm", "md", "lg"] as const).map((s) => (
            <Button key={s} size={s} iconStart={<Plus />}>
              New tier ({s})
            </Button>
          ))}
        </div>
      </div>
    ),
  },
  {
    id: "button-states",
    group: "Actions",
    title: "Button: loading and disabled with a reason",
    description:
      "Loading always disables. A disabled reason keeps the button focusable, with a tooltip.",
    render: () => (
      <div className="flex flex-wrap items-center gap-3">
        <Button loading>Saving…</Button>
        <Button loading disabled={false} variant="outline">
          Loading wins over disabled={"{false}"}
        </Button>
        <Button disabled>Plain disabled</Button>
        <Button disabledReason="Retire is unavailable for the active key. Activate another key first.">
          Retire
        </Button>
        <Button variant="danger" disabledReason="Used by 12 licenses">
          Delete tier…
        </Button>
      </div>
    ),
  },
  {
    id: "button-accents",
    group: "Actions",
    title: "Button: primary in every section",
    description:
      "data-service scoping re-points the accent; no component names a colour.",
    render: () => (
      <div className="flex flex-wrap items-center gap-3">
        <span data-service="core">
          <Button>Core</Button>
        </span>
        {SERVICE_TABLE.map((s) => (
          <span key={s.slug} data-service={s.slug}>
            <Button>{s.label}</Button>
          </span>
        ))}
      </div>
    ),
  },
  {
    id: "icon-button",
    group: "Actions",
    title: "IconButton",
    description:
      "The label is required: it is the accessible name and the tooltip.",
    render: () => (
      <div className="flex items-center gap-2">
        <IconButton label="Copy public key" icon={<Copy />} />
        <IconButton label="Delete secret" icon={<Trash2 />} variant="outline" />
        <IconButton
          label="Delete secret"
          icon={<Trash2 />}
          disabledReason="Required by .pkey/product"
        />
      </div>
    ),
  },
  {
    id: "action-menu",
    group: "Actions",
    title: "ActionMenu",
    description:
      "Disabled items stay visible with their reason; destructive items come last, after a separator.",
    render: () => (
      <div className="flex items-center gap-6">
        <ActionMenu
          label="Actions for release 2.4.0"
          items={[
            {
              label: "Promote to stable…",
              icon: <Rocket />,
              onSelect: () => undefined,
            },
            {
              label: "Pin on beta…",
              icon: <Pin />,
              description: "Freezes the channel at this release",
              onSelect: () => undefined,
            },
            { type: "separator" },
            {
              label: "Yank…",
              tone: "danger",
              disabledReason: "Already yanked",
              onSelect: () => undefined,
            },
            {
              label: "Delete draft…",
              tone: "danger",
              onSelect: () => undefined,
            },
          ]}
        />
        <ActionMenu
          label="More actions"
          trigger={<Button variant="outline">More actions</Button>}
          items={[
            { label: "Edit holder…", onSelect: () => undefined },
            { label: "Mint offline bundle…", onSelect: () => undefined },
            { type: "separator" },
            {
              label: "Disable license…",
              tone: "danger",
              onSelect: () => undefined,
            },
          ]}
        />
      </div>
    ),
  },
  {
    id: "copy-button",
    group: "Actions",
    title: "CopyButton",
    description:
      "Announces \u201cCopied\u201d; when the clipboard refuses, the value appears selected with the copy chord.",
    render: () => (
      <div className="flex flex-wrap items-center gap-4">
        <span className="inline-flex items-center gap-2 font-mono text-xs text-fg">
          MCowBQYDK2VwAyEA…Qa
          <CopyButton value="MCowBQYDK2VwAyEAexample" label="Copy public key" />
        </span>
        <CopyButton
          value="https://key.plrs.im/djdl/.well-known/jwks.json"
          label="Copy JWKS URL"
          showLabel
        />
      </div>
    ),
  },
];
