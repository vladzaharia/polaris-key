import { r } from "../../../routes.js";

/** The release record's tabs; Distribution only while that service is on. */
export function releaseTabs(
  slug: string,
  id: string,
  pins: number,
  distributionOn: boolean,
) {
  return [
    {
      // The record's own URL: Status is the default, and nav.ts's record tabs (the router's
      // accepted segments) name only the other tabs.
      value: "status",
      label: "Status",
      to: r.release(slug, id),
    },
    {
      value: "builds",
      label: "Builds & files",
      to: r.release(slug, id, "builds"),
    },
    {
      value: "packs",
      label: "Packs",
      count: pins,
      to: r.release(slug, id, "packs"),
    },
    {
      value: "channels",
      label: "Release tracks",
      to: r.release(slug, id, "channels"),
    },
    ...(distributionOn
      ? [
          {
            value: "distribution",
            label: "Distribution",
            to: r.release(slug, id, "distribution"),
          },
        ]
      : []),
  ];
}
