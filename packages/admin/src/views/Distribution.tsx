import * as React from "react";
import { AlertTriangle, Boxes, Truck } from "lucide-react";
import { api, type RolloutsResponse, type ServicesResponse } from "../api.js";
import { useResource } from "../context.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from "../components/ui/index.js";
import { qk } from "../console/data/queries.js";

/**
 * The Distribution section's overview — how releases reach devices and outlets.
 *
 * It shows what is TRUE today: whether the chain release ← distribution ← update is coherent for
 * this product, which hook each service offers or consumes, and (P2b-04) the outlet rollouts
 * recorded for it. The rollouts list is read-only here — the per-cell controls are on the Matrix
 * tab (P2b-06, `distribution/Matrix.tsx`) — and it carries the caveat the worker sends with it: until the signed feed (P3-03)
 * carries rollouts and halts, a halt is recorded and shown but the legacy feeds keep serving, so
 * today's emergency stop is a yank or a channel pin.
 */

type Enabled = ServicesResponse["services"];

interface HookRow {
  name: string;
  provider: "release" | "distribution";
  consumer: string;
  /** What the hook answers today, while its provider is on. */
  today: string;
}

const HOOKS: readonly HookRow[] = [
  {
    name: "releaseCatalog",
    provider: "release",
    consumer: "Distribution",
    today:
      "Deliverables, releases, builds, artifact records, channel policy and yanks; resolution and GitHub-held bytes for the byte routes.",
  },
  {
    name: "delivery",
    provider: "distribution",
    consumer: "Update",
    today:
      "Default transport pkey-cdn, delivery access, outlet rollouts, delivery URLs, availability and submissions per outlet (CI-reported, or derived for self-hosted outlets) and the signing-key inventory.",
  },
  {
    name: "outletCapabilities",
    provider: "distribution",
    consumer: "Update",
    today: "No outlets are declared yet, so every outlet answers nothing.",
  },
];

export function Distribution({ slug }: { slug: string }): React.ReactElement {
  const { data, loading, error, reload } = useResource(qk.services(slug), () =>
    api.services(slug),
  );

  return (
    <section aria-labelledby="distribution-title" className="space-y-6">
      <header className="space-y-1">
        <h2
          id="distribution-title"
          className="text-xl font-semibold tracking-tight"
        >
          Distribution
        </h2>
        <p className="text-sm text-muted-foreground">
          How <span className="font-medium text-foreground">{slug}</span>’s
          releases reach devices and outlets.
        </p>
      </header>

      {loading && !data ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      ) : error && !data ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load service state"
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={reload}>
              Retry
            </Button>
          }
        />
      ) : !data ? (
        <EmptyState icon={<Boxes aria-hidden />} title="No service state" />
      ) : (
        <>
          <ChainCard services={data.services} />
          <RolloutsCard slug={slug} />
          <HooksCard services={data.services} />
        </>
      )}
    </section>
  );
}

function OnOff({ on }: { on: boolean }): React.ReactElement {
  return (
    <Badge variant={on ? "success" : "outline"}>{on ? "on" : "off"}</Badge>
  );
}

function ChainCard({ services }: { services: Enabled }): React.ReactElement {
  const release = services.release?.enabled === true;
  const distribution = services.distribution?.enabled === true;
  const update = services.update?.enabled === true;
  const chain: { slug: string; label: string; on: boolean; role: string }[] = [
    { slug: "release", label: "Release", on: release, role: "what exists" },
    {
      slug: "distribution",
      label: "Distribution",
      on: distribution,
      role: "how it reaches devices and outlets",
    },
    {
      slug: "update",
      label: "Update",
      on: update,
      role: "what an installed copy does next",
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck aria-hidden className="size-4 text-accent-fg" />
          Enablement
        </CardTitle>
        <CardDescription>
          Release, then Distribution, then Update: each may only be on while the
          one before it is. Change them under Platform → Services.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-3 sm:grid-cols-3">
          {chain.map((step) => (
            <li
              key={step.slug}
              className="flex items-start justify-between gap-3 rounded-md border p-3"
            >
              <div>
                <p className="text-sm font-medium">{step.label}</p>
                <p className="text-xs text-muted-foreground">{step.role}</p>
              </div>
              <OnOff on={step.on} />
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-muted-foreground">
          Distribution serves every download — the installer, the direct
          downloads and the build, file and blob routes — by Polaris Key’s own
          CDN (<code>pkey-cdn</code>) unless an outlet names another transport.
          With Distribution off, none of them is served.
        </p>
      </CardContent>
    </Card>
  );
}

function HooksCard({ services }: { services: Enabled }): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Descriptor hooks</CardTitle>
        <CardDescription>
          Services read one another through Core, never by import. A hook
          answers only while the service that provides it is on.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Hook</th>
                <th className="py-2 pr-4 font-medium">Provided by</th>
                <th className="py-2 pr-4 font-medium">Read by</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 font-medium">Answers today</th>
              </tr>
            </thead>
            <tbody>
              {HOOKS.map((hook) => {
                const on = services[hook.provider]?.enabled === true;
                return (
                  <tr key={hook.name} className="border-t align-top">
                    <td className="py-2 pr-4 font-mono text-xs">{hook.name}</td>
                    <td className="py-2 pr-4 capitalize">{hook.provider}</td>
                    <td className="py-2 pr-4">{hook.consumer}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={on ? "success" : "outline"}>
                        {on ? "answering" : "null"}
                      </Badge>
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {on ? hook.today : "Nothing — its provider is off."}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

const STATE_VARIANT: Record<
  string,
  "success" | "outline" | "warning" | "destructive"
> = {
  active: "success",
  paused: "warning",
  halted: "destructive",
  complete: "outline",
};

/** The outlet rollouts recorded for this product (P2b-04), read-only, with today's caveat. */
function RolloutsCard({ slug }: { slug: string }): React.ReactElement {
  const { data, error } = useResource<RolloutsResponse>(qk.rollouts(slug), () =>
    api.rollouts(slug),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Rollouts</CardTitle>
        <CardDescription>
          Percentage, pause, halt and completion, per outlet and channel. Set
          from CI (<code>distribution:rollout</code>) or the admin API.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          role="note"
          className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
        >
          <AlertTriangle
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          <p className="text-muted-foreground">
            A halt is recorded and shown, but it does not stop devices yet: the
            legacy feeds keep serving until the signed feed carries rollouts. To
            stop a release reaching devices now, yank it or pin the channel
            under Releases.
          </p>
        </div>
        {error ? (
          <p className="text-sm text-muted-foreground">
            Couldn’t load rollouts: {error}
          </p>
        ) : !data ? (
          <Skeleton className="h-10 w-full" />
        ) : data.rollouts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No rollouts recorded: every outlet serves its channel’s release to
            everyone.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Deliverable</th>
                  <th className="py-2 pr-4 font-medium">Outlet</th>
                  <th className="py-2 pr-4 font-medium">Channel</th>
                  <th className="py-2 pr-4 font-medium">Release</th>
                  <th className="py-2 pr-4 font-medium">Rollout</th>
                  <th className="py-2 pr-4 font-medium">State</th>
                  <th className="py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {data.rollouts.map((r) => (
                  <tr
                    key={`${r.deliverableId}:${r.outletId}:${r.channel}`}
                    className="border-t"
                  >
                    <td className="py-2 pr-4 font-mono text-xs">
                      {r.deliverableId}
                    </td>
                    <td className="py-2 pr-4">{r.outletId}</td>
                    <td className="py-2 pr-4">{r.channel}</td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {r.releaseId}
                    </td>
                    <td className="py-2 pr-4">{r.rolloutBp / 100}%</td>
                    <td className="py-2 pr-4">
                      <Badge variant={STATE_VARIANT[r.state] ?? "outline"}>
                        {r.state}
                      </Badge>
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {r.mirrored ? `${r.source} (mirrored)` : r.source}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
