import * as React from "react";
import { Button } from "../../ui/Button.js";
import { ConfirmDialog, type ConfirmIntent } from "../../ui/ConfirmDialog.js";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  type DialogSize,
} from "../../ui/Dialog.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../ui/Drawer.js";
import {
  OneTimeSecretDialog,
  OneTimeSecretPanel,
} from "../../ui/OneTimeSecretPanel.js";
import type { Story } from "../types.js";

const KEY = "PK-DJDL-7Q4M-X2PL-9RTA-C3VB-H8NE-K1WS";

function DialogDemo({ size }: { size: DialogSize }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open {size} dialog
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size={size}
        title="Edit holder"
        description="The holder's name and email appear on the license and in the customer portal."
      >
        <DialogBody>
          <p className="text-sm text-fg">
            Below 640 px this dialog is a bottom sheet with a drag handle.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => setOpen(false)}>Save holder</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

function BusyDialogDemo(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open a busy dialog
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        dismissible={false}
        title="Resyncing from repo"
        description="Escape and outside clicks do nothing while the dialog is busy."
      >
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Finish</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

const CONFIRM_COPY: Record<
  string,
  { title: string; verb: string; consequences: string[] }
> = {
  neutral: {
    title: "Resync from repo?",
    verb: "Resync from repo",
    consequences: [
      "Services, catalog, tiers and profiles are re-applied from .pkey/.",
      "Values set in the console survive.",
    ],
  },
  caution: {
    title: "Disable license?",
    verb: "Disable license",
    consequences: [
      "Every device loses access at its next check-in.",
      "Keys stay valid and the license can be enabled again.",
    ],
  },
  danger: {
    title: "Yank 2.4.0?",
    verb: "Yank 2.4.0",
    consequences: [
      "Devices on 2.4.0 are offered the previous release at their next check.",
      "Channels pointing at 2.4.0 move to the newest eligible release.",
    ],
  },
  typed: {
    title: "Delete DJDL?",
    verb: "Delete product",
    consequences: [
      "Every license is disabled and every device token is evicted.",
      "The slug stays reserved.",
    ],
  },
};

function ConfirmDemo({
  intent,
  label,
  fail,
  typed,
}: {
  intent: ConfirmIntent;
  label: string;
  fail?: boolean;
  typed?: boolean;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const copy = CONFIRM_COPY[typed ? "typed" : intent]!;
  return (
    <>
      <Button
        variant={intent === "danger" ? "danger" : "outline"}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        intent={intent}
        title={copy.title}
        consequences={copy.consequences}
        typedConfirmation={
          typed
            ? { value: "djdl", label: "Type the product slug to confirm:" }
            : undefined
        }
        confirmLabel={copy.verb}
        onConfirm={async () => {
          await new Promise((r) => setTimeout(r, 600));
          if (fail) throw new Error("Someone changed this license. Try again.");
        }}
      />
    </>
  );
}

function DrawerDemo({ side }: { side: "end" | "start" }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open drawer from the {side}
      </Button>
      <Drawer
        open={open}
        onOpenChange={setOpen}
        side={side}
        title="dev_8f2c41"
        description="Studio PC · Windows 11 · x64"
      >
        <DrawerBody>
          <p className="text-fg">
            Below 1024 px the drawer is full-screen with a Back button.
          </p>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button variant="danger">Deauthorize…</Button>
        </DrawerFooter>
      </Drawer>
    </>
  );
}

function SecretDemo(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Create license</Button>
      <OneTimeSecretDialog
        open={open}
        onOpenChange={setOpen}
        title="License created"
        label="License key"
        value={KEY}
        onDone={() => undefined}
      />
    </>
  );
}

export const stories: Story[] = [
  {
    id: "dialog",
    group: "Overlays",
    title: "Dialog: sizes and the busy state",
    description:
      "sm 24rem, md 32rem, lg 44rem, xl 60rem. A busy dialog cannot be dismissed.",
    render: () => (
      <div className="flex flex-wrap gap-3">
        {(["sm", "md", "lg", "xl"] as const).map((s) => (
          <DialogDemo key={s} size={s} />
        ))}
        <BusyDialogDemo />
      </div>
    ),
  },
  {
    id: "confirm-dialog",
    group: "Overlays",
    title: "ConfirmDialog: intents, typed confirmation and errors",
    description:
      "L1 caution, L2 danger, L3 typed. An error stays inline and confirm retries.",
    render: () => (
      <div className="flex flex-wrap gap-3">
        <ConfirmDemo intent="neutral" label="Resync from repo…" />
        <ConfirmDemo intent="caution" label="Disable license…" />
        <ConfirmDemo intent="danger" label="Yank…" />
        <ConfirmDemo intent="danger" label="Delete product…" typed />
        <ConfirmDemo
          intent="caution"
          label="Disable license (server refuses)…"
          fail
        />
      </div>
    ),
  },
  {
    id: "drawer",
    group: "Overlays",
    title: "Drawer",
    description: "Peek, detail and secondary forms.",
    render: () => (
      <div className="flex flex-wrap gap-3">
        <DrawerDemo side="end" />
        <DrawerDemo side="start" />
      </div>
    ),
  },
  {
    id: "one-time-secret",
    group: "Overlays",
    title: "OneTimeSecretPanel",
    description:
      "Done waits for Copy or the acknowledgement; closing early asks first.",
    render: () => (
      <div className="space-y-4">
        <SecretDemo />
        <div className="flex max-w-lg flex-col rounded-lg border border-border bg-surface-overlay">
          <OneTimeSecretPanel
            label="Offline bundle"
            value="pkb1.eyJsaWMiOiJsaWNfMDFKOSJ9.c2lnbmF0dXJl"
            hint="Shown once. Download it or copy it now."
            download={{ filename: "djdl.pkeybundle" }}
            onDone={() => undefined}
          />
        </div>
        <div className="flex max-w-lg flex-col rounded-lg border border-border bg-surface-overlay">
          <OneTimeSecretPanel
            label="CI token"
            value="pkci_3f9a1c0b7e2d48d02"
            acknowledged={false}
            closeRequested
            onCancelClose={() => undefined}
            onConfirmClose={() => undefined}
            onDone={() => undefined}
          />
        </div>
      </div>
    ),
  },
];
