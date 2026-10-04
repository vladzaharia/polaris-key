import { BarList } from "../../ui/charts/BarList.js";
import { Funnel } from "../../ui/charts/Funnel.js";
import { Meter } from "../../ui/charts/Meter.js";
import { Sparkline } from "../../ui/charts/Sparkline.js";
import { StatTile } from "../../ui/charts/StatTile.js";
import type { Story } from "../types.js";

export const stories: Story[] = [
  {
    id: "stat-tiles",
    group: "Charts",
    title: "StatTile",
    description:
      "A KPI row (T1): value, delta, sparkline, a linked label; one tile loading and one failed, independently.",
    render: () => (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Active licenses"
          value="1,284"
          href="#/__kit"
          delta={{ value: "+12", tone: "success", label: "vs last week" }}
          sparkline={[1180, 1202, 1210, 1234, 1251, 1266, 1284]}
        />
        <StatTile
          label="Expiring within 14 days"
          value="3"
          secondary="Next: Lab 3 on 7 Oct"
        />
        <StatTile label="Devices seen today" loading />
        <StatTile label="Rollouts halted" error onRetry={() => undefined} />
      </div>
    ),
  },
  {
    id: "sparkline",
    group: "Charts",
    title: "Sparkline",
    description:
      "Decorative 80×24 trend; the number beside it carries the meaning.",
    render: () => (
      <p className="flex items-center gap-3 text-sm text-fg">
        <Sparkline values={[3, 5, 4, 8, 7, 11, 13]} />
        2,931 devices seen in the last 7 days
      </p>
    ),
  },
  {
    id: "meters",
    group: "Charts",
    title: "Meter",
    description:
      "Seats, rollout progress (basis points), storage, and an over-full seat count.",
    render: () => (
      <div className="grid max-w-md gap-4">
        <Meter label="Seats" value={3} max={5} />
        <Meter label="Rollout" value={2500} max={10000} format="bp" />
        <Meter
          label="Storage"
          value={1_200_000_000}
          max={5_000_000_000}
          format="bytes"
        />
        <Meter label="Seats (grandfathered)" value={3} max={1} tone="warning" />
        <Meter label="Seats" value={0} max={5} />
      </div>
    ),
  },
  {
    id: "funnel",
    group: "Charts",
    title: "Funnel",
    description:
      "Offered → downloaded → applied → confirmed with step conversion; failures as danger bars; an empty window.",
    render: () => (
      <div className="grid gap-6 lg:grid-cols-2">
        <Funnel
          label="2.4.0 on stable, last 24 h"
          steps={[
            { label: "Offered", value: 1200 },
            { label: "Downloaded", value: 960 },
            { label: "Applied", value: 900 },
            { label: "Confirmed", value: 870 },
          ]}
          failures={[
            { label: "Reverted", value: 12 },
            { label: "Pack failed", value: 4 },
            { label: "Boot rollback", value: 1 },
          ]}
        />
        <Funnel
          label="2.4.0-rc.2 on beta, last 1 h"
          steps={[
            { label: "Offered", value: 0 },
            { label: "Downloaded", value: 0 },
          ]}
        />
      </div>
    ),
  },
  {
    id: "bar-list",
    group: "Charts",
    title: "BarList",
    description:
      "Labelled bars, largest first, with linked labels and a share format.",
    render: () => (
      <div className="grid gap-6 lg:grid-cols-2">
        <BarList
          label="Devices by platform"
          items={[
            { label: "macOS", value: 1420, href: "#/__kit" },
            { label: "Windows", value: 1103, href: "#/__kit" },
            { label: "Linux", value: 312 },
            { label: "iOS", value: 96 },
          ]}
        />
        <BarList
          label="App versions"
          format="share"
          limit={3}
          items={[
            { label: "2.4.0", value: 1600 },
            { label: "2.3.9", value: 900 },
            { label: "2.3.8", value: 250 },
            { label: "2.2.0", value: 120 },
            { label: "Older", value: 61 },
          ]}
        />
        <BarList label="SDKs" items={[]} />
      </div>
    ),
  },
];
