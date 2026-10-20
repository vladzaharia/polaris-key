/** The Add and Edit dialog for an alert destination (ST-27). */

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type AlertDestination,
  type AlertKindId,
  type AlertScope,
  ApiError,
} from "../../../api.js";
import { Button } from "../../../ui/Button.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { Dialog, DialogBody, DialogFooter } from "../../../ui/Dialog.js";
import { FormField } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { SegmentedControl } from "../../../ui/SegmentedControl.js";
import { toast } from "../../../ui/toast.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { SignInCallout } from "./SignInCallout.js";
import {
  LABEL_MAX,
  REASONS,
  failureText,
  isStepUp,
  nameOf,
  targetProblem,
  type Field,
  type KindInfo,
} from "./alertShared.js";

// ── Add and Edit ─────────────────────────────────────────────────────────────────────────────

export function DestinationDialog({
  scope,
  kinds,
  existing,
  currentVersion,
  fresh,
  returnHash,
  onStepUp,
  onClose,
  onSecret,
  onSaved,
}: {
  scope: AlertScope;
  kinds: readonly KindInfo[];
  existing: AlertDestination | null;
  /** The version the list holds now: it moves on when a save finds the row changed. */
  currentVersion?: number;
  fresh: boolean;
  returnHash: string;
  onStepUp: () => void;
  onClose: () => void;
  onSecret: (secret: string, d: AlertDestination) => void;
  onSaved: (id: string) => void;
}): React.ReactElement {
  const editing = existing !== null;
  const queryClient = useQueryClient();
  const ids = React.useRef<Partial<Record<Field, string>>>({});
  const [focusReq, setFocusReq] = React.useState<{
    field: Field;
    n: number;
  } | null>(null);
  const requestFocus = (field: Field): void =>
    setFocusReq((p) => ({ field, n: (p?.n ?? 0) + 1 }));
  React.useEffect(() => {
    if (!focusReq) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(ids.current[focusReq.field] ?? "");
      (focusReq.field === "alerts"
        ? el?.querySelector<HTMLElement>('[role="checkbox"]')
        : el
      )?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusReq]);
  const [kind, setKind] = React.useState<"email" | "webhook">(
    existing?.kind ?? "email",
  );
  // A webhook's URL is write-only: editing shows the origin and a button to replace it.
  const [replacing, setReplacing] = React.useState(
    !existing || existing.kind === "email",
  );
  const [target, setTarget] = React.useState(
    existing?.kind === "email" ? existing.target : "",
  );
  const [label, setLabel] = React.useState(existing?.label ?? "");
  const [alerts, setAlerts] = React.useState<AlertKindId[]>(
    existing?.alerts ??
      kinds
        .filter((k) => k.sent && k.id !== "notifications_failing")
        .map((k) => k.id),
  );
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<Partial<Record<Field, string>>>(
    {},
  );
  const [failure, setFailure] = React.useState<string | null>(null);
  const [wantsSignIn, setWantsSignIn] = React.useState(false);
  const setError = (f: Field, text: string | undefined): void =>
    setErrors((prev) => {
      const { [f]: _gone, ...rest } = prev;
      return text ? { ...rest, [f]: text } : rest;
    });

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving) return;
    const problems: Partial<Record<Field, string>> = {};
    if (replacing) {
      const t = targetProblem(kind, target);
      if (t) problems.target = t;
    }
    if (alerts.length === 0) problems.alerts = REASONS.alerts_required!.text;
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      requestFocus(problems.target ? "target" : "alerts");
      return;
    }
    if (!fresh) {
      setWantsSignIn(true);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      if (existing) {
        const res = await mutate("updateAlertDestination", scope, existing.id, {
          alerts,
          label: label.trim(),
          ...(replacing ? { target: target.trim() } : {}),
          expectedVersion: currentVersion ?? existing.version,
        });
        if (res.secret) onSecret(res.secret, res.destination);
        toast.success("Destination saved");
        onSaved(existing.id);
      } else {
        const res = await mutate("createAlertDestination", scope, {
          kind,
          target: target.trim(),
          alerts,
          ...(label.trim() ? { label: label.trim() } : {}),
        });
        toast.success("Destination added");
        if (res.secret) onSecret(res.secret, res.destination);
        onSaved(res.destination.id);
      }
      onClose();
    } catch (err) {
      if (isStepUp(err)) {
        onStepUp();
        setWantsSignIn(true);
      } else {
        const reason = err instanceof ApiError ? err.reason : undefined;
        const spec = reason ? REASONS[reason] : undefined;
        if (spec?.field) {
          setError(spec.field, spec.text);
          requestFocus(spec.field);
        } else if (reason === "stale") {
          // Load what it is now, keep the operator's edits, and say to look again.
          await queryClient.refetchQueries({
            queryKey: qk.alertDestinations(scope),
          });
          setFailure(
            "Changed elsewhere. Your edits are kept: review them and save again.",
          );
        } else setFailure(failureText(err));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!saving && !o) onClose();
      }}
      dismissible={!saving}
      title={existing ? `Edit ${nameOf(existing)}` : "Add alert destination"}
      description="Pick what to send and where."
    >
      <form onSubmit={submit} noValidate>
        <DialogBody className="space-y-4">
          {wantsSignIn && !fresh ? (
            <SignInCallout hash={returnHash}>
              Saving needs a sign-in from the last five minutes. You come back
              to this page afterwards.
            </SignInCallout>
          ) : null}
          {editing ? (
            <p className="text-sm">
              <span className="font-semibold text-fg-strong">Type</span>{" "}
              <span className="text-fg-muted">
                {kind === "email" ? "Email" : "Webhook"}
              </span>
            </p>
          ) : (
            <FormField
              name="kind"
              label="Type"
              group
              value={kind}
              onChange={() => undefined}
            >
              {(f) => (
                <SegmentedControl
                  aria-labelledby={f["aria-labelledby"]}
                  className="w-fit"
                  value={kind}
                  options={[
                    { value: "email", label: "Email" },
                    { value: "webhook", label: "Webhook" },
                  ]}
                  onChange={(v) => {
                    setKind(v);
                    setTarget("");
                    setError("target", undefined);
                  }}
                />
              )}
            </FormField>
          )}
          {replacing ? (
            <FormField
              name="target"
              label={kind === "email" ? "Email address" : "Webhook URL"}
              required
              help={
                kind === "webhook"
                  ? "A public https address. It is sealed once saved and never shown again."
                  : "Mail comes from the platform sender."
              }
              value={target}
              error={errors.target}
              onChange={(v: string) => {
                setTarget(v);
                setError("target", undefined);
              }}
            >
              {(f) => {
                ids.current.target = f.id;
                return (
                  <Input
                    {...f}
                    type={kind === "email" ? "email" : "url"}
                    autoComplete="off"
                    dir="ltr"
                    placeholder={
                      kind === "email"
                        ? "ops@example.com"
                        : "https://hooks.example.com/…"
                    }
                    onBlur={() => {
                      if (target.trim() !== "")
                        setError(
                          "target",
                          targetProblem(kind, target) ?? undefined,
                        );
                    }}
                  />
                );
              }}
            </FormField>
          ) : (
            <div className="space-y-1">
              <p className="text-sm font-semibold text-fg-strong">
                Webhook URL
              </p>
              <p className="text-sm text-fg-muted">
                {existing?.target}{" "}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setReplacing(true);
                    requestFocus("target");
                  }}
                >
                  Replace URL
                </Button>
              </p>
            </div>
          )}
          <FormField
            name="label"
            label="Label"
            optional
            value={label}
            error={errors.label}
            onChange={(v: string) => setLabel(v)}
          >
            {(f) => (
              <Input
                {...f}
                dir="auto"
                maxLength={LABEL_MAX}
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField
            name="alerts"
            label="Alerts"
            group
            value={alerts}
            error={errors.alerts}
            onChange={() => undefined}
          >
            {(f) => (
              <div
                id={f.id}
                ref={() => {
                  ids.current.alerts = f.id;
                }}
                role="group"
                aria-labelledby={f["aria-labelledby"]}
                aria-describedby={f["aria-describedby"]}
                className="space-y-2"
              >
                {kinds.map((k) => (
                  <Checkbox
                    key={k.id}
                    label={k.label}
                    description={
                      !k.sent
                        ? "Not sent yet"
                        : k.id === "notifications_failing"
                          ? "Tells your other destinations when one keeps failing"
                          : undefined
                    }
                    checked={alerts.includes(k.id)}
                    onCheckedChange={(on) => {
                      setError("alerts", undefined);
                      setAlerts(
                        on
                          ? [...alerts, k.id]
                          : alerts.filter((x) => x !== k.id),
                      );
                    }}
                  />
                ))}
              </div>
            )}
          </FormField>
          {failure ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {failure}
            </p>
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
          <Button type="submit" loading={saving}>
            {editing ? "Save" : "Add destination"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
