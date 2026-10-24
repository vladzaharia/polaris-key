/**
 * Mint one admin API token, then show it once (`#/tokens`).
 *
 * ── WHERE THE MINTED SECRET LIVES, AND WHY IT CANNOT LEAK INTO THE ROSTER ───────────────────
 *
 * The plaintext rides exactly one response, the mint's, and nothing stored server-side can
 * reproduce it. "Shown once" is therefore a fact about this component tree, enforced by shape:
 *
 *  1. The page holds `minting: boolean` and nothing else about the mint: the secret has no state
 *     slot there to be written into.
 *  2. This flow is mounted ONLY while the operator is minting. Closing it unmounts the component
 *     that owns `secret`, so React drops it: there is no reset-on-open path where a stale value
 *     could survive, and navigating away unmounts it too.
 *  3. The roster is refetched from the server after the mint (`mutate` invalidates it). The mint
 *     response's `token` is discarded, never spliced into the list, and `AdminApiToken` has no
 *     secret field for a list to carry one.
 *
 * `expiresInDays` has no default in this form, mirroring the worker's refusal to invent one: a
 * lifetime the operator did not choose is the failure the mandatory field exists to prevent.
 * The mint also needs a sign-in from the last five minutes (a step-up): the console checks it
 * from `/me` before the form and the worker checks it again (403 `step_up_required`).
 */

import * as React from "react";
import {
  ADMIN_API_SCOPES,
  HttpError,
  MAX_TOKEN_DAYS,
  type AdminApiScope,
} from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { Dialog, DialogBody, DialogFooter } from "../../../../ui/Dialog.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { NumberInput } from "../../../../ui/NumberInput.js";
import { OneTimeSecretDialog } from "../../../../ui/OneTimeSecretPanel.js";
import { mutate } from "../../../data/mutations.js";
import { r } from "../../../routes.js";
import { StepUpCallout, useStepUp } from "../../core/pages/UserRelink.js";

const LABEL_MAX = 200;

/** What each scope lets the token do, beside its id. */
const SCOPE_TEXT: Record<AdminApiScope, string> = {
  "bundles:mint": "Mint offline bundles",
  "migrations:report": "Dry-run and read data migrations",
};

/** The message for a field name the worker returned in a 422's `fields`. */
const FIELD_MESSAGES: Record<string, string> = {
  label: `Give the token a name of up to ${LABEL_MAX} characters.`,
  expiresInDays: `Use a whole number of days from 1 to ${MAX_TOKEN_DAYS}.`,
  scopes: "Choose at least one scope.",
};

export function MintApiTokenFlow({
  onClose,
}: {
  onClose: () => void;
}): React.ReactElement {
  const { fresh, markStale } = useStepUp(true);
  const [label, setLabel] = React.useState("");
  const [days, setDays] = React.useState<number | null>(null);
  const [scopes, setScopes] = React.useState<AdminApiScope[]>(["bundles:mint"]);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);
  const [serverFields, setServerFields] = React.useState<
    Record<string, string>
  >({});

  const labelBlank = label.trim() === "";
  const labelBad = !labelBlank && label.trim().length > LABEL_MAX;
  const daysBad =
    days !== null &&
    (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS);
  const invalid =
    labelBlank || labelBad || days === null || daysBad || scopes.length === 0;
  const clearField = (name: string): void =>
    setServerFields(({ [name]: _gone, ...rest }) => rest);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving || invalid || !fresh) return;
    setSaving(true);
    setFailure(null);
    setServerFields({});
    try {
      // Only `secret` is kept, and only here. The response's `token` view is deliberately
      // dropped: the roster reloads from the server instead.
      const res = await mutate("mintApiToken", {
        label: label.trim(),
        scopes,
        expiresInDays: days!,
      });
      setSecret(res.secret);
    } catch (err) {
      if (err instanceof HttpError && err.code === "step_up_required")
        markStale();
      else if (err instanceof HttpError && err.fields?.length)
        setServerFields(
          Object.fromEntries(
            err.fields.map((f) => [
              f,
              FIELD_MESSAGES[f] ?? "Check this value.",
            ]),
          ),
        );
      else setFailure(err);
    } finally {
      setSaving(false);
    }
  };

  if (secret !== null) {
    return (
      <OneTimeSecretDialog
        open
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
        title="API token created"
        description="Store it in your CI provider's secret store now."
        label="API token"
        value={secret}
        hint="Shown once. Polaris Key stores only its hash. Keep it out of the repository."
        onDone={onClose}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!saving && !o) onClose();
      }}
      dismissible={!saving}
      title="New API token"
      description="A credential for a build or CI job, sent as an Authorization header. It reaches only the scopes you choose."
    >
      <form onSubmit={submit} noValidate>
        <DialogBody className="space-y-4">
          {fresh ? null : (
            <StepUpCallout hash={r.apiTokens()}>
              Minting a token needs a sign-in from the last five minutes. You
              come back to this page afterwards.
            </StepUpCallout>
          )}
          <FormField
            name="label"
            label="Label"
            required
            help="What this token is for. Shown in the list."
            value={label}
            onChange={(v: string) => {
              setLabel(v);
              clearField("label");
            }}
            error={
              labelBad || (!labelBlank ? undefined : label !== "")
                ? FIELD_MESSAGES.label
                : serverFields.label
            }
          >
            {(f) => (
              <Input
                {...f}
                maxLength={LABEL_MAX}
                autoComplete="off"
                placeholder="CI bundle minter"
              />
            )}
          </FormField>
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-fg-strong">
              Scopes
            </legend>
            {ADMIN_API_SCOPES.map((s) => (
              <Checkbox
                key={s}
                label={SCOPE_TEXT[s]}
                description={s}
                checked={scopes.includes(s)}
                onCheckedChange={(on) => {
                  clearField("scopes");
                  setScopes(
                    on ? [...scopes, s].sort() : scopes.filter((x) => x !== s),
                  );
                }}
              />
            ))}
            {scopes.length === 0 || serverFields.scopes ? (
              <p className="text-xs text-danger">{FIELD_MESSAGES.scopes}</p>
            ) : null}
          </fieldset>
          <FormField
            name="expiresInDays"
            label="Expires after"
            className="w-44"
            required
            help={`1 to ${MAX_TOKEN_DAYS} days. There is no default: choose how long this credential should live.`}
            value={days}
            onChange={(v: number | null) => {
              setDays(v);
              clearField("expiresInDays");
            }}
            error={
              daysBad
                ? FIELD_MESSAGES.expiresInDays
                : serverFields.expiresInDays
            }
          >
            {(f) => (
              <NumberInput
                {...f}
                integer
                nullable
                min={1}
                max={MAX_TOKEN_DAYS}
                unit="days"
              />
            )}
          </FormField>
          {failure ? (
            <Callout tone="danger" title={errorCopy(failure).title}>
              {errorCopy(failure).description}
            </Callout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" loading={saving} disabled={invalid || !fresh}>
            Create token
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
