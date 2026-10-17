/**
 * The license's Keys tab (ADMIN.md §6.5.2): label, hash (first 6 … last 4, LDT-11), status,
 * created, created by (named where the actor is known) and last used. Revoked keys collapse
 * under "Show N revoked". Revoke is L2 danger; Mint key shows the key once (LIC-2).
 */

import * as React from "react";
import { KeyRound } from "lucide-react";
import {
  ApiError,
  type KeyDto,
  type KeyEmailFailure,
  type LicenseDetail,
} from "../../../../api.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { useMe } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import { confirmFor } from "../../../../lib/actions.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { Dialog, DialogBody, DialogFooter } from "../../../../ui/Dialog.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { FormField } from "../../../../ui/form.js";
import { Hash } from "../../../../ui/Hash.js";
import { Input } from "../../../../ui/Input.js";
import { OneTimeSecretPanel } from "../../../../ui/OneTimeSecretPanel.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { toast } from "../../../../ui/toast.js";
import { DataTable, type DataColumn } from "../../../../ui/data-table/index.js";
import { actorName } from "../components/shared.js";

export function LicenseKeys({
  slug,
  license,
}: {
  slug: string;
  license: LicenseDetail;
}): React.ReactElement {
  const me = useMe().data;
  const [state, setState] = useTableUrlState("keys", { namespace: true });
  const [showRevoked, setShowRevoked] = React.useState(false);
  const [mintOpen, setMintOpen] = React.useState(false);
  const [revoking, setRevoking] = React.useState<KeyDto | null>(null);

  const active = license.keys.filter((k) => k.status === "active");
  const revoked = license.keys.filter((k) => k.status !== "active");
  const rows = showRevoked ? [...active, ...revoked] : active;

  const columns = React.useMemo<DataColumn<KeyDto>[]>(
    () => [
      {
        id: "label",
        header: "Label",
        accessorFn: (k) => k.label ?? "",
        meta: { priority: 1 },
        cell: ({ getValue }) =>
          (getValue() as string) || <span className="text-fg-muted">—</span>,
      },
      {
        id: "hash",
        header: "Hash",
        accessorKey: "hash",
        meta: { priority: 1 },
        cell: ({ row }) => <Hash value={row.original.hash} label="key hash" />,
      },
      {
        id: "status",
        header: "Status",
        accessorKey: "status",
        meta: { priority: 1 },
        cell: ({ row }) => (
          <StatusPill domain="key" state={row.original.status} />
        ),
      },
      {
        id: "createdAt",
        header: "Created",
        accessorKey: "createdAt",
        meta: { numeric: true, priority: 2 },
        cell: ({ row }) => (
          <Timestamp at={fromSeconds(row.original.createdAt)} />
        ),
      },
      {
        id: "createdBy",
        header: "Created by",
        accessorFn: (k) => actorName(k.createdBy, me) ?? "",
        meta: { priority: 3 },
      },
      {
        id: "lastUsedAt",
        header: "Last used",
        accessorFn: (k) => k.lastUsedAt ?? 0,
        meta: { numeric: true, priority: 2 },
        cell: ({ row }) =>
          row.original.lastUsedAt ? (
            <Timestamp at={fromSeconds(row.original.lastUsedAt)} />
          ) : (
            <span className="text-fg-muted">Never</span>
          ),
      },
    ],
    [me],
  );

  return (
    <div className="space-y-4">
      <DataTable<KeyDto>
        id="license-keys"
        caption="Keys"
        data={rows}
        columns={columns}
        getRowId={(k) => k.hash}
        rowLabel={(k) => k.label || k.hash.slice(0, 6)}
        state={state}
        onStateChange={setState}
        exportCsv={false}
        rowActions={(k) =>
          k.status === "active"
            ? [
                {
                  label: "Revoke",
                  tone: "danger",
                  onSelect: () => setRevoking(k),
                },
              ]
            : []
        }
        empty={
          <EmptyState
            kind="first-run"
            title={revoked.length ? "No active keys" : "No keys yet"}
            description="Mint a key to activate a device on this license."
            primaryAction={
              <Button
                iconStart={<KeyRound />}
                onClick={() => setMintOpen(true)}
              >
                Mint key
              </Button>
            }
            docs={docsUrl("mintKey")}
          />
        }
        mobile="cards"
      />
      {revoked.length > 0 ? (
        <Button
          variant="link"
          size="sm"
          aria-expanded={showRevoked}
          onClick={() => setShowRevoked((s) => !s)}
        >
          {showRevoked ? "Hide" : "Show"} {revoked.length} revoked
        </Button>
      ) : null}

      <MintKeyDialog
        slug={slug}
        licenseId={license.id}
        open={mintOpen}
        onOpenChange={setMintOpen}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        intent={confirmFor("key.revoke").intent as "danger"}
        title={`Revoke key ${revoking?.label ? `“${revoking.label}”` : (revoking?.hash.slice(0, 6) ?? "")}?`}
        consequences={[
          "Devices using this key must activate again with another key.",
          "A revoked key can't be restored.",
        ]}
        confirmLabel="Revoke key"
        describeError={(e) => errorCopy(e, { thing: "Key" })}
        onConfirm={async () => {
          if (!revoking) return;
          await mutate("revokeKey", slug, license.id, revoking.hash);
          toast.success("Key revoked");
        }}
      />
    </div>
  );
}

/** Mint a key with an optional label, then show it once (LIC-2). */
export function MintKeyDialog({
  slug,
  licenseId,
  open,
  onOpenChange,
}: {
  slug: string;
  licenseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [label, setLabel] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [minted, setMinted] = React.useState<string | null>(null);
  const [ack, setAck] = React.useState(false);
  const [asking, setAsking] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setLabel("");
      setBusy(false);
      setError(null);
      setMinted(null);
      setAck(false);
      setAsking(false);
    }
  }, [open]);

  const mint = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await mutate(
        "mintKey",
        slug,
        licenseId,
        label.trim() || undefined,
      );
      setMinted(res.key);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={minted ? "Key minted" : "Mint key"}
      description={
        minted
          ? "Copy it now. It is shown only once."
          : "Existing keys keep working."
      }
      dismissible={!busy}
      onOpenChange={(o) => {
        if (o) return onOpenChange(true);
        if (minted && !ack) return setAsking(true);
        onOpenChange(false);
      }}
    >
      {minted ? (
        <OneTimeSecretPanel
          label="License key"
          value={minted}
          acknowledged={ack}
          onAcknowledgedChange={(v) => {
            setAck(v);
            if (v) setAsking(false);
          }}
          closeRequested={asking}
          onCancelClose={() => setAsking(false)}
          onConfirmClose={() => onOpenChange(false)}
          onDone={() => onOpenChange(false)}
        />
      ) : (
        <form
          noValidate
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void mint();
          }}
        >
          <DialogBody className="space-y-4">
            <FormField
              name="label"
              label="Label"
              help="Optional. Where the key is used: “Studio laptop”."
              value={label}
              onChange={(v: string) => setLabel(v)}
            >
              {(f) => <Input {...f} autoFocus />}
            </FormField>
            {error ? (
              <Callout tone="danger" title="The key wasn't minted" live>
                {errorCopy(error, { thing: "License" }).description}
              </Callout>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Mint key
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

/** What a send-key left behind when the email did not go out: the key (valid) and why. */
export interface UnsentKey {
  key: string;
  reason?: KeyEmailFailure;
}

/** Whether another try could help: a refused address or missing mail setup cannot be fixed here. */
export const canRetryKeyEmail = (reason?: KeyEmailFailure): boolean =>
  reason !== "no_mail_binding" && reason !== "suppressed";

/** One line for why the email did not go out, in the operator's terms. */
export function keyEmailFailureCopy(
  reason: KeyEmailFailure | undefined,
  email: string,
): string {
  if (reason === "no_mail_binding")
    return "Email isn't set up for this product. Copy the key and send it yourself.";
  if (reason === "suppressed")
    return `${email} can't receive email from us. Copy the key and send it yourself.`;
  return "The email provider didn't accept it. Copy the key and send it yourself, or try again.";
}

const minutesText = (seconds: number): string => {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return `${m} min`;
};

/**
 * What a refused send-key (no key minted) says: the 409 reasons, the 429 with its wait, else
 * errorCopy's own title and description.
 */
export function sendKeyRefusal(
  error: unknown,
  email: string,
  waitSeconds: number,
): { title: string; description: string; details?: Record<string, unknown> } {
  if (error instanceof ApiError && error.status === 409) {
    if (error.reason === "license_not_active")
      return {
        title: "No key was made",
        description: "Enable the license first, then send a key.",
      };
    if (error.reason === "no_mail_binding" || error.reason === "suppressed")
      return {
        title: "No key was made",
        description: keyEmailFailureCopy(error.reason, email).replace(
          "Copy the key and send it yourself.",
          "Mint a key and send it yourself.",
        ),
      };
  }
  if (error instanceof ApiError && error.status === 429)
    return {
      title: "No key was made",
      description: `A key was just emailed. You can send another in ${minutesText(waitSeconds)}.`,
    };
  const copy = errorCopy(error, { thing: "License" });
  return {
    title: copy.title,
    description: copy.description,
    ...(copy.action === "copy-details" ? { details: copy.details } : {}),
  };
}

/**
 * **Send a new key…** (LX-27; notes/S-24 §8.4, D12): mints a key labelled "Sent by email" and
 * mails it to the license's address; the old keys keep working unless **Also revoke its other
 * keys** is ticked. One send per license per 10 minutes (the wait shows, and Send waits with it).
 * When the email does not go out the new key is already valid, so it is shown once here (closing
 * early asks first), with the reason; **Try again** (only when a retry can help, and only after
 * "I've stored it") emails another new key and leaves this one working. `initial` opens straight
 * on that result, for the Assign… dialog's failed send.
 */
export function SendKeyDialog({
  slug,
  licenseId,
  email,
  open,
  onOpenChange,
  initial = null,
  context,
}: {
  slug: string;
  licenseId: string;
  email: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: UnsentKey | null;
  context?: "assigned";
}): React.ReactElement {
  const [revokeOthers, setRevokeOthers] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [unsent, setUnsent] = React.useState<UnsentKey | null>(null);
  const [ack, setAck] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  const [until, setUntil] = React.useState(0);
  const [clock, setClock] = React.useState(Date.now());
  const titleRef = React.useRef<HTMLHeadingElement>(null);

  React.useEffect(() => {
    if (open) {
      setRevokeOthers(false);
      setBusy(false);
      setError(null);
      setUnsent(initial);
      setAck(false);
      setAsking(false);
      setUntil(0);
    }
  }, [open, initial]);
  React.useEffect(() => {
    if (!open || until <= Date.now()) return;
    const t = setInterval(() => setClock(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [open, until]);

  const waitSeconds = Math.max(0, Math.ceil((until - clock) / 1000));

  const send = async (retry: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // A retry never revokes: the key on screen may already be copied.
      const res = await mutate(
        "sendLicenseKey",
        slug,
        licenseId,
        retry ? false : revokeOthers,
        context,
      );
      if (res.delivered.email === "sent") {
        toast.success(
          `Key sent to ${email}.` +
            (res.revoked > 0
              ? ` ${res.revoked} other key${res.revoked === 1 ? "" : "s"} revoked.`
              : ""),
        );
        onOpenChange(false);
      } else {
        setUnsent({ key: res.key, reason: res.delivered.reason });
        setAck(false);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const wait = err.retryAfter ?? 600;
        setUntil(Date.now() + wait * 1000);
        setClock(Date.now());
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const refusal = error
    ? sendKeyRefusal(error, email, waitSeconds || 600)
    : null;
  const errorCallout = refusal ? (
    <Callout tone="danger" title={refusal.title} live>
      <span>{refusal.description}</span>
      {refusal.details ? (
        <CopyButton
          value={JSON.stringify(refusal.details, null, 2)}
          label="Copy details"
          showLabel
        />
      ) : null}
    </Callout>
  ) : null;

  const guardedClose = (next: boolean): void => {
    if (next) return onOpenChange(true);
    if (unsent && !ack) return setAsking(true);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      title={unsent ? "Key not emailed" : "Send a new key"}
      description={
        unsent ? "The new key works." : `Emails a new key to ${email}.`
      }
      dismissible={!busy}
      titleRef={titleRef}
      initialFocusRef={titleRef}
      onOpenChange={guardedClose}
    >
      {unsent ? (
        <OneTimeSecretPanel
          label="License key"
          value={unsent.key}
          acknowledged={ack}
          onAcknowledgedChange={(v) => {
            setAck(v);
            if (v) setAsking(false);
          }}
          closeRequested={asking}
          onCancelClose={() => setAsking(false)}
          onConfirmClose={() => {
            setAsking(false);
            onOpenChange(false);
          }}
          onDone={() => onOpenChange(false)}
          details={
            <div className="space-y-3">
              <Callout
                tone="warning"
                title={`The email to ${email} didn't go out`}
                live
              >
                {keyEmailFailureCopy(unsent.reason, email)}
              </Callout>
              {errorCallout}
              {canRetryKeyEmail(unsent.reason) ? (
                <p className="text-xs text-fg-muted">
                  Try again emails another new key. This one keeps working.
                </p>
              ) : null}
            </div>
          }
          actions={
            canRetryKeyEmail(unsent.reason) ? (
              <Button
                variant="outline"
                loading={busy}
                disabledReason={
                  !ack
                    ? "Tick “I've stored it” first"
                    : waitSeconds > 0
                      ? `Try again in ${minutesText(waitSeconds)}`
                      : undefined
                }
                onClick={() => void send(true)}
              >
                Try again
              </Button>
            ) : null
          }
        />
      ) : (
        <form
          noValidate
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void send(false);
          }}
        >
          <DialogBody className="space-y-4">
            <Checkbox
              checked={revokeOthers}
              onCheckedChange={setRevokeOthers}
              label="Also revoke its other keys"
              description="Old keys can't activate more devices. Devices already activated keep working."
            />
            {errorCallout}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabledReason={
                waitSeconds > 0
                  ? `Try again in ${minutesText(waitSeconds)}`
                  : undefined
              }
            >
              Send key
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
