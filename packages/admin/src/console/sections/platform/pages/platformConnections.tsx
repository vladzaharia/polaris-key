/**
 * Platform → Connections (I-31): the platform's sign-in plumbing on one page, grouped by kind.
 *
 *   Single sign-on   the OpenID Connect providers an operator adds (`identity_connections`),
 *                    with an add wizard (./platformConnectionWizard.tsx) and a page per
 *                    connection: domains with the TXT record and a live check, enforcement,
 *                    the claim mapping, on/off and delete.
 *   Sign-in providers  Google, Apple and Steam: status and the steps to set each up.
 *   Email, Turnstile   status only; their settings stay where they are.
 *
 * A client secret is never in a response, so none is on this page: it says "Sealed". Every change
 * is a step-up write; the page shows the same callout the other step-up flows do. Session
 * lengths are deploy-time values and not shown here; method strength is ST-28's fixed rule. The
 * Stores group joins this page with P0-28.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import {
  api,
  type PlatformConnection,
  type PlatformConnectionsPage,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { RegisterAddresses } from "./RegisterAddresses.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Section } from "../../../../ui/Section.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { useWriteGate } from "../../../access/useCan.js";
import { qk } from "../../../data/queries.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { AddConnectionPage } from "./platformConnectionWizard.js";
import { ConnectionPage } from "./platformConnectionPage.js";

export function fetchPlatformConnections(): Promise<PlatformConnectionsPage> {
  return api.platformConnections();
}

export const hostOf = (issuer: string): string => {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
};

/** The route's record: the list, `new` (the wizard), or one connection. */
export function ConnectionsRoute({ id }: { id?: string }): React.ReactElement {
  if (id === "new") return <AddConnectionPage />;
  if (id) return <ConnectionPage id={id} />;
  return <ConnectionsPage />;
}

// ── the list ─────────────────────────────────────────────────────────────────────────────────

/** One column template for the header and every row, in rem so it follows the text size. */
const COLS = "sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_6rem_7rem]";
const SEAL = "pnpm --filter @polaris-key/worker signin:seal";
const SETUP: Record<
  "google" | "apple" | "steam",
  { steps: string[]; env: string }
> = {
  google: {
    env: "SIGNIN_GOOGLE_CLIENT_ID, SIGNIN_GOOGLE_CLIENT_SECRET",
    steps: [
      "In Google Cloud, create an OAuth client of type Web application.",
      "Add the redirect URI below as an authorized redirect.",
      `Set SIGNIN_GOOGLE_CLIENT_ID. Seal the secret with ${SEAL} google, then set SIGNIN_GOOGLE_CLIENT_SECRET to the output.`,
    ],
  },
  apple: {
    env: "SIGNIN_APPLE_SERVICES_ID, SIGNIN_APPLE_TEAM_ID, SIGNIN_APPLE_KEY_ID, SIGNIN_APPLE_PRIVATE_KEY",
    steps: [
      "In your Apple Developer account, create a Services ID and a Sign in with Apple key.",
      "Add the redirect URI below to the Services ID.",
      `Set the Services ID, Team ID and Key ID. Seal the .p8 with ${SEAL} apple, then set SIGNIN_APPLE_PRIVATE_KEY to the output.`,
    ],
  },
  steam: {
    env: "SIGNIN_STEAM_WEB_API_KEY",
    steps: [
      "Request a Steam Web API key for your domain.",
      "Steam takes no redirect URI. It checks the realm below against the domain you gave.",
      `Seal the key with ${SEAL} steam, then set SIGNIN_STEAM_WEB_API_KEY to the output.`,
    ],
  },
};
const RUNBOOK = "/docs/operate/platform/runbook/set-up-the-login-card/";

/** A healthy connection says nothing; Off and a failure get a pill. */
export function connectionStatus(c: PlatformConnection): {
  tone: "success" | "neutral" | "warning";
  label: string;
  pill: boolean;
} {
  if (c.status === "disabled")
    return { tone: "neutral", label: "Off", pill: true };
  if (c.lastError)
    return { tone: "warning", label: "Needs attention", pill: true };
  return { tone: "success", label: "On", pill: false };
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-sm text-fg">{label}</span>
      {children}
    </div>
  );
}

export function ConnectionsPage(): React.ReactElement {
  const q = useQuery({
    queryKey: qk.platformConnections(),
    queryFn: fetchPlatformConnections,
  });
  const gate = useWriteGate("platform");
  const d = q.data;
  const add = (
    <Button
      asChild
      disabledReason={gate.allowed ? undefined : gate.disabledReason}
    >
      <Link to={r.platformConnectionNew()}>
        <Plus aria-hidden />
        Add connection
      </Link>
    </Button>
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Connections"
        description="How people sign in to your apps."
        freshness={
          q.dataUpdatedAt
            ? {
                updatedAt: q.dataUpdatedAt,
                onRefresh: () => void q.refetch(),
                refreshing: q.isFetching,
              }
            : undefined
        }
        primaryAction={d && d.connections.length > 0 ? add : undefined}
      />
      {q.isError && !d ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <Section
            title="Single sign-on"
            description="OpenID Connect providers, such as Entra ID, Okta or Keycloak."
          >
            {!d ? (
              <Skeleton className="h-16 w-full" />
            ) : d.connections.length === 0 ? (
              <EmptyState
                kind="first-run"
                variant="inline"
                title="No connections yet"
                description="Add your identity provider to let a company's people sign in with it."
                primaryAction={add}
                docs="/docs/operate/platform/sign-in-connections/"
              />
            ) : (
              <ul className="divide-y divide-border">
                <li
                  aria-hidden
                  className={`hidden gap-x-4 pb-2 text-xs text-fg-muted sm:grid ${COLS}`}
                >
                  <span>Connection</span>
                  <span>Domains</span>
                  <span>Routing</span>
                  <span className="text-right">Status</span>
                </li>
                {d.connections.map((c) => {
                  const s = connectionStatus(c);
                  const verified = c.domains.filter((x) => x.verified);
                  return (
                    <li key={c.id}>
                      <Link
                        to={r.platformConnection(c.id)}
                        className={`grid items-center gap-x-4 gap-y-1 py-3 hover:bg-hover ${COLS}`}
                      >
                        <span className="min-w-0">
                          <span className="font-medium text-accent-fg">
                            {c.label}
                          </span>
                          <span className="block break-all text-xs text-fg-muted">
                            {hostOf(c.issuer)}
                          </span>
                        </span>
                        <span className="flex min-w-0 flex-wrap gap-1 text-xs">
                          {c.domains.length === 0 ? (
                            <span className="text-fg-muted">No domains</span>
                          ) : (
                            c.domains.map((x) => (
                              <span
                                key={x.domain}
                                className="max-w-full break-all rounded-md bg-surface-sunken px-1.5 py-0.5 text-fg"
                              >
                                {x.domain}
                                {x.verified ? "" : " (not verified)"}
                              </span>
                            ))
                          )}
                        </span>
                        <span className="text-xs text-fg-muted">
                          {verified.length > 0
                            ? `${verified.length} routed`
                            : "Button only"}
                        </span>
                        <span className="flex items-center justify-end gap-2">
                          {s.pill ? (
                            <StatusPill tone={s.tone} size="sm">
                              {s.label}
                            </StatusPill>
                          ) : null}
                          <ChevronRight
                            aria-hidden
                            className="size-4 text-fg-subtle"
                          />
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section
            title="Sign-in providers"
            description="Google, Apple and Steam on the sign-in card."
          >
            {!d ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <ul className="divide-y divide-border">
                {d.builtIns.map((b) => (
                  <li key={b.kind} className="space-y-2 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-fg-strong">
                        {b.label}
                      </span>
                      {b.configured ? (
                        <span className="text-sm text-fg-muted">Set up</span>
                      ) : (
                        <StatusPill tone="neutral" size="sm">
                          Not set up
                        </StatusPill>
                      )}
                    </div>
                    {b.configured ? null : (
                      <details className="text-sm text-fg">
                        <summary className="inline-flex min-h-6 cursor-pointer items-center text-accent-fg">
                          Set up {b.label}
                        </summary>
                        <ol className="mt-2 list-decimal space-y-1 pl-5">
                          {SETUP[b.kind].steps.map((s) => (
                            <li key={s} className="break-words">
                              {s}
                            </li>
                          ))}
                        </ol>
                        <p className="mt-2 break-words text-xs text-fg-muted">
                          Worker values: {SETUP[b.kind].env}
                        </p>
                        <div className="mt-2">
                          <RegisterAddresses
                            title={
                              b.registration.kind === "realm"
                                ? "Realm"
                                : "Redirect URI"
                            }
                            copyLabel={
                              b.registration.kind === "realm"
                                ? "Copy realm"
                                : "Copy redirect URI"
                            }
                            addresses={b.registrations ?? [b.registration]}
                          />
                        </div>
                        <p className="mt-2 text-xs">
                          <a
                            href={RUNBOOK}
                            className="text-accent-fg underline-offset-4 hover:underline"
                          >
                            Set up the login card: the full runbook
                          </a>
                        </p>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <div className="grid gap-6 md:grid-cols-2">
            <Section title="Email" description="Codes and links for sign-in.">
              {d ? (
                <Row label="Delivery">
                  {d.email.configured ? (
                    <span className="text-sm text-fg-muted">Set up</span>
                  ) : (
                    <StatusPill tone="warning" size="sm">
                      Not set up
                    </StatusPill>
                  )}
                </Row>
              ) : (
                <Skeleton className="h-6 w-full" />
              )}
              {d && !d.email.configured ? (
                <p className="text-xs">
                  <a
                    href="/docs/operate/platform/runbook/set-up-sign-in-email/"
                    className="text-accent-fg underline-offset-4 hover:underline"
                  >
                    Set up sign-in email
                  </a>
                </p>
              ) : null}
            </Section>
            <Section
              title="Turnstile"
              description="Bot check on the sign-in card."
            >
              {d ? (
                <Row label="Check">
                  <span className="text-sm text-fg-muted">
                    {d.turnstile.enabled ? "On" : "Off"}
                  </span>
                </Row>
              ) : (
                <Skeleton className="h-6 w-full" />
              )}
            </Section>
          </div>
        </>
      )}
    </div>
  );
}
