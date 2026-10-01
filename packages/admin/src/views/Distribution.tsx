import * as React from "react";
import { AlertTriangle, Boxes, Truck } from "lucide-react";
import { api, type ServicesResponse } from "../api.js";
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

/**
 * The Distribution section's overview (P2b-01) — how releases reach devices and outlets.
 *
 * Distribution ships as a skeleton first: no outlets, no routes, and the Core descriptor hooks
 * that later packages fill (P2b-02 outlets, P2b-03 availability, P2b-04 rollouts and byte
 * serving). So this view shows what is TRUE today and nothing more: whether the chain
 * release ← distribution ← update is coherent for this product, and which hook each service
 * offers or consumes. It reads only the services projection the shell already loads — there is
 * no Distribution admin API yet, and drawing controls for state that does not exist would invite
 * an operator to configure nothing.
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
      "Deliverables, releases, builds, artifact records, channel policy and yanks.",
  },
  {
    name: "delivery",
    provider: "distribution",
    consumer: "Update",
    today: "Default transport pkey-cdn; no availability records yet.",
  },
  {
    name: "outletCapabilities",
    provider: "distribution",
    consumer: "Update",
    today: "No outlets are declared yet, so every outlet answers nothing.",
  },
];

export function Distribution({ slug }: { slug: string }): React.ReactElement {
  const { data, loading, error, reload } = useResource(`services:${slug}`, () =>
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
          <Truck aria-hidden className="size-4 text-primary" />
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
          Outlets, transports, availability and rollouts arrive with the
          distribution manifest. Until then every deliverable is delivered by
          Polaris Key’s own CDN (<code>pkey-cdn</code>).
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
