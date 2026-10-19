/**
 * Platform → Connections → one connection (I-31): the provider, its domains (TXT record, live
 * check, enforcement), the claim mapping, on/off and delete. Every change is a step-up write.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ConnectionDomain,
  type PlatformConnection,
} from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Section } from "../../../../ui/Section.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Switch } from "../../../../ui/Switch.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { toast } from "../../../../ui/toast.js";
import { useWriteGate } from "../../../access/useCan.js";
import { Breadcrumbs } from "../../../components/Breadcrumbs.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { r } from "../../../routes.js";
import { StepUpCallout, useStepUp } from "../../core/pages/UserRelink.js";
import { EditDialog } from "./platformConnectionEdit.js";
import {
  connectionStatus,
  fetchPlatformConnections,
  hostOf,
} from "./platformConnections.js";

// ── one connection ───────────────────────────────────────────────────────────────────────────

function fieldMessage(e: unknown): string | null {
  return e ? errorCopy(e, { thing: "The connection" }).description : null;
}

export function ConnectionPage({ id }: { id: string }): React.ReactElement {
  const q = useQuery({
    queryKey: qk.platformConnection(id),
    queryFn: () => api.platformConnection(id).then((x) => x.connection),
  });
  const page = useQuery({
    queryKey: qk.platformConnections(),
    queryFn: fetchPlatformConnections,
  });
  const gate = useWriteGate("platform");
  const { fresh, markStale } = useStepUp(true);
  const c = q.data;
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState<
    null | "delete" | { enforce: ConnectionDomain }
  >(null);
  const [editing, setEditing] = React.useState(false);

  /** Run one write: a stale step-up shows the callout, any other failure shows its words. */
  const run = async (
    fn: () => Promise<unknown>,
    done?: string,
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await Promise.all([q.refetch(), page.refetch()]);
      if (done) toast.success(done);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") markStale();
      else setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (q.isError && !c) {
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const writeReason = !gate.allowed
    ? gate.disabledReason
    : !fresh
      ? "Sign in again to continue"
      : undefined;
  const status = c ? connectionStatus(c) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Breadcrumbs
            items={[
              { label: "Connections", to: r.platformConnections() },
              { label: c?.label ?? "Connection" },
            ]}
          />
        }
        title={c?.label ?? "Connection"}
        titleAside={
          status ? (
            <StatusPill tone={status.tone} size="sm">
              {status.label}
            </StatusPill>
          ) : undefined
        }
        description={c ? hostOf(c.issuer) : undefined}
      />
      {!c ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {fresh ? null : (
            <StepUpCallout hash={r.platformConnection(c.id)}>
              Changing a connection needs a sign-in from the last five minutes.
              You come back to this page afterwards.
            </StepUpCallout>
          )}
          {error ? (
            <Callout
              tone="danger"
              title={errorCopy(error, { thing: "The connection" }).title}
              live
            >
              {fieldMessage(error)}
            </Callout>
          ) : null}
          {c.lastError ? (
            <Callout tone="warning" title="The last sign-in failed">
              <span className="break-words">{c.lastError}</span>
            </Callout>
          ) : null}

          <Section
            title="Provider"
            actions={
              <Button
                variant="outline"
                size="sm"
                disabledReason={writeReason}
                onClick={() => setEditing(true)}
              >
                Change
              </Button>
            }
          >
            <DescriptionList
              items={[
                {
                  term: "Issuer",
                  detail: <span className="break-all">{c.issuer}</span>,
                },
                {
                  term: "Client ID",
                  detail: <span className="break-all">{c.clientId}</span>,
                },
                {
                  term: "Client secret",
                  detail: c.hasSecret ? "Sealed" : "None",
                },
                {
                  term: "Who signs in",
                  detail:
                    c.audience === "customers"
                      ? "Customers"
                      : c.audience === "operators"
                        ? "Operators"
                        : "Customers and operators",
                },
                {
                  term: "Groups claim",
                  detail: c.claimMap.groups ?? "Not mapped",
                },
                {
                  term: "Other claims",
                  detail: c.claimMap.claims?.join(", ") ?? "None",
                },
                {
                  term: "Last sign-in",
                  detail: c.lastSuccessAt ? (
                    <Timestamp at={fromSeconds(c.lastSuccessAt)} />
                  ) : (
                    "None yet"
                  ),
                },
                { term: "People", detail: String(c.links) },
              ]}
            />
            <div className="mt-4">
              <Switch
                checked={c.status === "active"}
                label="On"
                description="Off hides it from the sign-in card. People already signed in stay signed in."
                disabled={busy || Boolean(writeReason)}
                onCheckedChange={(on) =>
                  void run(
                    () =>
                      mutate("updatePlatformConnection", c.id, {
                        status: on ? "active" : "disabled",
                      }),
                    on ? "Turned on" : "Turned off",
                  )
                }
              />
            </div>
          </Section>

          <DomainsSection
            c={c}
            busy={busy}
            writeReason={writeReason}
            run={run}
            onEnforce={(d) => setConfirm({ enforce: d })}
          />

          <Section title="Delete" tone="danger">
            <p className="text-sm text-fg-muted">
              {c.links > 0
                ? `${c.links} ${c.links === 1 ? "person signs" : "people sign"} in through it. Turn it off instead.`
                : "Removes the connection and its domains."}
            </p>
            <div className="mt-3">
              <Button
                variant="danger"
                disabledReason={
                  writeReason ??
                  (c.source === "env"
                    ? "The seeded connection can only be turned off."
                    : c.links > 0
                      ? "People sign in through it."
                      : undefined)
                }
                onClick={() => setConfirm("delete")}
              >
                Delete connection
              </Button>
            </div>
          </Section>

          <ConfirmDialog
            open={confirm === "delete"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title={`Delete ${c.label}?`}
            consequences={[
              "Its domains are released.",
              "It leaves the sign-in card.",
            ]}
            confirmLabel="Delete connection"
            typedConfirmation={{
              value: c.label,
              label: "Type the name to confirm",
            }}
            onConfirm={async () => {
              const ok = await run(() =>
                mutate("deletePlatformConnection", c.id),
              );
              if (ok) window.location.hash = r.platformConnections();
            }}
          />
          <ConfirmDialog
            open={typeof confirm === "object" && confirm !== null}
            onOpenChange={(o) => !o && setConfirm(null)}
            title={
              typeof confirm === "object" && confirm
                ? confirm.enforce.enforce
                  ? `Stop requiring ${c.label} for ${confirm.enforce.domain}?`
                  : `Require ${c.label} for ${confirm.enforce.domain}?`
                : ""
            }
            consequences={
              typeof confirm === "object" && confirm && !confirm.enforce.enforce
                ? [
                    `Addresses at ${confirm.enforce.domain} can no longer get an email code or magic link.`,
                    "Passkeys and links already on an account still sign in.",
                  ]
                : ["Addresses at this domain can use email codes again."]
            }
            confirmLabel={
              typeof confirm === "object" && confirm?.enforce.enforce
                ? "Stop requiring"
                : "Require"
            }
            onConfirm={async () => {
              if (typeof confirm !== "object" || !confirm) return;
              const d = confirm.enforce;
              await run(() =>
                mutate(
                  "setConnectionDomainEnforce",
                  c.id,
                  d.domain,
                  !d.enforce,
                ),
              );
            }}
          />
          <EditDialog
            c={c}
            open={editing}
            onClose={() => setEditing(false)}
            run={run}
          />
        </>
      )}
    </div>
  );
}

function DomainsSection({
  c,
  busy,
  writeReason,
  run,
  onEnforce,
}: {
  c: PlatformConnection;
  busy: boolean;
  writeReason: string | undefined;
  run: (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;
  onEnforce: (d: ConnectionDomain) => void;
}): React.ReactElement {
  const [domain, setDomain] = React.useState("");
  const [checked, setChecked] = React.useState<Record<string, string>>({});
  const verifiedOnly = c.domains.some((d) => d.verified);
  return (
    <Section
      title="Domains"
      description="Addresses at a verified domain sign in through this connection. Each domain, subdomains included, is its own entry."
    >
      {c.domains.length === 0 ? (
        <EmptyState
          kind="first-run"
          variant="inline"
          title="No domains"
          description="Add a domain, then publish the TXT record to prove you own it."
        />
      ) : (
        <ul className="divide-y divide-border">
          {c.domains.map((d) => (
            <li key={d.domain} className="space-y-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-fg-strong">{d.domain}</span>
                <StatusPill tone={d.verified ? "success" : "warning"} size="sm">
                  {d.verified ? "Verified" : "Not verified"}
                </StatusPill>
              </div>
              {d.verified ? null : (
                <div className="space-y-1 text-sm">
                  <p>Publish this TXT record, then check it.</p>
                  <RecordLine label="Name" value={d.record.name} />
                  <RecordLine label="Value" value={d.record.value} />
                  {checked[d.domain] ? (
                    <p role="status" className="text-fg-muted">
                      {checked[d.domain]}
                    </p>
                  ) : null}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {d.verified ? (
                  <Switch
                    checked={d.enforce}
                    label="Require this connection"
                    description="No email codes or magic links for this domain."
                    disabled={busy || Boolean(writeReason)}
                    onCheckedChange={() => onEnforce(d)}
                  />
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={busy}
                    disabledReason={writeReason}
                    onClick={() =>
                      void run(async () => {
                        const res = await mutate(
                          "verifyConnectionDomain",
                          c.id,
                          d.domain,
                        );
                        setChecked((s) => ({
                          ...s,
                          [d.domain]:
                            res.verify === "verified"
                              ? "Verified."
                              : res.verify === "taken"
                                ? "Another connection already owns this domain."
                                : res.verify === "error"
                                  ? "The DNS lookup failed. Try again."
                                  : "Record not found yet. DNS can take a while.",
                        }));
                      })
                    }
                  >
                    Check now
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabledReason={writeReason}
                  onClick={() =>
                    void run(
                      () => mutate("removeConnectionDomain", c.id, d.domain),
                      "Released",
                    )
                  }
                >
                  Release
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!domain.trim()) return;
          void run(() =>
            mutate("addConnectionDomain", c.id, domain.trim()),
          ).then((ok) => {
            if (ok) setDomain("");
          });
        }}
      >
        <FormField
          name="domain"
          label="Add a domain"
          className="min-w-[14rem] flex-1"
          value={domain}
          onChange={(v: string) => setDomain(v)}
        >
          {(f) => (
            <Input
              {...f}
              placeholder="example.com"
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </FormField>
        <Button
          type="submit"
          loading={busy}
          disabledReason={
            writeReason ?? (domain.trim() ? undefined : "Enter a domain")
          }
        >
          Add domain
        </Button>
      </form>
      {verifiedOnly ? null : (
        <p className="mt-3 text-xs text-fg-muted">
          Until a domain is verified, this connection only appears as a button.
        </p>
      )}
    </Section>
  );
}

function RecordLine({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-xs text-fg-muted">{label}</span>
      <code className="min-w-0 flex-1 break-all rounded-md bg-surface-sunken px-2 py-1 text-xs">
        {value}
      </code>
      <CopyButton value={value} label={label.toLowerCase()} />
    </div>
  );
}
