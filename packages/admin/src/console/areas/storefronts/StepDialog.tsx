/**
 * The confirmation of one storefront step (A-18j; ADMIN.md §5.2, S-15 §6.4). The step's request
 * comes from the server's plan: its route, fixed body, the fields the operator fills, its verb and
 * consequences, and its confirmation level.
 *
 * - `plain`: a neutral confirm that lists what the store receives.
 * - `typed` (submit, release, a price change): the operator types the app's name as the store
 *   reports it; the Worker compares it with the store's own name before anything is sent, and the
 *   confirm button stays disabled until something is typed.
 *
 * One `Idempotency-Key` per opened dialog: a retry after a timeout replays what the ledger already
 * did instead of writing twice. The dialog stays open on a refusal and shows it inline.
 */

import * as React from "react";
import type { StorefrontStepRequest } from "../../../api.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { FormField } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { Select } from "../../../ui/Select.js";
import { toast } from "../../../ui/toast.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { mutate } from "../../data/mutations.js";
import { newIdempotencyKey } from "./data.js";

export interface StepIntent {
  request: StorefrontStepRequest;
  /** The store's name, for the typed field's help ("as Google Play shows it"). */
  storeLabel: string;
  /** The success toast. */
  done: string;
}

export function StepDialog({
  slug,
  intent,
  onClose,
  onDone,
}: {
  slug: string;
  intent: StepIntent | null;
  onClose: () => void;
  onDone?: (result: Record<string, unknown>) => void;
}): React.ReactElement | null {
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [appName, setAppName] = React.useState("");
  const key = React.useMemo(
    () => (intent ? newIdempotencyKey() : ""),
    [intent],
  );
  React.useEffect(() => {
    setAppName("");
    setValues(
      Object.fromEntries(
        (intent?.request.fields ?? []).map((f) => [f.name, f.value]),
      ),
    );
  }, [intent]);
  if (!intent) return null;
  const { request } = intent;
  const typed = request.confirm === "typed";
  const missing = request.fields.some(
    (f) => f.required && (values[f.name] ?? "").trim() === "",
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      intent={typed ? "danger" : "neutral"}
      title={`${request.verb}?`}
      consequences={request.consequences}
      confirmLabel={request.verb}
      confirmDisabled={missing || (typed && appName.trim() === "")}
      describeError={(e) =>
        errorCopy(e, { area: "distribution", thing: "Step" })
      }
      onConfirm={async () => {
        const body: Record<string, unknown> = { ...request.body };
        const input: Record<string, string> = {};
        for (const f of request.fields) {
          const v = (values[f.name] ?? "").trim();
          if (v !== "" || f.required) input[f.name] = v;
        }
        // The flow's own step route reads `input`; a reviewed route takes its fields as the body.
        const ownStep = /\/distribution\/storefronts\/[^/]+\/steps\//.test(
          request.path,
        );
        const sent = ownStep ? { ...body, input } : { ...body, ...input };
        const result = await mutate(
          "storefrontRequest",
          slug,
          request.path,
          request.method,
          typed ? { ...sent, confirm: appName.trim() } : sent,
          { idempotencyKey: key },
        );
        toast.success(intent.done);
        onDone?.(result);
        onClose();
      }}
    >
      {request.fields.map((f) =>
        f.options ? (
          <FormField<string>
            key={f.name}
            name={`step-${f.name}`}
            label={f.label}
            help={f.help}
            required={f.required}
            value={values[f.name] ?? ""}
            onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))}
          >
            {(field) => (
              <Select
                id={field.id}
                options={f.options!}
                value={values[f.name] ?? ""}
                onChange={(v) =>
                  setValues((s) => ({ ...s, [f.name]: v ?? "" }))
                }
                aria-describedby={field["aria-describedby"]}
              />
            )}
          </FormField>
        ) : (
          <FormField<string>
            key={f.name}
            name={`step-${f.name}`}
            label={f.label}
            help={f.help}
            required={f.required}
            value={values[f.name] ?? ""}
            onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))}
          >
            {(field) => (
              <Input
                id={field.id}
                value={values[f.name] ?? ""}
                maxLength={f.maxLength}
                autoComplete="off"
                spellCheck={false}
                onValueChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))}
                aria-describedby={field["aria-describedby"]}
              />
            )}
          </FormField>
        ),
      )}
      {typed ? (
        <FormField<string>
          name="storefront-app-name"
          label="App name"
          required
          help={`Type the app's name exactly as ${intent.storeLabel} shows it. Polaris Key checks it against ${intent.storeLabel} before sending anything.`}
          value={appName}
          onChange={setAppName}
        >
          {(field) => (
            <Input
              id={field.id}
              value={appName}
              autoComplete="off"
              spellCheck={false}
              onValueChange={setAppName}
              aria-describedby={field["aria-describedby"]}
            />
          )}
        </FormField>
      ) : null}
    </ConfirmDialog>
  );
}
