import * as React from "react";
import { Plus } from "lucide-react";
import { ApiError } from "../../api.js";
import { Button } from "../../ui/Button.js";
import { Callout } from "../../ui/Callout.js";
import { EmptyState } from "../../ui/EmptyState.js";
import { ErrorState } from "../../ui/ErrorState.js";
import { RefetchBar } from "../../ui/loading.js";
import { PageSkeleton } from "../../ui/Skeleton.js";
import { toast } from "../../ui/toast.js";
import type { Story } from "../types.js";

function ToastButtons(): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-3">
      <Button
        variant="outline"
        onClick={() =>
          toast.success("Tier saved", {
            description: "Pro now allows 3 seats.",
          })
        }
      >
        Success
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.info("Sync queued", {
            description: "The repository is read in the background.",
          })
        }
      >
        Info
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.warning("Rollout paused", {
            action: { label: "Resume", onClick: () => undefined },
          })
        }
      >
        Warning with an action
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.error(new ApiError(404), { context: { thing: "Tier" } })
        }
      >
        Error (stays until dismissed)
      </Button>
    </div>
  );
}

function RefetchDemo(): React.ReactElement {
  const [active, setActive] = React.useState(false);
  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-lg border border-border bg-surface-raised p-4">
        <p className="text-sm text-fg">Licenses (1,284)</p>
        <RefetchBar active={active} className="absolute inset-x-0 bottom-0" />
      </div>
      <Button
        variant="outline"
        aria-pressed={active}
        onClick={() => setActive((v) => !v)}
      >
        Background refetch
      </Button>
    </div>
  );
}

const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-lg border border-border bg-surface-raised">
    {children}
  </div>
);

export const stories: Story[] = [
  {
    id: "toasts",
    group: "Feedback",
    title: "Toasts (sonner)",
    description:
      "Success and info leave after 4 s, warnings after 8 s; errors stay until dismissed and read through errorCopy.",
    render: () => <ToastButtons />,
  },
  {
    id: "callouts",
    group: "Feedback",
    title: "Callout",
    description:
      "Inline, persistent context in five tones, with an optional action.",
    render: () => (
      <div className="space-y-3">
        <Callout tone="info" title="Profiles inherit the catalog">
          A profile overrides only the keys it names.
        </Callout>
        <Callout tone="success" title="Repository connected">
          Releases publish from <code>main</code>.
        </Callout>
        <Callout
          tone="warning"
          title="Two keys expire this month"
          action={
            <Button size="sm" variant="outline">
              Rotate…
            </Button>
          }
        >
          Rotate them before 31 October so signed documents keep verifying.
        </Callout>
        <Callout tone="danger" title="Repository sync failed">
          The webhook secret no longer matches.
        </Callout>
        <Callout tone="signed" title="Signed by the release key">
          Every manifest in this release verifies against rk-2026-09.
        </Callout>
      </div>
    ),
  },
  {
    id: "empty-states",
    group: "Feedback",
    title: "EmptyState",
    description:
      "First run (the stationary star), no results with the active filters, a service that is off, not found.",
    render: () => (
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <EmptyState
            kind="first-run"
            title="No licenses yet"
            description="Issue a license to let a customer activate the product."
            primaryAction={<Button iconStart={<Plus />}>New license</Button>}
            docs="https://docs.polaris-key.dev/admin/licenses-and-devices"
          />
        </Card>
        <Card>
          <EmptyState
            kind="no-results"
            title="No licenses match"
            filters="status: expired · tier: Pro"
            onClearFilters={() => undefined}
          />
        </Card>
        <Card>
          <EmptyState
            kind="service-off"
            service="config"
            title="Config is off for this product"
            description="Enable it to publish a catalog and profiles."
            primaryAction={<Button>Enable Config</Button>}
          />
        </Card>
        <Card>
          <EmptyState
            kind="not-found"
            title="Release 2.4.0 was not found"
            description="It may have been deleted, or the link belongs to another product."
          />
        </Card>
      </div>
    ),
  },
  {
    id: "error-states",
    group: "Feedback",
    title: "ErrorState",
    description:
      "A failed load, worded by errorCopy, with the next step. Compact inside a card or table.",
    render: () => (
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <ErrorState
            error={new TypeError("Failed to fetch")}
            onRetry={() => undefined}
          />
        </Card>
        <Card>
          <ErrorState
            error={new ApiError(404)}
            context={{ thing: "License", collectionHref: "#/__kit" }}
          />
        </Card>
        <div className="lg:col-span-2">
          <Card>
            <ErrorState
              compact
              error={new ApiError(503)}
              onRetry={() => undefined}
            />
          </Card>
        </div>
      </div>
    ),
  },
  {
    id: "page-skeletons",
    group: "Feedback",
    title: "PageSkeleton",
    description:
      "One skeleton per template, announced through the live region ('Loading licenses…').",
    render: () => (
      <div className="grid gap-6 lg:grid-cols-2">
        <PageSkeleton template="table" label="licenses" />
        <PageSkeleton template="dashboard" label="the overview" />
        <PageSkeleton template="record" label="the license" />
        <PageSkeleton template="form" label="settings" />
      </div>
    ),
  },
  {
    id: "refetch-bar",
    group: "Feedback",
    title: "RefetchBar",
    description:
      "A background refetch shows a 2 px line after 400 ms, so a fast one never flickers.",
    render: () => <RefetchDemo />,
  },
];
