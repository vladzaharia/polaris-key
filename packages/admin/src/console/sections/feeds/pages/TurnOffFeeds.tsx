/**
 * Turn off package feeds (F-34.8, mockup `packages.feeds-turn-off`): the typed confirmation behind
 * the foot card on Packages and behind the Services switch. It names what stops and what is kept,
 * and asks for the product slug.
 *
 * The write is `PUT …/package-feeds` with the owner row's `version` (read from `GET …/package-feeds`),
 * never the generic settings counter. A `version_conflict` 409 carries the switch as it stands:
 * the product row is refetched so the console shows the truth. If the feeds are already off the
 * flow ends (a toast, the dialog closes: never a second Turn off, which would steal the
 * attribution). If they are still on, the dialog says so and the next try sends the fresh counter.
 * The typed word is kept across a failed save. The owner row's `updatedBy` is a session subject
 * and is never shown.
 */

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { afterWrite, packageFeedsConflict } from "../model/model.js";

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
  const latest = React.useRef(sw.data?.packageFeeds);
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
      afterWrite.focus = "off-card";
      toast.success("Package feeds turned off");
    } catch (e) {
      const current = packageFeedsConflict(e);
      if (!current) throw e;
      queryClient.setQueryData(qk.packageFeedsSwitch(slug), {
        packageFeeds: current,
      });
      latest.current = current;
      // The console shows what is true now, not what it saw before.
      void queryClient.invalidateQueries({
        queryKey: qk.product(slug),
        exact: true,
      });
      if (!current.enabled) {
        // Someone else already did it: end here, resolving closes the dialog.
        afterWrite.focus = "off-card";
        toast.info("Package feeds are already off");
        return;
      }
      throw e;
    }
  };
  const describeError = (e: unknown) =>
    packageFeedsConflict(e)
      ? {
          title: "Package feeds changed since you opened this",
          description: "They are on. Turn them off again to continue.",
        }
      : errorCopy(e, { area: "distribution", thing: "Package feeds" });
  const feeds = plural(feedCount, "feed", "feeds");
  const installs =
    packageCount > 0
      ? `${plural(packageCount, "package", "packages")} on ${feeds} answer`
      : feedCount === 1
        ? "its feed answers"
        : `its ${feeds} answer`;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent="danger"
      title={`Turn off package feeds for ${name}?`}
      lead={
        <ul className="m-0 list-disc space-y-1 ps-5 text-fg">
          <li>
            <strong>Installs</strong>: {installs} not found, within 30 seconds.
          </li>
          <li>
            <strong>CI publishes</strong>: <code>pkey release publish</code> is
            refused.
          </li>
          <li>
            <strong>Service tokens</strong>: can&apos;t install or publish.
          </li>
          <li>
            <strong>Kept</strong>: versions, tokens and access. Turn feeds on to
            serve them again.
          </li>
        </ul>
      }
      typedConfirmation={{ value: slug, label: "Type the product slug" }}
      focusTyped
      confirmLabel="Turn off package feeds"
      confirmDisabled={!sw.data}
      describeError={describeError}
      onConfirm={save}
    />
  );
}
