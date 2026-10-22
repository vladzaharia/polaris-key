/**
 * Keys & secrets → Device trust (ST-12; S-18 §2.2, §4.15 item 8). The product's device trust
 * policy: which operations need an attested device, whether a miss is refused or only logged,
 * and the App Attest and Play Integrity anchors.
 *
 * The policy is security-critical, so its write path is guarded (the Worker checks every step):
 *
 * - Tightening it (L1) asks once and names what changes.
 * - Relaxing it (L2: fewer attested operations, log-only, another anchor, or a reset) names the
 *   consequence, asks for a reason, has the key typed, and needs a sign-in from the last five
 *   minutes. Without one the dialog says so and offers the sign-in; nothing is saved.
 * - Every write carries the version it read. A policy changed since you opened it says so, keeps
 *   your edits, and offers Reload.
 * - A view-only member sees the policy and a locked editor (`WriteLock`, set by the hub).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import {
  ApiError,
  api,
  type TrustPolicyDto,
  type TrustPolicyResponse,
} from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../../ui/Drawer.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { Select } from "../../../../ui/Select.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { SourceBadge } from "../../../../ui/SourceBadge.js";
import { Switch } from "../../../../ui/Switch.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { toast } from "../../../../ui/toast.js";
import { announce } from "../../../../ui/LiveRegion.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import {
  DEFAULT_POLICY,
  TRUST_OPERATIONS,
  TRUST_POLICY_KEY,
  changeLines,
  isDefaultPolicy,
  policyProblems,
  relaxesTrustPolicy,
  samePolicy,
} from "../model/trustPolicy.js";

const LEVELS = [
  { value: "basic", label: "Any device" },
  { value: "attested", label: "Attested device" },
] as const;

const ENVIRONMENTS = [
  { value: "production", label: "Production" },
  { value: "development", label: "Development" },
] as const;

export function fetchTrustPolicy(slug: string): Promise<TrustPolicyResponse> {
  return api.trustPolicy(slug);
}

export function isConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.reason === undefined || error.reason === "version_conflict")
  );
}

function needsStepUp(error: unknown): boolean {
  return error instanceof ApiError && error.code === "step_up_required";
}

function describeError(error: unknown): {
  title: string;
  description?: string;
} {
  if (needsStepUp(error))
    return {
      title: "Sign in again to confirm it's you",
      description:
        "Relaxing the policy needs a sign-in from the last 5 minutes. Nothing was saved.",
    };
  return errorCopy(error, { thing: "Device trust policy" });
}

export function TrustPolicySection({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const query = useQuery({
    queryKey: qk.trustPolicy(slug),
    queryFn: () => fetchTrustPolicy(slug),
  });
  const [editing, setEditing] = React.useState(false);
  return (
    <SettingsSection id="keys-trust" title="Device trust">
      <SettingsRow
        label="Device trust policy"
        align="block"
        chip={<code className="font-mono text-xs">{TRUST_POLICY_KEY}</code>}
        help="Which operations need a device that proved a genuine store install. Relaxing it lets unattested clients through."
        source={
          query.data ? <SourceBadge source={query.data.source} /> : undefined
        }
        aside={
          query.data ? (
            <Button
              variant="outline"
              size="sm"
              iconStart={<Pencil aria-hidden />}
              onClick={() => setEditing(true)}
            >
              Edit…
            </Button>
          ) : undefined
        }
      >
        {query.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : query.isError ? (
          <ErrorState
            compact
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <>
            <PolicySummary policy={query.data.policy} />
            <PolicyDrawer
              slug={slug}
              open={editing}
              current={query.data}
              onClose={() => setEditing(false)}
              reload={async () => {
                await query.refetch();
              }}
            />
          </>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

function PolicySummary({
  policy,
}: {
  policy: TrustPolicyDto;
}): React.ReactElement {
  const level = (l: string) =>
    l === "attested" ? "Attested device" : "Any device";
  return (
    <DescriptionList
      columns={3}
      items={[
        ...TRUST_OPERATIONS.map((op) => ({
          term: op.label,
          detail: level(policy[op.id]),
        })),
        {
          term: "A miss",
          detail: policy.enforce ? "Refused" : "Logged, let through",
        },
        {
          term: "App Attest",
          detail: policy.appAttest
            ? `${policy.appAttest.teamId ?? "Platform Team ID"}, ${policy.appAttest.environment}`
            : "Off",
        },
        {
          term: "Play Integrity",
          detail: policy.playIntegrity
            ? `${policy.playIntegrity.cloudProjectNumber ?? "Platform project"}${policy.playIntegrity.allowTestingResponses ? ", testing responses allowed" : ""}`
            : "Off",
        },
      ]}
    />
  );
}

type Pending =
  | { kind: "save"; next: TrustPolicyDto }
  | { kind: "reset"; next: TrustPolicyDto };

function PolicyDrawer({
  slug,
  open,
  current,
  onClose,
  reload,
}: {
  slug: string;
  open: boolean;
  current: TrustPolicyResponse;
  onClose: () => void;
  reload: () => Promise<void>;
}): React.ReactElement {
  const stored = current.policy;
  const version = current.version ?? 0;
  const [draft, setDraft] = React.useState<TrustPolicyDto>(stored);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [reason, setReason] = React.useState("");
  const [conflict, setConflict] = React.useState<null | "refused" | "reloaded">(
    null,
  );
  const [reloading, setReloading] = React.useState(false);

  // A fresh open starts from what is stored; a reload after a conflict keeps the edits.
  React.useEffect(() => {
    if (open) {
      setDraft(stored);
      setConflict(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dirty = !samePolicy(draft, stored);
  const problems = policyProblems(draft);
  const invalid = Object.keys(problems).length > 0;
  const set = (patch: Partial<TrustPolicyDto>) =>
    setDraft((d) => ({ ...d, ...patch }));

  const target = pending?.next ?? draft;
  const relax = pending ? relaxesTrustPolicy(stored, target) : false;
  const lines = pending ? changeLines(stored, target) : [];

  const run = async (): Promise<void> => {
    if (!pending) return;
    const guard = {
      expectedVersion: version,
      ...(relax ? { reason: reason.trim(), confirm: TRUST_POLICY_KEY } : {}),
    };
    try {
      if (pending.kind === "reset")
        await mutate("resetTrustPolicy", slug, guard);
      else
        await mutate("putTrustPolicy", slug, {
          policy: pending.next,
          ...guard,
        });
    } catch (e) {
      if (isConflict(e)) {
        setPending(null);
        setConflict("refused");
        announce(
          "The device trust policy changed since you opened it. Nothing was saved.",
        );
        return;
      }
      throw e;
    }
    setPending(null);
    setReason("");
    setConflict(null);
    toast.success(
      pending.kind === "reset"
        ? "Device trust policy reset"
        : "Device trust policy saved",
    );
    onClose();
  };

  const verb = relax ? "Relax" : "Tighten";
  return (
    <>
      <Drawer
        open={open}
        onOpenChange={(o) => {
          if (!o && !pending) onClose();
        }}
        unsaved={dirty}
        title="Device trust policy"
        description="Saved changes apply to the next request from each device."
      >
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && !invalid) setPending({ kind: "save", next: draft });
          }}
        >
          <DrawerBody className="space-y-5">
            {conflict ? (
              <Callout
                tone={conflict === "refused" ? "warning" : "info"}
                live
                title={
                  conflict === "refused"
                    ? "This policy changed since you opened it"
                    : "Reloaded"
                }
                action={
                  conflict === "refused" ? (
                    <Button
                      type="button"
                      size="sm"
                      loading={reloading}
                      onClick={() => {
                        setReloading(true);
                        void reload()
                          .then(() => setConflict("reloaded"))
                          .finally(() => setReloading(false));
                      }}
                    >
                      Reload
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConflict(null)}
                    >
                      Dismiss
                    </Button>
                  )
                }
              >
                {conflict === "refused"
                  ? "Someone saved it first, so nothing was changed. Reload to read the current policy; your edits stay in the form."
                  : "The policy above is the current one. Save again to apply your edits, or Cancel to drop them."}
              </Callout>
            ) : null}

            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold text-fg-strong">
                Needs
              </legend>
              {TRUST_OPERATIONS.map((op) => (
                <FormField
                  key={op.id}
                  name={op.id}
                  label={op.label}
                  value={draft[op.id]}
                  onChange={(v: string) =>
                    set({ [op.id]: v as "basic" | "attested" })
                  }
                >
                  {(f) => (
                    <Select
                      {...f}
                      options={LEVELS}
                      value={draft[op.id]}
                      onChange={(v) =>
                        set({ [op.id]: (v ?? "basic") as "basic" | "attested" })
                      }
                    />
                  )}
                </FormField>
              ))}
              <Switch
                label="Refuse a device that falls short"
                description="Off: a miss is logged in activity and the request goes through."
                checked={draft.enforce}
                onCheckedChange={(c) => set({ enforce: c })}
              />
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold text-fg-strong">
                App Attest
              </legend>
              <Switch
                label="Check App Attest"
                checked={draft.appAttest !== null}
                onCheckedChange={(c) =>
                  set({
                    appAttest: c
                      ? { teamId: null, environment: "production" }
                      : null,
                  })
                }
              />
              {draft.appAttest ? (
                <>
                  <FormField
                    name="teamId"
                    label="Apple Team ID"
                    help="Blank uses the platform's Team ID."
                    value={draft.appAttest.teamId ?? ""}
                    error={problems.teamId}
                    onChange={(v: string) =>
                      set({
                        appAttest: {
                          ...draft.appAttest!,
                          teamId: v.trim() === "" ? null : v.trim(),
                        },
                      })
                    }
                  >
                    {(f) => <Input {...f} mono />}
                  </FormField>
                  <FormField
                    name="environment"
                    label="Environment"
                    value={draft.appAttest.environment}
                    onChange={() => undefined}
                  >
                    {(f) => (
                      <Select
                        {...f}
                        options={ENVIRONMENTS}
                        value={draft.appAttest!.environment}
                        onChange={(v) =>
                          set({
                            appAttest: {
                              ...draft.appAttest!,
                              environment: (v ?? "production") as
                                | "production"
                                | "development",
                            },
                          })
                        }
                      />
                    )}
                  </FormField>
                </>
              ) : null}
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold text-fg-strong">
                Play Integrity
              </legend>
              <Switch
                label="Check Play Integrity"
                checked={draft.playIntegrity !== null}
                onCheckedChange={(c) =>
                  set({
                    playIntegrity: c ? { cloudProjectNumber: null } : null,
                  })
                }
              />
              {draft.playIntegrity ? (
                <>
                  <FormField
                    name="cloudProjectNumber"
                    label="Cloud project number"
                    help="Blank uses the platform's project."
                    value={draft.playIntegrity.cloudProjectNumber ?? ""}
                    error={problems.cloudProjectNumber}
                    onChange={(v: string) =>
                      set({
                        playIntegrity: {
                          ...draft.playIntegrity!,
                          cloudProjectNumber: v.trim() === "" ? null : v.trim(),
                        },
                      })
                    }
                  >
                    {(f) => <Input {...f} mono inputMode="numeric" />}
                  </FormField>
                  <Switch
                    label="Accept testing responses"
                    description="For internal testing only: a license tester's configured response passes."
                    checked={draft.playIntegrity.allowTestingResponses === true}
                    onCheckedChange={(c) => {
                      const { allowTestingResponses: _drop, ...rest } =
                        draft.playIntegrity!;
                      set({
                        playIntegrity: c
                          ? { ...rest, allowTestingResponses: true }
                          : rest,
                      });
                    }}
                  />
                </>
              ) : null}
            </fieldset>
          </DrawerBody>
          <DrawerFooter>
            <Button
              type="button"
              variant="ghost"
              className="me-auto"
              disabled={isDefaultPolicy(stored)}
              onClick={() =>
                setPending({ kind: "reset", next: DEFAULT_POLICY })
              }
            >
              Reset to default…
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!dirty || invalid}>
              Review changes…
            </Button>
          </DrawerFooter>
        </form>
      </Drawer>
      {pending ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setPending(null);
              setReason("");
            }
          }}
          intent={relax ? "danger" : "caution"}
          title={
            pending.kind === "reset"
              ? "Reset the device trust policy?"
              : `${verb} the device trust policy?`
          }
          lead={
            relax
              ? "Devices need to prove less than they do now. Unattested clients can enrol and fetch."
              : "Devices need to prove more than they do now."
          }
          consequences={lines}
          confirmLabel={
            pending.kind === "reset"
              ? "Reset policy"
              : relax
                ? "Relax policy"
                : "Tighten policy"
          }
          confirmDisabled={relax && reason.trim() === ""}
          typedConfirmation={
            relax
              ? {
                  value: TRUST_POLICY_KEY,
                  label: `Type ${TRUST_POLICY_KEY} to confirm`,
                }
              : undefined
          }
          describeError={describeError}
          onConfirm={run}
        >
          {relax ? (
            <div className="space-y-1 text-sm">
              <label className="block space-y-1">
                <span className="font-medium text-fg-strong">Reason</span>
                <Textarea
                  value={reason}
                  onValueChange={setReason}
                  maxLength={500}
                  rows={2}
                  placeholder="Why this changes"
                />
              </label>
              <p className="text-xs text-fg-muted">
                Required. Kept in the activity log.
              </p>
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </>
  );
}
