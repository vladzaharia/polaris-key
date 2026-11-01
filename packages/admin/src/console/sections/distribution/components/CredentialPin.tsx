/**
 * The pin dialog: the one store app a credential may act on, changed without its value (P5-02f).
 */

import * as React from "react";
import {
  type OutletCredentialInfo,
  type OutletCredentialKind,
  type OutletCredentialsResponse,
} from "../../../../api.js";
import { Dialog, DialogBody } from "../../../../ui/Dialog.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { KIND, describe, pinField } from "../model/credentialKinds.js";
import { FailureCallout, SubmitFooter, useSubmitState } from "./dialogParts.js";

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
  const { error, setError, failure, setFailure, busy, setBusy } =
    useSubmitState();
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
          <FailureCallout copy={copy} />
        </DialogBody>
        <SubmitFooter busy={busy} onClose={onClose}>
          Pin
        </SubmitFooter>
      </form>
    </Dialog>
  );
}
