/**
 * The credential forms (ST-12): the set / rotate drawer and the pin dialog. A value is sent once and
 * never read back, rendered or put in a URL; the pin changes the one store app a key may act on,
 * without its value (P5-02f).
 */

import * as React from "react";
import {
  HttpError,
  type OutletCredentialInfo,
  type OutletCredentialKind,
  type OutletCredentialsResponse,
  type PutOutletCredentialBody,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { Dialog, DialogBody, DialogFooter } from "../../../../ui/Dialog.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../../ui/Drawer.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { SecretInput } from "../../../../ui/SecretInput.js";
import { Select } from "../../../../ui/Select.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { useOutlets } from "../data.js";
import {
  describe,
  KIND,
  kindLabel,
  pinField,
  type KindSpec,
} from "../model/credentialKinds.js";

export function SetCredentialDrawer({
  slug,
  existing,
  rotate,
  kinds,
  channelScoped,
  onClose,
}: {
  slug: string;
  existing: OutletCredentialInfo[];
  rotate: OutletCredentialInfo | null;
  /** The kinds this drawer offers. */
  kinds: readonly KindSpec[];
  /** On a channel's own page the channel is known: no channel field. */
  channelScoped: boolean;
  onClose: () => void;
}): React.ReactElement {
  const outlets = useOutlets(slug);
  const [kind, setKind] = React.useState<OutletCredentialKind | null>(
    (rotate?.kind as OutletCredentialKind | undefined) ??
      (kinds.length === 1 ? (kinds[0]!.value as OutletCredentialKind) : null),
  );
  const [id, setId] = React.useState(rotate?.id ?? "");
  const [outletId, setOutletId] = React.useState<string | null>(
    rotate?.outletId ?? null,
  );
  // Kept across kind changes, so switching kind never loses what was typed (OUT-3).
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [pin, setPin] = React.useState("");
  const [generate, setGenerate] = React.useState(true);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [failure, setFailure] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmRotate, setConfirmRotate] = React.useState(false);

  const spec = kind ? KIND.get(kind) : undefined;
  const generating = Boolean(spec?.generate && generate);
  const reused = !rotate && existing.find((c) => c.id === id.trim());

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!kind) e.kind = "Choose a kind.";
    if (!rotate && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id.trim()))
      e.id =
        "Use up to 64 lowercase letters, digits, dots, dashes or underscores, e.g. asc-team-key.";
    if (spec && !generating)
      for (const f of spec.fields)
        if (!(values[f.key] ?? "").trim()) e[f.key] = `Enter the ${f.label}.`;
    if (spec?.pin && !rotate && !pin.trim())
      e.pin = `Enter the ${spec.pin.label}.`;
    return e;
  };

  const send = async (): Promise<void> => {
    if (!spec || !kind) return;
    setBusy(true);
    setFailure(null);
    try {
      const body: PutOutletCredentialBody = generating
        ? { kind, generate: true }
        : {
            kind,
            value:
              kind === "google-service-account"
                ? values.json!
                : Object.fromEntries(
                    spec.fields.map((f) => [f.key, values[f.key] ?? ""]),
                  ),
          };
      if (spec.pin && pin.trim()) body.pin = pin.trim();
      if (!rotate || outletId !== rotate.outletId) body.outletId = outletId;
      const credentialId = rotate?.id ?? id.trim();
      await mutate("putOutletCredential", slug, credentialId, body);
      toast.success(
        rotate || reused
          ? `Rotated “${credentialId}”`
          : `Saved “${credentialId}”`,
        { description: "Its value is never shown again." },
      );
      onClose();
    } catch (err) {
      setFailure(err);
      if (err instanceof HttpError && err.fields?.length) {
        setErrors(
          Object.fromEntries(
            err.fields.map((f) => [
              f === "value" ? (spec.fields[0]?.key ?? f) : f,
              describe(err).description ?? "Check this value.",
            ]),
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    if (rotate || reused) setConfirmRotate(true);
    else void send();
  };

  const copy = failure ? describe(failure) : null;
  const title = rotate ? `Rotate “${rotate.id}”` : "Set a channel credential";

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      dismissible={!busy}
      size="lg"
      title={title}
      description="Values are sent once and never shown again."
    >
      <form
        noValidate
        onSubmit={submit}
        className="flex min-h-0 flex-1 flex-col"
        aria-label={title}
      >
        <DrawerBody className="space-y-4">
          <FormField<string | null>
            name="kind"
            label="Kind"
            required
            value={kind}
            onChange={(v) => setKind(v as OutletCredentialKind | null)}
            error={errors.kind}
            announceError
            disabled={Boolean(rotate)}
          >
            {(field) => (
              <Select
                {...field}
                ref={undefined}
                placeholder="Choose a kind"
                options={kinds.map((k) => ({
                  value: k.value,
                  label: k.label,
                  description: k.description,
                }))}
              />
            )}
          </FormField>
          {spec ? (
            <>
              {!rotate ? (
                <FormField<string>
                  name="id"
                  label="Credential ID"
                  required
                  help="Lowercase, e.g. asc-team-key."
                  value={id}
                  onChange={setId}
                  error={errors.id}
                  announceError
                >
                  {(field) => (
                    <Input
                      id={field.id}
                      value={id}
                      mono
                      autoComplete="off"
                      spellCheck={false}
                      onValueChange={setId}
                      aria-describedby={field["aria-describedby"]}
                      aria-invalid={field["aria-invalid"]}
                      aria-required
                    />
                  )}
                </FormField>
              ) : null}
              {reused ? (
                <Callout
                  tone="warning"
                  title="A credential with this id exists"
                >
                  Saving rotates it: the new value replaces “{reused.id}” (
                  {kindLabel(reused.kind)}).
                </Callout>
              ) : null}
              {channelScoped ? null : (
                <FormField<string | null>
                  name="outlet"
                  label="Channel"
                  help="Bind it to one channel, or leave Any to let the connector choose."
                  value={outletId}
                  onChange={setOutletId}
                >
                  {(field) => (
                    <Select
                      {...field}
                      ref={undefined}
                      allowEmpty
                      emptyLabel="Any"
                      options={(outlets.data?.outlets ?? [])
                        .filter((o) => o.removedAt === null)
                        .map((o) => ({ value: o.outletId, label: o.outletId }))}
                    />
                  )}
                </FormField>
              )}
              {spec.generate ? (
                <Checkbox
                  checked={generate}
                  onCheckedChange={setGenerate}
                  label="Generate the secret"
                  description="The Worker creates a random secret and keeps it; Webhook setup hands it to Apple. Recommended."
                />
              ) : null}
              {!generating
                ? spec.fields.map((f) => (
                    <FormField<string>
                      key={f.key}
                      name={f.key}
                      label={f.label}
                      required
                      help={f.help}
                      value={values[f.key] ?? ""}
                      onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                      error={errors[f.key]}
                      announceError
                    >
                      {(field) =>
                        f.multiline ? (
                          <Textarea
                            id={field.id}
                            value={values[f.key] ?? ""}
                            mono
                            rows={5}
                            autoComplete="off"
                            spellCheck={false}
                            onValueChange={(v) =>
                              setValues((s) => ({ ...s, [f.key]: v }))
                            }
                            aria-describedby={field["aria-describedby"]}
                            aria-invalid={field["aria-invalid"]}
                            aria-required
                          />
                        ) : f.secret ? (
                          <SecretInput
                            id={field.id}
                            value={values[f.key] ?? ""}
                            onChange={(v) =>
                              setValues((s) => ({ ...s, [f.key]: v }))
                            }
                            aria-describedby={field["aria-describedby"]}
                            aria-invalid={field["aria-invalid"]}
                            aria-required
                          />
                        ) : (
                          <Input
                            id={field.id}
                            value={values[f.key] ?? ""}
                            mono
                            autoComplete="off"
                            spellCheck={false}
                            onValueChange={(v) =>
                              setValues((s) => ({ ...s, [f.key]: v }))
                            }
                            aria-describedby={field["aria-describedby"]}
                            aria-invalid={field["aria-invalid"]}
                            aria-required
                          />
                        )
                      }
                    </FormField>
                  ))
                : null}
              {spec.pin ? (
                <FormField<string>
                  name="pin"
                  label={spec.pin.label}
                  required={!rotate}
                  help={
                    rotate
                      ? `${spec.pin.help} Leave blank to keep the current pin.`
                      : spec.pin.help
                  }
                  value={pin}
                  onChange={setPin}
                  error={errors.pin}
                  announceError
                >
                  {(field) => (
                    <Input
                      id={field.id}
                      value={pin}
                      mono
                      inputMode={spec.pin!.inputMode}
                      autoComplete="off"
                      spellCheck={false}
                      onValueChange={setPin}
                      aria-describedby={field["aria-describedby"]}
                      aria-invalid={field["aria-invalid"]}
                      aria-required={!rotate || undefined}
                    />
                  )}
                </FormField>
              ) : null}
            </>
          ) : null}
          {copy ? (
            <Callout tone="danger" title={copy.title} live>
              {copy.description}
            </Callout>
          ) : null}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            {rotate || reused ? "Rotate credential…" : "Set credential"}
          </Button>
        </DrawerFooter>
      </form>
      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        intent="caution"
        title={`Rotate “${rotate?.id ?? id.trim()}”?`}
        consequences={[
          "The new value replaces the stored one at once; the old one cannot be recovered.",
          "Connectors use the new value from their next call.",
        ]}
        confirmLabel="Rotate credential"
        describeError={describe}
        onConfirm={async () => {
          await send();
        }}
      />
    </Drawer>
  );
}

export function PinDialog({
  slug,
  cred,
  data,
  onClose,
}: {
  slug: string;
  cred: OutletCredentialInfo;
  data: OutletCredentialsResponse | undefined;
  onClose: () => void;
}): React.ReactElement {
  const field = pinField(data, cred.kind);
  const spec = KIND.get(cred.kind)?.pin;
  const [value, setValue] = React.useState(
    field ? (cred.meta[field] ?? "") : "",
  );
  const [error, setError] = React.useState<string | undefined>();
  const [failure, setFailure] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const label = spec?.label ?? data?.pins?.[cred.kind]?.label ?? "App id";
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!value.trim()) {
      setError(`Enter the ${label}.`);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await mutate("putOutletCredential", slug, cred.id, {
        kind: cred.kind as OutletCredentialKind,
        pin: value.trim(),
      });
      toast.success(`Pinned “${cred.id}” to ${value.trim()}`);
      onClose();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };
  const copy = failure ? describe(failure) : null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      dismissible={!busy}
      title={`Pin “${cred.id}” to an app`}
      description="The connector reads and acts on this app only, and stays off while .pkey/distribution names another. Check that this is the product's app: store release controls cannot be undone. The change is audited."
    >
      <form
        noValidate
        onSubmit={(e) => void submit(e)}
        aria-label="Pin credential"
      >
        <DialogBody className="space-y-3">
          <FormField<string>
            name="pin"
            label={label}
            required
            value={value}
            onChange={(v) => {
              setValue(v);
              setError(undefined);
            }}
            error={error}
            announceError
          >
            {(f) => (
              <Input
                id={f.id}
                value={value}
                mono
                inputMode={spec?.inputMode ?? "text"}
                autoComplete="off"
                spellCheck={false}
                onValueChange={(v) => {
                  setValue(v);
                  setError(undefined);
                }}
                aria-describedby={f["aria-describedby"]}
                aria-invalid={f["aria-invalid"]}
                aria-required
              />
            )}
          </FormField>
          {copy ? (
            <Callout tone="danger" title={copy.title} live>
              {copy.description}
            </Callout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Pin
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
