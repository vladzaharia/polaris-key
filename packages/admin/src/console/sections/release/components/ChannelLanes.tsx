import * as React from "react";
import { AlertTriangle, Info, Pin } from "lucide-react";
import type {
  ChannelPolicyDto,
  ReleaseChannelFloorDto,
} from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { fromSeconds } from "../../../../lib/format.js";
import type { ActionMenuEntry } from "../../../../ui/ActionMenu.js";
import { ActionMenu } from "../../../../ui/ActionMenu.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Popover } from "../../../../ui/Popover.js";
import { SourceBadge } from "../../../../ui/SourceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import type { PolicyAction, ReleaseOption } from "./PolicyDialog.js";
import { actorName, APP, platformName } from "./shared.js";

/**
 * The lane view (ADMIN.md §6.3.3, CHN-1 to CHN-6): one lane per channel instead of a 10-column
 * table. Each lane spells out the pointer, what it serves on every platform (and why a platform
 * gets an older release), the policy, and who changed it last. Promote is visible on every lane;
 * the other writes are in the lane menu, and each policy field has its own inline affordance.
 *
 * Everything is what `GET …/release/channels` returns: the per-platform answer is the server's
 * resolution, rendered as is (the console never recomputes it).
 */

/** "How channels resolve": the pointer / serves / newest model in words (CHN-4). */
export function HowChannelsResolve(): React.ReactElement {
  return (
    <Popover
      label="How channels resolve"
      trigger={
        <button
          type="button"
          className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
        >
          <Info aria-hidden className="size-3.5" />
          How channels resolve
        </button>
      }
    >
      <div className="max-w-80 space-y-2 text-sm text-fg">
        <p>
          A channel serves its <strong>newest eligible release</strong> on each
          platform. Promoting a release moves the channel's pointer; newer
          releases still flow while it is unpinned.
        </p>
        <p>
          A <strong>pinned</strong> channel serves exactly its pointer, on every
          platform that has a build of it. A platform without one gets the
          newest older release that has one.
        </p>
        <p>
          A channel that <strong>includes</strong> another (beta includes
          stable) also serves that channel's releases when they are newer.
        </p>
        <a
          href={docsUrl("releaseChannels")}
          target="_blank"
          rel="noreferrer"
          className="text-accent-fg underline-offset-4 hover:underline"
        >
          Channels in the docs
        </a>
      </div>
    </Popover>
  );
}

function Row({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-baseline sm:gap-6">
      <dt className="text-sm text-fg-muted">{term}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg sm:justify-end sm:text-right">
        {children}
      </dd>
    </div>
  );
}

function InlineEdit({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <Button variant="link" size="xs" onClick={onClick}>
      {label}
    </Button>
  );
}

export interface LaneContext {
  slug: string;
  /** The deliverable's releases (to name a release id by its version). */
  releases: ReleaseOption[];
  /** The deliverable's platforms (every platform some build declares). */
  platforms: string[];
  /** The rollback floors (app channels; keyed by channel name). */
  floors: ReleaseChannelFloorDto[];
  onAction: (action: PolicyAction) => void;
  /** Is Distribution on (the Matrix link exists)? */
  distributionOn: boolean;
}

function versionIn(releases: ReleaseOption[], id: string | null): string {
  if (id === null) return "—";
  return releases.find((x) => x.releaseId === id)?.version ?? id;
}

/** What one platform gets, and why it differs from the channel's head release. */
function servesLine(
  c: ChannelPolicyDto,
  platform: string,
  releases: ReleaseOption[],
): { text: string; why: string | null } {
  const id = c.byPlatform[platform] ?? null;
  const head = c.pointer ?? c.resolved;
  if (id === null) {
    return {
      text: `${platformName(platform)}: nothing`,
      why: `no ${platformName(platform)} build in any release ${c.channel} may serve`,
    };
  }
  const text = `${platformName(platform)} ${versionIn(releases, id)}`;
  if (head && id !== head) {
    return {
      text,
      why: `no ${platformName(platform)} build in ${versionIn(releases, head)}`,
    };
  }
  return { text, why: null };
}

export function ChannelLane({
  channel: c,
  ctx,
}: {
  channel: ChannelPolicyDto;
  ctx: LaneContext;
}): React.ReactElement {
  const { releases, platforms, onAction } = ctx;
  const isApp = c.deliverable === APP;
  const floor = isApp
    ? ctx.floors.find((f) => f.channel === c.channel)
    : undefined;
  const headingId = `lane-${c.deliverable}-${c.channel}`.replace(
    /[^\w-]/g,
    "-",
  );

  const menu: ActionMenuEntry[] = [
    {
      label: c.pinned ? "Move the pin…" : "Pin to a release…",
      onSelect: () =>
        onAction({
          kind: "pin",
          deliverable: c.deliverable,
          channel: c.channel,
        }),
    },
    ...(c.pinned
      ? [
          {
            label: "Unpin…",
            onSelect: () => onAction({ kind: "unpin", channel: c }),
          },
        ]
      : []),
    { type: "separator" },
    {
      label: "Set minimum supported…",
      onSelect: () => onAction({ kind: "minSupported", channel: c }),
    },
    {
      label: c.critical ? "Clear critical…" : "Mark critical…",
      onSelect: () => onAction({ kind: "critical", channel: c }),
    },
    ...(!isApp
      ? [
          {
            label: "Set a floor for a content API line…",
            onSelect: () => onAction({ kind: "packFloor", channel: c }),
          },
        ]
      : []),
    ...(c.source === "admin"
      ? [
          { type: "separator" as const },
          {
            label: "Revert to manifest…",
            onSelect: () => onAction({ kind: "revert", channel: c }),
          },
        ]
      : []),
    ...(floor
      ? [
          { type: "separator" as const },
          {
            label: "Lower rollback floor…",
            onSelect: () =>
              onAction({ kind: "lowerFloor", channel: c.channel, floor }),
          },
          {
            label: "Clear rollback floor…",
            tone: "danger" as const,
            onSelect: () =>
              onAction({ kind: "clearFloor", channel: c.channel, floor }),
          },
        ]
      : []),
  ];

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-lg border border-border bg-surface-raised p-4"
      data-lane={c.channel}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2
            id={headingId}
            className="font-mono text-base font-semibold text-fg-strong"
          >
            {c.channel}
          </h2>
          <SourceBadge
            source={c.source}
            path=".pkey/release"
            onRevert={
              c.source === "admin"
                ? () => onAction({ kind: "revert", channel: c })
                : undefined
            }
          />
          {c.modifiedAt ? (
            <span className="text-xs text-fg-muted">
              last change{" "}
              <Timestamp at={fromSeconds(c.modifiedAt)} format="relative" /> by{" "}
              {actorName(c.modifiedBy)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onAction({
                kind: "promote",
                deliverable: c.deliverable,
                channel: c.channel,
              })
            }
          >
            Promote…
          </Button>
          <ActionMenu label={`More actions for ${c.channel}`} items={menu} />
        </div>
      </div>
      {/* One term per row, the value flush right: every row of a lane ends on one edge. */}
      <dl className="divide-y divide-border border-t border-border">
        <Row term="Pointer">
          {c.pointer ? (
            <>
              <span className="font-mono text-xs">
                {versionIn(releases, c.pointer)}
              </span>
              {c.pinned ? (
                <StatusPill tone="accent" icon={Pin}>
                  Pinned
                </StatusPill>
              ) : null}
            </>
          ) : (
            <span>
              Newest eligible release
              {c.resolved ? (
                <span className="text-fg-muted">
                  {" "}
                  (now{" "}
                  <span className="font-mono text-xs">
                    {versionIn(releases, c.resolved)}
                  </span>
                  )
                </span>
              ) : null}
            </span>
          )}
        </Row>
        <Row term="Includes">
          {c.includes === null
            ? c.channel === "beta"
              ? "stable (the default)"
              : "No other channel (the default)"
            : c.includes.length
              ? c.includes.join(", ")
              : "No other channel"}
        </Row>
        <Row term="Serves">
          {platforms.length === 0 ? (
            c.resolved ? (
              <span className="font-mono text-xs">
                {versionIn(releases, c.resolved)}
              </span>
            ) : (
              <span className="text-fg-muted">
                Nothing yet: no release is eligible on {c.channel}.
              </span>
            )
          ) : (
            <ul
              className="flex flex-col gap-1 sm:items-end"
              aria-label={`What ${c.channel} serves per platform`}
            >
              {platforms.map((p) => {
                const line = servesLine(c, p, releases);
                return (
                  <li
                    key={p}
                    className="flex flex-wrap items-center gap-x-2 sm:justify-end"
                  >
                    <span>{line.text}</span>
                    {line.why ? (
                      <span className="inline-flex items-center gap-1 text-xs text-warning">
                        <AlertTriangle aria-hidden className="size-3.5" />
                        {line.why}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Row>
        <Row term="Minimum supported">
          {c.minSupported ? (
            <span className="font-mono text-xs">{c.minSupported}</span>
          ) : (
            <span className="text-fg-muted">None</span>
          )}
          <InlineEdit
            label={c.minSupported ? "Change…" : "Set…"}
            onClick={() => onAction({ kind: "minSupported", channel: c })}
          />
        </Row>
        <Row term="Critical update">
          {c.critical ? (
            <StatusPill tone="warning">Critical</StatusPill>
          ) : (
            <span className="text-fg-muted">Not critical</span>
          )}
          <InlineEdit
            label={c.critical ? "Clear…" : "Mark…"}
            onClick={() => onAction({ kind: "critical", channel: c })}
          />
        </Row>
        {isApp ? (
          <Row term="Rollback floor">
            {floor ? (
              <>
                <span>
                  <span className="font-mono text-xs">{floor.version}</span>
                  <span className="text-xs text-fg-muted">
                    {" "}
                    · raised{" "}
                    <Timestamp
                      at={fromSeconds(floor.raisedAt)}
                      format="relative"
                    />
                    {floor.loweredAt ? (
                      <>
                        {" "}
                        · lowered{" "}
                        <Timestamp
                          at={fromSeconds(floor.loweredAt)}
                          format="relative"
                        />{" "}
                        by {actorName(floor.loweredBy)}
                      </>
                    ) : null}
                  </span>
                </span>
                <InlineEdit
                  label="Lower…"
                  onClick={() =>
                    onAction({
                      kind: "lowerFloor",
                      channel: c.channel,
                      floor,
                    })
                  }
                />
              </>
            ) : (
              <span className="text-fg-muted">None recorded yet</span>
            )}
          </Row>
        ) : (
          <Row term="Floors per content API line">
            <ul
              className="flex flex-col gap-1 sm:items-end"
              aria-label={`${c.deliverable} floors on ${c.channel}`}
            >
              {c.packFloors?.length ? (
                c.packFloors.map((f) => (
                  <li
                    key={f.contentApi}
                    className="flex flex-wrap items-center gap-x-3 sm:justify-end"
                  >
                    <span>
                      Content API {f.contentApi}: ≥{" "}
                      <span className="font-mono text-xs">
                        {f.minSupported}
                      </span>
                    </span>
                    <InlineEdit
                      label="Change…"
                      onClick={() =>
                        onAction({
                          kind: "packFloor",
                          channel: c,
                          contentApi: f.contentApi,
                        })
                      }
                    />
                  </li>
                ))
              ) : (
                <li className="text-fg-muted">None</li>
              )}
              <li>
                <InlineEdit
                  label="Add…"
                  onClick={() => onAction({ kind: "packFloor", channel: c })}
                />
              </li>
            </ul>
          </Row>
        )}
      </dl>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2 text-sm">
        <Link
          to={r.compatibility(ctx.slug)}
          className="text-accent-fg underline-offset-4 hover:underline"
        >
          Compatibility
        </Link>
        {ctx.distributionOn && isApp ? (
          <Link
            to={r.matrix(ctx.slug, { deliverable: c.deliverable })}
            className="text-accent-fg underline-offset-4 hover:underline"
          >
            Distribution matrix
          </Link>
        ) : null}
      </div>
    </section>
  );
}

/** Floors whose channel is no longer served: inert until it is, clearable, never lowerable. */
export function StrandedFloors({
  floors,
  onAction,
}: {
  floors: ReleaseChannelFloorDto[];
  onAction: (action: PolicyAction) => void;
}): React.ReactElement | null {
  if (!floors.length) return null;
  return (
    <Callout
      tone="warning"
      title="Floors on channels this product no longer serves"
    >
      <p className="mb-2">
        Inert today; they apply again if the channel comes back. They can be
        cleared, never lowered.
      </p>
      <ul className="flex flex-col gap-2">
        {floors.map((f) => (
          <li key={f.channel} className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">
              {f.channel} ≥ {f.version}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onAction({ kind: "clearFloor", channel: f.channel, floor: f })
              }
            >
              Clear {f.channel} floor…
            </Button>
          </li>
        ))}
      </ul>
    </Callout>
  );
}
