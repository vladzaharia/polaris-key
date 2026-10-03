import * as React from "react";
import { platformLabel } from "@polaris-key/manifest";
import { MoreHorizontal, Radio } from "lucide-react";
import type {
  ChannelPolicyDto,
  ReleaseChannelFloorDto,
  ReleaseChannelsResponse,
  ReleaseDto,
} from "../../api.js";
import { docsUrl } from "../../lib/docsLinks.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  type ColumnDef,
} from "../../components/ui/index.js";
import { absoluteTime, relativeTime } from "../format.js";
import type { PolicyAction } from "./PolicyActionDialog.js";

/**
 * The channels of the app deliverable (a pack's releases and pins are on its Deliverables page,
 * P4-09; per-pack channel controls are a follow-up): per channel, what it resolves
 * to on each platform, its pointer and pin, what it includes, its minimum supported version, the
 * critical flag, the anti-rollback floor, who owns the row and who changed it last.
 *
 * Everything here is what `GET …/release/channels` and `GET …/release/releases` return. The
 * per-platform column is the server's resolution (`byPlatform`), rendered as is: "stable" is not
 * one release — a release missing one platform's build leaves that platform on the newest release
 * that has one — and the console never recomputes that rule.
 *
 * Operator-owned means visible: every row shows its `source`, and "Revert to manifest" is offered
 * only on an `admin` row, because that is the only row a resync would otherwise leave alone.
 */
export function ChannelsPanel({
  data,
  releases,
  floors,
  loading,
  error,
  onRetry,
  onAction,
}: {
  data: ReleaseChannelsResponse | null;
  releases: ReleaseDto[];
  floors: ReleaseChannelFloorDto[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onAction: (action: PolicyAction) => void;
}): React.ReactElement {
  const app = data?.deliverables.find((d) => d.kind === "app") ?? null;
  const versionOf = React.useCallback(
    (id: string | null): string | null =>
      id === null
        ? null
        : (releases.find((r) => r.releaseId === id)?.version ?? id),
    [releases],
  );
  const floorOf = (channel: string): ReleaseChannelFloorDto | undefined =>
    floors.find((f) => f.channel === channel);
  const platforms = app?.platforms ?? [];
  // Only once the channels have loaded: before that every floor would look stranded.
  const stranded = app
    ? floors.filter((f) => !app.channels.some((c) => c.channel === f.channel))
    : [];

  const columns: ColumnDef<ChannelPolicyDto>[] = [
    {
      id: "channel",
      header: "Channel",
      accessor: (c) => c.channel,
      cell: (c) => <span className="font-medium">{c.channel}</span>,
    },
    {
      id: "serves",
      header: "Serves",
      cell: (c) => (
        <ResolvedCell channel={c} platforms={platforms} versionOf={versionOf} />
      ),
    },
    {
      id: "pointer",
      header: "Pointer",
      cell: (c) =>
        c.pointer ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className="font-mono text-xs">{versionOf(c.pointer)}</span>
            {c.pinned ? <Badge variant="warning">pinned</Badge> : null}
          </span>
        ) : (
          <span className="text-muted-foreground">newest</span>
        ),
    },
    {
      id: "includes",
      header: "Includes",
      cell: (c) =>
        c.includes === null ? (
          <span className="text-muted-foreground">default</span>
        ) : c.includes.length ? (
          c.includes.join(", ")
        ) : (
          <span className="text-muted-foreground">none</span>
        ),
    },
    {
      id: "minSupported",
      header: "Minimum supported",
      cell: (c) =>
        c.minSupported ? (
          <span className="font-mono text-xs">{c.minSupported}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "critical",
      header: "Critical",
      cell: (c) =>
        c.critical ? (
          <Badge variant="destructive">critical</Badge>
        ) : (
          <span className="text-muted-foreground">no</span>
        ),
    },
    {
      id: "floor",
      header: "Rollback floor",
      cell: (c) => {
        const f = floorOf(c.channel);
        return f ? (
          <span
            className="font-mono text-xs"
            title={`raised ${absoluteTime(f.raisedAt)}`}
          >
            {f.version}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "source",
      header: "Source",
      cell: (c) => (
        <Badge variant={c.source === "admin" ? "primary" : "outline"}>
          {c.source}
        </Badge>
      ),
    },
    {
      id: "changed",
      header: "Last change",
      cell: (c) =>
        c.modifiedAt ? (
          <span className="text-xs" title={absoluteTime(c.modifiedAt)}>
            {c.modifiedBy ?? "—"} · {relativeTime(c.modifiedAt)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      cell: (c) => (
        <ChannelMenu
          channel={c}
          floor={floorOf(c.channel)}
          onAction={onAction}
        />
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Radio className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle>Channels</CardTitle>
        </div>
        <CardDescription>
          What each channel of the app serves on every platform, and the policy
          behind it. Changes here belong to the operator and survive a resync
          until you revert them.{" "}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href={docsUrl("releaseChannels")}
            target="_blank"
            rel="noreferrer"
          >
            Learn more
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && !loading ? (
          <div className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="font-medium text-warning">
              Couldn’t load the channels
            </p>
            <p className="text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <DataTable
              columns={columns}
              rows={app?.channels ?? []}
              rowKey={(c) => `${c.deliverable}/${c.channel}`}
              loading={loading}
              empty={
                <EmptyState
                  icon={<Radio aria-hidden />}
                  title="No channels yet"
                  description="Channels appear once the product has a release configuration and a release in the store."
                  className="rounded-none border-0"
                />
              }
            />
            {stranded.length ? (
              <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                <p className="font-medium text-warning">
                  Floors on channels this product no longer serves
                </p>
                <p className="text-muted-foreground">
                  Inert today, but they come back to life if the channel does.
                  They can be cleared, never lowered.
                </p>
                <ul className="flex flex-wrap gap-2">
                  {stranded.map((f) => (
                    <li key={f.channel} className="flex items-center gap-2">
                      <span className="font-mono text-xs">
                        {f.channel} ≥ {f.version}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          onAction({
                            kind: "clearFloor",
                            channel: f.channel,
                            floor: f,
                          })
                        }
                      >
                        Clear {f.channel} floor
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The release a channel serves per platform, from the server's `byPlatform`. With no builds
 * declared at all (a legacy, GitHub-only product) there are no platforms to split by, so the
 * channel's single `resolved` release is shown.
 */
function ResolvedCell({
  channel,
  platforms,
  versionOf,
}: {
  channel: ChannelPolicyDto;
  platforms: string[];
  versionOf: (id: string | null) => string | null;
}): React.ReactElement {
  if (platforms.length === 0) {
    return channel.resolved ? (
      <span className="font-mono text-xs">{versionOf(channel.resolved)}</span>
    ) : (
      <span className="text-muted-foreground">nothing</span>
    );
  }
  return (
    <ul
      className="flex flex-wrap gap-1"
      aria-label={`${channel.channel} per platform`}
    >
      {platforms.map((p) => {
        const id = channel.byPlatform[p] ?? null;
        return (
          <li key={p}>
            <Badge variant={id ? "outline" : "warning"}>
              <span>{platformLabel(p)}</span>
              <span aria-hidden>→</span>
              <span className="font-mono">
                {id ? versionOf(id) : "nothing"}
              </span>
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

function ChannelMenu({
  channel,
  floor,
  onAction,
}: {
  channel: ChannelPolicyDto;
  floor: ReleaseChannelFloorDto | undefined;
  onAction: (action: PolicyAction) => void;
}): React.ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for ${channel.channel}`}
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{channel.channel}</DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => onAction({ kind: "promote", channel })}
        >
          Promote a release…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction({ kind: "pin", channel })}>
          Pin to a release…
        </DropdownMenuItem>
        {channel.pinned ? (
          <DropdownMenuItem
            onSelect={() => onAction({ kind: "unpin", channel })}
          >
            Unpin
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => onAction({ kind: "minSupported", channel })}
        >
          Set minimum supported…
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onAction({ kind: "critical", channel })}
        >
          {channel.critical ? "Clear critical" : "Mark critical"}
        </DropdownMenuItem>
        {floor ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                onAction({
                  kind: "lowerFloor",
                  channel: channel.channel,
                  floor,
                })
              }
            >
              Lower rollback floor…
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                onAction({
                  kind: "clearFloor",
                  channel: channel.channel,
                  floor,
                })
              }
            >
              Clear rollback floor
            </DropdownMenuItem>
          </>
        ) : null}
        {channel.source === "admin" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onAction({ kind: "revert", channel })}
            >
              Revert to manifest
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
