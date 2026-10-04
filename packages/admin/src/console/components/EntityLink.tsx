import * as React from "react";
import { cn } from "../../lib/cn.js";
import { Link } from "../router.js";
import { productPage, r } from "../routes.js";

/**
 * A typed link to any entity (components.md §6.11). Every id the console shows goes through this,
 * so a moved route moves every link (fixes DEV-1, ACT-2, UHL-6, PKD-8, TIR-9). With no `label`
 * the id itself is the text, in mono.
 */
export type EntityRef =
  | { kind: "license"; id: string; tab?: string }
  | { kind: "tier"; id: string }
  | { kind: "profile"; id: string; tab?: string }
  | { kind: "release"; id: string; tab?: string }
  | { kind: "deliverable"; id: string; tab?: string }
  /** A pack release: the deliverable record's Releases tab, with the release selected. */
  | { kind: "pack-release"; deliverable: string; id: string }
  /** A device: the routed device drawer (`devices/:id`). */
  | { kind: "device"; id: string }
  /** A catalog key: the catalog searched for that key. */
  | { kind: "catalog-key"; id: string }
  /** An outlet: Outlets & feeds with that outlet open. */
  | { kind: "outlet"; id: string }
  /** A rollout: the matrix cell (`?cell=<release>:<outlet>`). */
  | { kind: "rollout"; release: string; outlet: string; deliverable?: string };

export type EntityKind = EntityRef["kind"];

/** The hash an entity lives at, within product `slug`. */
export function entityHref(slug: string, ref: EntityRef): string {
  switch (ref.kind) {
    case "license":
      return r.license(slug, ref.id, ref.tab);
    case "tier":
      return r.tier(slug, ref.id);
    case "profile":
      return r.profile(slug, ref.id, ref.tab);
    case "release":
      return r.release(slug, ref.id, ref.tab);
    case "deliverable":
      return r.deliverable(slug, ref.id, ref.tab);
    case "pack-release":
      return productPage(slug, "deliverables", {
        id: ref.deliverable,
        tab: "releases",
        query: { release: ref.id },
      });
    case "device":
      return r.device(slug, ref.id);
    case "catalog-key":
      return productPage(slug, "catalog", { query: { q: ref.id } });
    case "outlet":
      return productPage(slug, "outlets", { query: { outlet: ref.id } });
    case "rollout":
      return r.matrix(slug, {
        deliverable: ref.deliverable,
        cell: `${ref.release}:${ref.outlet}`,
      });
  }
}

function defaultLabel(ref: EntityRef): string {
  if (ref.kind === "rollout") return `${ref.release} × ${ref.outlet}`;
  return ref.id;
}

export type EntityLinkProps = EntityRef & {
  /** The product the entity belongs to. */
  slug: string;
  /** Human text (a license name, a version). Without it the id shows, in mono. */
  label?: React.ReactNode;
  className?: string;
};

export function EntityLink({
  slug,
  label,
  className,
  ...ref
}: EntityLinkProps): React.ReactElement {
  const entity = ref as EntityRef;
  return (
    <Link
      to={entityHref(slug, entity)}
      className={cn(
        "text-accent-fg underline-offset-4 hover:underline",
        label === undefined && "font-mono text-xs",
        className,
      )}
    >
      {label ?? defaultLabel(entity)}
    </Link>
  );
}
