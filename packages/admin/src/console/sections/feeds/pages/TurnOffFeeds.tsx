/**
 * Turn off package feeds (F-34.8, mockup `packages.feeds-turn-off`): the typed confirmation behind
 * the foot card on Packages. It names what stops and what is kept, and asks for the product slug.
 *
 * The write is `PUT …/package-feeds` with the owner row's `version` (read from `GET …/package-feeds`),
 * never the generic settings counter. A `version_conflict` 409 carries the switch as it stands: the
 * dialog stays open, says what changed, and the next try sends the fresh counter. The typed word
 * is kept across a failed save.
 */

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../api.js";
import type { PackageFeedsSwitch } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { offByLabel, packageFeedsConflict } from "../model/model.js";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function TurnOffFeeds({
  open,
  onOpenChange,
  slug,
  name,
  feedCount,
  packageCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  name: string;
  /** Feeds the product has set up. */
  feedCount: number;
  packageCount: number;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const sw = useQuery({
    queryKey: qk.packageFeedsSwitch(slug),
    queryFn: () => api.packageFeeds(slug),
    enabled: open,
  });
  const latest = React.useRef<PackageFeedsSwitch | undefined>(undefined);
  latest.current = sw.data?.packageFeeds;

  const save = async (): Promise<void> => {
    try {
      const result = await mutate("savePackageFeeds", slug, {
        enabled: false,
        expectedVersion: latest.current?.version ?? 0,
      });
      queryClient.setQueryData(qk.packageFeedsSwitch(slug), {
        packageFeeds: result.packageFeeds,
      });
      toast.success("Package feeds turned off");
    } catch (e) {
      const current = packageFeedsConflict(e);
      if (current) {
        queryClient.setQueryData(qk.packageFeedsSwitch(slug), {
          packageFeeds: current,
        });
        latest.current = current;
      }
      throw e;
    }
  };
  const describeError = (e: unknown) => {
    const current = packageFeedsConflict(e);
    if (!current)
      return errorCopy(e, { area: "distribution", thing: "Package feeds" });
    const by = offByLabel(current.updatedBy);
    return {
      title: "Package feeds changed since you opened this",
      description: current.enabled
        ? "They are on. Turn them off again to continue."
        : `They are already off${by ? `, turned off by ${by}` : ""}.`,
    };
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent="danger"
      title={`Turn off package feeds for ${name}?`}
      description="Nothing is deleted."
      consequences={[
        `Installs: ${plural(packageCount, "package", "packages")} on ${plural(feedCount, "feed", "feeds")} stop answering.`,
        "CI publishes: pkey release publish is refused.",
        "Service tokens can't install or publish.",
        "Kept: versions, tokens and access, back when you turn feeds on.",
      ]}
      typedConfirmation={{ value: slug, label: `Type ${slug} to confirm` }}
      focusTyped
      confirmLabel="Turn off package feeds"
      describeError={describeError}
      onConfirm={save}
    />
  );
}
