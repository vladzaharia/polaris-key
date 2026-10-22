/**
 * Overview's Integration steps (products.overview; concept C's stepper): one row per feature the
 * read model lists, in its order, joined by a rail. Each row is the step's mark, its name, at most
 * one line of state or next action and one badge per platform the product was seen on. Verified
 * is a tick and no sub-line; the first open console step is the current one (the ring in its own
 * accent, the row tinted) with its console step as one verb link; a feature waiting on the app
 * says so, and the first such row also offers the drop-in kit and the own-UI docs. Pure model
 * (`stepRows`) and the list.
 */

import * as React from "react";
import { ArrowRight, ArrowUpRight, Check, Clock } from "lucide-react";
import type { IntegrationFeatureId, IntegrationView } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import {
  FEATURE_LABEL,
  SDK_DOC_KEYS,
  defaultSdk,
  platformLabel,
  prerequisiteInfo,
  seenPlatforms,
} from "../model/integration.js";
import { PlatformBadge, type PlatformBadgeState } from "./PlatformBadge.js";

/** What a feature waiting on the app is waiting for ("Waiting for the first sign-in"). */
const FIRST: Record<IntegrationFeatureId, string> = {
  licensing: "activation",
  config: "config read",
  identity: "sign-in",
  update: "update check",
  packs: "pack download",
  sync: "sync",
  commerce: "purchase",
};

export type StepState = "done" | "current" | "waiting" | "open";

export interface StepBadge {
  platform: string;
  label: string;
  state: PlatformBadgeState;
  title: string;
}

export interface StepRow {
  id: IntegrationFeatureId;
  service: string;
  name: string;
  state: StepState;
  /** The console step: one verb link. */
  link?: { label: string; to: string };
  /** The line of state ("Waiting for the first sign-in"). */
  text?: string;
  /** The drop-in path, on the first row whose next work is in the app. */
  dropIn?: { kit: string; ownUi: string; sdk: string };
  badges: StepBadge[];
}

const stamp = (seconds: number): string =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(seconds * 1000);

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function stepRows(slug: string, view: IntegrationView): StepRow[] {
  const platforms = seenPlatforms(view);
  const sdk = defaultSdk(view);
  let current = false;
  let dropIn = false;
  return view.features.map((f) => {
    const name = FEATURE_LABEL[f.id];
    const waitingFor = `Waiting for the first ${FIRST[f.id]}`;
    const badges: StepBadge[] = platforms.map((platform) => {
      const label = platformLabel(platform);
      const on = f.verifiedOn.find((v) => v.platform === platform);
      if (on)
        return {
          platform,
          label,
          state: "verified",
          title: on.lastOkAt ? `Verified ${stamp(on.lastOkAt)}` : "Verified",
        };
      if (f.status === "blocked")
        return {
          platform,
          label,
          state: "after",
          title: "After the console step",
        };
      if (f.status === "not_seen")
        return { platform, label, state: "waiting", title: waitingFor };
      return { platform, label, state: "unseen", title: "Not seen yet" };
    });
    const base = { id: f.id, service: f.service, name, badges };
    if (f.status === "verified") return { ...base, state: "done" as const };
    if (f.status === "blocked") {
      const missing = f.prerequisites.find((p) => !p.met);
      const info = prerequisiteInfo(missing?.id ?? "", slug);
      const link = f.unavailable
        ? undefined
        : { label: info.action, to: info.href };
      const state = current ? ("open" as const) : ("current" as const);
      current = true;
      return {
        ...base,
        state,
        link,
        text: f.unavailable ? "Not available yet" : undefined,
      };
    }
    const row: StepRow = { ...base, state: "waiting", text: waitingFor };
    if (!dropIn) {
      dropIn = true;
      row.dropIn = {
        kit: r.integration(slug, { feature: f.id }),
        ownUi: docsUrl(SDK_DOC_KEYS[sdk].ownUi),
        sdk: cap(sdk),
      };
    }
    return row;
  });
}

const LINK =
  "inline-flex min-h-6 items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline";
const QUIET =
  "inline-flex min-h-6 items-center gap-1 text-sm text-fg-muted underline-offset-4 hover:text-fg-strong hover:underline";

function Mark({ state }: { state: StepState }): React.ReactElement {
  const ring =
    "inline-flex size-5 items-center justify-center rounded-full border-2";
  switch (state) {
    case "done":
      return (
        <span
          className={cn(ring, "border-success bg-success text-surface-raised")}
        >
          <Check aria-hidden className="size-3" strokeWidth={3} />
        </span>
      );
    case "current":
      return (
        <span className={cn(ring, "border-accent")}>
          <span className="size-2 rounded-full bg-accent" />
        </span>
      );
    case "waiting":
      return (
        <span className={cn(ring, "border-border-strong text-fg-muted")}>
          <Clock aria-hidden className="size-3" />
        </span>
      );
    case "open":
      return <span className={cn(ring, "border-border-strong")} />;
  }
}

export function IntegrationSteps({
  slug,
  view,
}: {
  slug: string;
  view: IntegrationView;
}): React.ReactElement {
  const rows = stepRows(slug, view);
  return (
    <ol aria-labelledby="overview-steps" className="m-0 list-none p-0">
      {rows.map((s, i) => (
        <li
          key={s.id}
          data-service={s.service}
          data-step={s.state}
          className={cn(
            "relative grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-x-0 py-3 pe-4 @min-[22rem]:grid-cols-[3.5rem_minmax(0,1fr)_auto]",
            s.state === "current" && "bg-accent-subtle",
            // The rail: from this mark to the next row's.
            i < rows.length - 1 &&
              "after:absolute after:start-[1.625rem] after:top-[2.25rem] after:-bottom-3 after:w-0.5 after:bg-border",
            i < rows.length - 1 && s.state === "done" && "after:bg-success",
          )}
        >
          <span className="flex justify-center pt-0.5">
            <Mark state={s.state} />
          </span>
          <div className="min-w-0 space-y-0.5">
            <h3
              className={cn(
                "text-base",
                s.state === "current"
                  ? "font-semibold text-fg-strong"
                  : "font-normal text-fg-strong",
              )}
            >
              {s.name}
              {s.state === "done" ? (
                <span className="sr-only">, done</span>
              ) : null}
            </h3>
            {s.link ? (
              <p>
                <Link to={s.link.to} className={LINK}>
                  {s.link.label}
                </Link>
              </p>
            ) : null}
            {s.text ? <p className="text-sm text-fg-muted">{s.text}</p> : null}
            {s.dropIn ? (
              <p className="flex flex-wrap gap-x-4 gap-y-1">
                <Link
                  to={s.dropIn.kit}
                  aria-label={`${s.name} drop-in kit`}
                  className={LINK}
                >
                  Drop-in kit
                  <ArrowRight aria-hidden className="size-3.5" />
                </Link>
                <a
                  href={s.dropIn.ownUi}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Integrate ${s.name} directly with your own UI: ${s.dropIn.sdk} SDK docs`}
                  className={QUIET}
                >
                  Your own UI
                  <ArrowUpRight aria-hidden className="size-3.5" />
                </a>
              </p>
            ) : null}
          </div>
          <span className="col-start-2 row-start-2 flex gap-1.5 pt-2 @min-[22rem]:col-start-3 @min-[22rem]:row-start-1 @min-[22rem]:ps-2 @min-[22rem]:pt-0">
            {s.badges.map((b) => (
              <PlatformBadge key={b.platform} {...b} />
            ))}
          </span>
        </li>
      ))}
    </ol>
  );
}
