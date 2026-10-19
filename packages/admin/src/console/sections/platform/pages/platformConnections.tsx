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
import { Plus } from "lucide-react";
import {
  api,
  type PlatformConnection,
  type PlatformConnectionsPage,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
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

const SETUP: Record<
  "google" | "apple" | "steam",
  { steps: string[]; env: string }
> = {
  google: {
    env: "SIGNIN_GOOGLE_CLIENT_ID, SIGNIN_GOOGLE_CLIENT_SECRET",
    steps: [
      "In Google Cloud, create an OAuth client of type Web application.",
      "Add the redirect URI shown below as an authorized redirect.",
      "Set SIGNIN_GOOGLE_CLIENT_ID, then seal the secret and set SIGNIN_GOOGLE_CLIENT_SECRET.",
    ],
  },
  apple: {
    env: "SIGNIN_APPLE_SERVICES_ID, SIGNIN_APPLE_TEAM_ID, SIGNIN_APPLE_KEY_ID, SIGNIN_APPLE_PRIVATE_KEY",
    steps: [
      "In your Apple Developer account, create a Services ID and a Sign in with Apple key.",
      "Add the redirect URI shown below to the Services ID.",
      "Set the Services ID, Team ID and Key ID, then seal the .p8 and set SIGNIN_APPLE_PRIVATE_KEY.",
    ],
  },
  steam: {
    env: "SIGNIN_STEAM_WEB_API_KEY",
    steps: [
      "Request a Steam Web API key for your domain.",
      "Seal it and set SIGNIN_STEAM_WEB_API_KEY.",
    ],
  },
};

export function connectionStatus(c: PlatformConnection): {
  tone: "success" | "neutral" | "warning";
  label: string;
} {
  if (c.status === "disabled") return { tone: "neutral", label: "Off" };
  if (c.lastError) return { tone: "warning", label: "Needs attention" };
  return { tone: "success", label: "On" };
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
                docs="/docs/operate/platform/connections/"
              />
            ) : (
              <ul className="divide-y divide-border">
                {d.connections.map((c) => {
                  const s = connectionStatus(c);
                  const verified = c.domains.filter((x) => x.verified).length;
                  return (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
                    >
                      <div className="min-w-0">
                        <Link
                          to={r.platformConnection(c.id)}
                          className="font-medium text-accent-fg underline-offset-4 hover:underline"
                        >
                          {c.label}
                        </Link>
                        <p className="break-all text-xs text-fg-muted">
                          {hostOf(c.issuer)} ·{" "}
                          {c.domains.length === 0
                            ? "No domains"
                            : `${verified} of ${c.domains.length} domains verified`}
                        </p>
                      </div>
                      <StatusPill tone={s.tone} size="sm">
                        {s.label}
                      </StatusPill>
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
                      <StatusPill
                        tone={b.configured ? "success" : "neutral"}
                        size="sm"
                      >
                        {b.configured ? "On" : "Not set up"}
                      </StatusPill>
                    </div>
                    {b.configured ? null : (
                      <details className="text-sm text-fg">
                        <summary className="cursor-pointer text-accent-fg">
                          Set up {b.label}
                        </summary>
                        <ol className="mt-2 list-decimal space-y-1 pl-5">
                          {SETUP[b.kind].steps.map((s) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ol>
                        <p className="mt-2 break-words text-xs text-fg-muted">
                          Worker values: {SETUP[b.kind].env}
                        </p>
                        <div className="mt-2 flex items-center gap-2">
                          <code className="min-w-0 break-all text-xs">
                            {d.redirectUri}
                          </code>
                          <CopyButton
                            value={d.redirectUri}
                            label="redirect URI"
                          />
                        </div>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Email" description="Codes and links for sign-in.">
            {d ? (
              <div className="flex items-center justify-between gap-3">
                <span>Delivery</span>
                <StatusPill
                  tone={d.email.configured ? "success" : "warning"}
                  size="sm"
                >
                  {d.email.configured ? "On" : "Not set up"}
                </StatusPill>
              </div>
            ) : (
              <Skeleton className="h-6 w-full" />
            )}
          </Section>

          <Section
            title="Turnstile"
            description="Bot check on the sign-in card."
          >
            {d ? (
              <div className="flex items-center justify-between gap-3">
                <span>Check</span>
                <StatusPill
                  tone={d.turnstile.enabled ? "success" : "neutral"}
                  size="sm"
                >
                  {d.turnstile.enabled ? "On" : "Off"}
                </StatusPill>
              </div>
            ) : (
              <Skeleton className="h-6 w-full" />
            )}
          </Section>
        </>
      )}
    </div>
  );
}
