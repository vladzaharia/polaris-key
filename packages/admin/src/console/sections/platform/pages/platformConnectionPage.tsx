/**
 * Platform → Connections → one connection (I-31): the provider, its client (redirect URI, test
 * sign-in), its domains, on/off and delete. Every change is a step-up write. A refused change in
 * a dialog keeps the dialog and says why inside it; the page-level toggle shows its error beside it.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type ConnectionDomain } from "../../../../api.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { RegisterAddresses } from "./RegisterAddresses.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
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
import { Link, useSearchParam } from "../../../router.js";
import { r } from "../../../routes.js";
import { StepUpCallout, useStepUp } from "../../core/pages/UserRelink.js";
import { failureOf } from "./connectionErrors.js";
import { DomainsSection } from "./platformConnectionDomains.js";
import { EditDialog } from "./platformConnectionEdit.js";
import {
  TestResultView,
  newDraftId,
  textCodec,
} from "./platformConnectionParts.js";
import {
  connectionStatus,
  fetchPlatformConnections,
  hostOf,
} from "./platformConnections.js";
import { useConnectionTest } from "./useConnectionTest.js";

export function ConnectionPage({ id }: { id: string }): React.ReactElement {
  const q = useQuery({
    queryKey: qk.platformConnection(id),
    queryFn: () => api.platformConnection(id).then((x) => x.connection),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const page = useQuery({
    queryKey: qk.platformConnections(),
    queryFn: fetchPlatformConnections,
  });
  const gate = useWriteGate("platform");
  const { fresh, markStale } = useStepUp(true);
  const [add] = useSearchParam("add", textCodec);
  const c = q.data;
  const [confirm, setConfirm] = React.useState<
    null | "delete" | { enforce: ConnectionDomain }
  >(null);
  const [editing, setEditing] = React.useState(false);
  const [toggleError, setToggleError] = React.useState<unknown>(null);
  const [toggling, setToggling] = React.useState(false);
  const draftId = React.useRef(newDraftId());
  const t = useConnectionTest({
    draftId: draftId.current,
    issuer: "",
    clientId: "",
    secret: "",
    claimMap: {},
    connectionId: id,
    returned: "",
    onTestStep: false,
  });
  const testBtn = React.useRef<HTMLButtonElement>(null);
  const outcome = React.useRef<HTMLDivElement>(null);
  // A test that came back: the result takes focus (hooks stay above every early return).
  React.useEffect(() => {
    if (t.test) outcome.current?.focus();
  }, [t.test]);
  // A failed or closed test sends focus back to the button that starts it.
  React.useEffect(() => {
    if (t.error) window.setTimeout(() => testBtn.current?.focus(), 0);
  }, [t.error]);

  /**
   * One write, then a refresh. A stale step-up shows the sign-in callout and still throws, so
   * whoever asked (a dialog, a row) keeps its place and shows the words.
   */
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") markStale();
      throw e;
    }
    await Promise.all([q.refetch(), page.refetch()]);
  };

  if (q.isError && !c) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return missing ? (
      <div className="space-y-6">
        <PageHeader
          eyebrow={
            <Breadcrumbs
              items={[
                { label: "Connections", to: r.platformConnections() },
                { label: "Not found" },
              ]}
            />
          }
          title="Connection not found"
          description="It may have been deleted, or the address is wrong."
          primaryAction={
            <Button asChild>
              <Link to={r.platformConnections()}>Back to Connections</Link>
            </Button>
          }
        />
      </div>
    ) : (
      <ErrorState error={q.error} onRetry={() => void q.refetch()} />
    );
  }
  const writeReason = !gate.allowed
    ? gate.disabledReason
    : !fresh
      ? "Sign in again to continue"
      : undefined;
  const status = c ? connectionStatus(c) : null;
  const deleteReason = c
    ? c.source === "env"
      ? "The seeded connection can only be turned off."
      : c.links > 0
        ? `${c.links} ${c.links === 1 ? "person signs" : "people sign"} in through it. Turn it off instead.`
        : undefined
    : undefined;
  const redirectUri = page.data?.redirectUri;
  const testFailure = failureOf(t.error);

  const test = (
    <div className="space-y-3">
      <Button
        ref={testBtn}
        variant="outline"
        size="sm"
        loading={t.testing}
        disabledReason={gate.allowed ? undefined : gate.disabledReason}
        onClick={() => void t.run("popup")}
      >
        Test sign-in
      </Button>
      <div ref={outcome} tabIndex={-1} className="space-y-3 outline-none">
        {testFailure ? (
          <Callout tone="danger" title={testFailure.title} live>
            {testFailure.description}
          </Callout>
        ) : null}
        {t.test ? <TestResultView result={t.test} /> : null}
      </div>
    </div>
  );

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
          status && status.pill ? (
            <StatusPill tone={status.tone} size="sm">
              {status.label}
            </StatusPill>
          ) : undefined
        }
        description={c ? hostOf(c.issuer) : undefined}
        meta={
          c?.source === "env" ? (
            <StatusPill tone="neutral" size="sm">
              Seeded from the environment
            </StatusPill>
          ) : undefined
        }
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
          {c.lastError ? (
            <Callout
              tone="warning"
              title="The last sign-in failed"
              action={
                <Button
                  size="sm"
                  variant="outline"
                  loading={t.testing}
                  disabledReason={
                    gate.allowed ? undefined : gate.disabledReason
                  }
                  onClick={() => void t.run("popup")}
                >
                  Test sign-in
                </Button>
              }
            >
              <span className="break-words">{c.lastError}</span>
            </Callout>
          ) : null}
          <div className="@container">
            <div className="grid gap-6 @4xl:grid-cols-[minmax(0,1fr)_min(22rem,35%)]">
              <div className="min-w-0 space-y-6">
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
                    columns={2}
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
                        ) : c.lastError ? (
                          "Never succeeded"
                        ) : (
                          "None yet"
                        ),
                      },
                      { term: "People", detail: String(c.links) },
                    ]}
                  />
                </Section>
                <DomainsSection
                  c={c}
                  writeReason={writeReason}
                  act={act}
                  focusAdd={add === "domain"}
                  onEnforce={(d) => setConfirm({ enforce: d })}
                />
              </div>
              <div className="min-w-0 space-y-6">
                <Section title="Sign-in card">
                  <Switch
                    checked={c.status === "active"}
                    label="Show on the sign-in card"
                    description="Off hides the button. People already signed in stay signed in."
                    disabled={toggling || Boolean(writeReason)}
                    onCheckedChange={(on) => {
                      setToggling(true);
                      setToggleError(null);
                      act(() =>
                        mutate("updatePlatformConnection", c.id, {
                          status: on ? "active" : "disabled",
                        }),
                      )
                        .then(() =>
                          toast.success(
                            on
                              ? "Shown on the sign-in card"
                              : "Hidden from the sign-in card",
                          ),
                        )
                        .catch(setToggleError)
                        .finally(() => setToggling(false));
                    }}
                  />
                  {toggleError ? (
                    <p role="alert" className="mt-2 text-sm text-danger">
                      {failureOf(toggleError)?.title}.{" "}
                      {failureOf(toggleError)?.description}
                    </p>
                  ) : null}
                </Section>
                <Section title="Register at the provider">
                  {redirectUri ? (
                    <RegisterAddresses
                      inline
                      title="Redirect URI"
                      copyLabel="Copy redirect URI"
                      addresses={
                        page.data?.redirectUris ?? [{ value: redirectUri }]
                      }
                    />
                  ) : null}
                  <div className="mt-4">{test}</div>
                </Section>
                <Section title="Delete">
                  <p className="text-sm text-fg-muted">
                    {deleteReason ?? "Removes the connection and its domains."}
                  </p>
                  <div className="mt-3">
                    <Button
                      variant="outline"
                      disabledReason={writeReason ?? deleteReason}
                      onClick={() => setConfirm("delete")}
                    >
                      Delete connection…
                    </Button>
                  </div>
                </Section>
              </div>
            </div>
          </div>

          <ConfirmDialog
            open={confirm === "delete"}
            onOpenChange={(o) => !o && setConfirm(null)}
            intent="danger"
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
            describeError={(e) => failureOf(e)!}
            onConfirm={async () => {
              await act(() => mutate("deletePlatformConnection", c.id));
              window.location.hash = r.platformConnections();
            }}
          />
          <ConfirmDialog
            open={typeof confirm === "object" && confirm !== null}
            onOpenChange={(o) => !o && setConfirm(null)}
            intent="caution"
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
                    "If the provider is down, those people cannot sign in until you stop requiring it.",
                  ]
                : ["Addresses at this domain can use email codes again."]
            }
            confirmLabel={
              typeof confirm === "object" && confirm?.enforce.enforce
                ? "Stop requiring"
                : "Require"
            }
            describeError={(e) => failureOf(e)!}
            onConfirm={async () => {
              if (typeof confirm !== "object" || !confirm) return;
              const d = confirm.enforce;
              await act(() =>
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
            act={act}
          />
        </>
      )}
    </div>
  );
}
