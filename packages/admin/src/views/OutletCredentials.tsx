import * as React from "react";
import { AlertTriangle, KeyRound, Pin, Trash2 } from "lucide-react";
import {
  api,
  type OutletCredentialInfo,
  type OutletCredentialKind,
} from "../api.js";
import { invalidate, useResource } from "../context.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogActionBar,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  useToast,
} from "../components/ui/index.js";
import { absoluteTime, relativeTime } from "./format.js";

/**
 * Outlet credentials (P5-01): the keys a store connector signs in to its store with — an App
 * Store Connect API key, the App Store webhook secret, a Google service account, a Partner
 * Center app. They are sealed in their own table under their own AAD kind, unreachable from
 * product secrets and edge-mint, and only the Distribution service can open them (every use is
 * audited).
 *
 * Like product secrets this is WRITE-ONLY: the form's values are sent once and never read back;
 * the list shows metadata (kind, outlet, created, last used, last result) and never a value.
 * The full "Outlets and credentials" view with webhook health is not this package's.
 *
 * **Pins (P5-02f).** A kind that can reach several store apps (a team-wide App Store Connect key,
 * a Google Play service account invited to several apps — P5-03) carries the operator's pin: the one app its connector may read and act on. The connector stays
 * off unless the product's `.pkey/distribution` names that same app, so a repo writer cannot aim
 * the key elsewhere. The form asks for it with the key; each row shows it, and "Pin" changes it
 * without the key material (an audited `outlet_credential.pin`).
 */

interface PinSpec {
  label: string;
  help: string;
}

interface FieldSpec {
  key: string;
  label: string;
  secret?: boolean;
  multiline?: boolean;
  help?: string;
}

const KINDS: {
  value: OutletCredentialKind;
  label: string;
  fields: FieldSpec[];
  /** The operator's pin, for a kind whose connector requires one. */
  pin?: PinSpec;
}[] = [
  {
    value: "asc-api-key",
    label: "App Store Connect API key",
    pin: {
      label: "App Store Connect app id (Apple ID)",
      help: "The numeric Apple ID of the one app this key may read and act on for this product. The connector stays off unless .pkey/distribution names the same app.",
    },
    fields: [
      { key: "keyId", label: "Key ID" },
      { key: "issuerId", label: "Issuer ID" },
      {
        key: "p8",
        label: ".p8 private key",
        secret: true,
        multiline: true,
        help: "Paste the whole .p8 file. Use a team key with the App Manager role.",
      },
    ],
  },
  {
    value: "asc-webhook-secret",
    label: "App Store webhook secret",
    fields: [{ key: "secret", label: "Secret", secret: true }],
  },
  {
    value: "google-service-account",
    label: "Google service account",
    pin: {
      label: "Google Play package name",
      help: "The package name (application id) of the one Play app this service account may read and act on for this product. The connector stays off unless .pkey/distribution names the same package.",
    },
    fields: [
      {
        key: "json",
        label: "JSON key file",
        secret: true,
        multiline: true,
        help: "Paste the service account's JSON key. Invite it to one app with release permissions only.",
      },
    ],
  },
  {
    value: "ms-partner-center",
    label: "Microsoft Partner Center app",
    fields: [
      { key: "tenantId", label: "Tenant ID" },
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "sellerId", label: "Seller ID" },
    ],
  },
];

const KIND_LABEL = new Map<string, string>(
  KINDS.map((k) => [k.value, k.label]),
);
const KIND_PIN = new Map<string, PinSpec>(
  KINDS.flatMap((k) => (k.pin ? [[k.value, k.pin] as const] : [])),
);

function LastResult({
  cred,
}: {
  cred: OutletCredentialInfo;
}): React.ReactElement {
  if (cred.lastError)
    return (
      <Badge variant="destructive" title={cred.lastError}>
        Error
      </Badge>
    );
  if (cred.lastOkAt !== null)
    return (
      <Badge variant="success" title={absoluteTime(cred.lastOkAt)}>
        OK
      </Badge>
    );
  return <span className="text-muted-foreground">—</span>;
}

function When({ at }: { at: number | null }): React.ReactElement {
  if (at === null) return <span className="text-muted-foreground">never</span>;
  return <span title={absoluteTime(at)}>{relativeTime(at)}</span>;
}

export function OutletCredentials({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const { data, loading, error, reload } = useResource(
    `outlet-credentials:${slug}`,
    () => api.outletCredentials(slug),
  );
  const toast = useToast();
  const [id, setId] = React.useState("");
  const [kind, setKind] = React.useState<OutletCredentialKind>("asc-api-key");
  const [outletId, setOutletId] = React.useState("");
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [pin, setPin] = React.useState("");
  const [pinning, setPinning] = React.useState<OutletCredentialInfo | null>(
    null,
  );
  const [newPin, setNewPin] = React.useState("");
  const [pinError, setPinError] = React.useState<string | null>(null);
  const [pinSaving, setPinSaving] = React.useState(false);

  const spec = KINDS.find((k) => k.value === kind)!;
  /** The `meta` field a kind's pin is kept under (the server's word, when it has spoken). */
  const pinField = (k: string): string | null =>
    data?.pins?.[k]?.field ??
    (k === "asc-api-key"
      ? "appleId"
      : k === "google-service-account"
        ? "packageName"
        : null);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const credentialId = id.trim();
    if (!credentialId) {
      setFormError("A credential id is required.");
      return;
    }
    const missing = spec.fields.find((f) => !(values[f.key] ?? "").trim());
    if (missing) {
      setFormError(`${missing.label} is required.`);
      return;
    }
    if (spec.pin && !pin.trim()) {
      setFormError(`${spec.pin.label} is required.`);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const value =
        kind === "google-service-account"
          ? values.json!
          : Object.fromEntries(spec.fields.map((f) => [f.key, values[f.key]]));
      await api.putOutletCredential(slug, credentialId, {
        kind,
        value,
        ...(spec.pin ? { pin: pin.trim() } : {}),
        outletId: outletId.trim() || null,
      });
      invalidate(`outlet-credentials:${slug}`);
      toast.success(
        "Credential saved",
        `“${credentialId}” was stored. Its value is never shown again.`,
      );
      setId("");
      setOutletId("");
      setValues({});
      setPin("");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Couldn’t save");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteOutletCredential(slug, deleting);
      toast.success("Credential deleted", `“${deleting}” was removed.`);
      setDeleting(null);
    } catch (err) {
      toast.error(
        "Couldn’t delete credential",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
      invalidate(`outlet-credentials:${slug}`);
    }
  };

  const savePin = async (): Promise<void> => {
    if (!pinning) return;
    const value = newPin.trim();
    if (!value) {
      setPinError("An app id is required.");
      return;
    }
    setPinSaving(true);
    setPinError(null);
    try {
      await api.putOutletCredential(slug, pinning.id, {
        kind: pinning.kind as OutletCredentialKind,
        pin: value,
      });
      invalidate(`outlet-credentials:${slug}`);
      toast.success(
        "Credential pinned",
        `“${pinning.id}” is pinned to ${value}.`,
      );
      setPinning(null);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : "Couldn’t pin");
    } finally {
      setPinSaving(false);
    }
  };

  const credentials = data?.credentials ?? [];

  return (
    <Card aria-labelledby="outlet-credentials-title">
      <CardHeader>
        <CardTitle id="outlet-credentials-title">Outlet credentials</CardTitle>
        <CardDescription>
          Store keys the Distribution service uses to reach App Store Connect,
          Google Play and the Microsoft Store. They are kept apart from product
          secrets — edge-mint can never sign with one — every use is audited,
          and values are write-only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading && !data ? (
          <Skeleton className="h-9 w-full" />
        ) : error && !data ? (
          <EmptyState
            icon={<AlertTriangle aria-hidden />}
            title="Couldn’t load outlet credentials"
            description={error}
            action={
              <Button variant="outline" size="sm" onClick={reload}>
                Retry
              </Button>
            }
          />
        ) : credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No outlet credentials yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Outlet credentials">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Id</th>
                  <th className="py-1 pr-3 font-medium">Kind</th>
                  <th className="py-1 pr-3 font-medium">Outlet</th>
                  <th className="py-1 pr-3 font-medium">Created</th>
                  <th className="py-1 pr-3 font-medium">Last used</th>
                  <th className="py-1 pr-3 font-medium">Last result</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {credentials.map((cred) => (
                  <tr key={cred.id} className="border-t border-border">
                    <td className="py-2 pr-3 font-mono text-xs">{cred.id}</td>
                    <td className="py-2 pr-3">
                      {KIND_LABEL.get(cred.kind) ?? cred.kind}
                      {(() => {
                        const field = pinField(cred.kind);
                        const shown = Object.entries(cred.meta)
                          .filter(([k]) => k !== field)
                          .map(([, v]) => v);
                        return (
                          <>
                            {shown.length ? (
                              <p className="font-mono text-xs text-muted-foreground">
                                {shown.join(" · ")}
                              </p>
                            ) : null}
                            {field ? (
                              cred.meta[field] ? (
                                <p className="text-xs text-muted-foreground">
                                  Pinned to app{" "}
                                  <span className="font-mono">
                                    {cred.meta[field]}
                                  </span>
                                </p>
                              ) : (
                                <Badge
                                  variant="warning"
                                  title="Its connector stays off until the credential is pinned to the product's app."
                                >
                                  Not pinned
                                </Badge>
                              )
                            ) : null}
                          </>
                        );
                      })()}
                    </td>
                    <td className="py-2 pr-3">{cred.outletId ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <When at={cred.createdAt} />
                    </td>
                    <td className="py-2 pr-3">
                      <When at={cred.lastUsedAt} />
                    </td>
                    <td className="py-2 pr-3">
                      <LastResult cred={cred} />
                    </td>
                    <td className="whitespace-nowrap py-2 text-right">
                      {pinField(cred.kind) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Pin ${cred.id}`}
                          onClick={() => {
                            setPinning(cred);
                            setNewPin(cred.meta[pinField(cred.kind)!] ?? "");
                            setPinError(null);
                          }}
                        >
                          <Pin aria-hidden className="size-4" />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${cred.id}`}
                        onClick={() => setDeleting(cred.id)}
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form
          onSubmit={(e) => void onSubmit(e)}
          noValidate
          className="space-y-4 rounded-md border border-border p-3"
          aria-label="Set an outlet credential"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            <KeyRound aria-hidden className="size-4" /> Set a credential
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Credential id"
              help="Lowercase, e.g. asc-team-key. Re-using an id rotates it."
            >
              <Input
                value={id}
                onChange={(e) => setId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Outlet (optional)" help="e.g. app-store, play.">
              <Input
                value={outletId}
                onChange={(e) => setOutletId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="outlet-credential-kind">Kind</Label>
            <Select
              value={kind}
              onValueChange={(next) => {
                setKind(next as OutletCredentialKind);
                setValues({});
              }}
            >
              <SelectTrigger id="outlet-credential-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {spec.fields.map((f) => (
            <Field key={`${kind}:${f.key}`} label={f.label} help={f.help}>
              {f.multiline ? (
                <Textarea
                  value={values[f.key] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                  autoComplete="off"
                  spellCheck={false}
                  rows={5}
                />
              ) : (
                <Input
                  type={f.secret ? "password" : "text"}
                  value={values[f.key] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                  autoComplete={f.secret ? "new-password" : "off"}
                  spellCheck={false}
                />
              )}
            </Field>
          ))}
          {spec.pin ? (
            <Field label={spec.pin.label} help={spec.pin.help}>
              <Input
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          ) : null}
          {formError ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {formError}
            </p>
          ) : null}
          <CardFooter className="p-0">
            <Button type="submit" variant="secondary" loading={saving}>
              Set credential
            </Button>
          </CardFooter>
        </form>
      </CardContent>

      <Dialog
        open={pinning !== null}
        onOpenChange={(o) => !o && !pinSaving && setPinning(null)}
      >
        <DialogContent className="max-w-md" aria-describedby="pin-desc">
          <DialogHeader>
            <DialogTitle>Pin “{pinning?.id ?? ""}” to an app</DialogTitle>
            <DialogDescription id="pin-desc">
              The connector reads and acts on this app only, and stays off while
              the product’s .pkey/distribution names another. Check that this is
              the product’s app: the console’s release controls cannot be
              undone. The change is audited.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <form
              id="pin-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void savePin();
              }}
            >
              <Field
                label={
                  (pinning && KIND_PIN.get(pinning.kind)?.label) ??
                  (pinning && data?.pins?.[pinning.kind]?.label) ??
                  "App id"
                }
              >
                <Input
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              {pinError ? (
                <p
                  role="alert"
                  className="mt-2 text-sm font-medium text-destructive"
                >
                  {pinError}
                </p>
              ) : null}
            </form>
          </DialogBody>
          <DialogActionBar>
            <DialogClose asChild>
              <Button variant="outline" disabled={pinSaving}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" form="pin-form" loading={pinSaving}>
              Pin
            </Button>
          </DialogActionBar>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete outlet credential “${deleting ?? ""}”?`}
        description="Connectors using it stop working until a new one is set. The value cannot be recovered."
        confirmLabel="Delete"
        loading={busy}
        onConfirm={remove}
      />
    </Card>
  );
}
