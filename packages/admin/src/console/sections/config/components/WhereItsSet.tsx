import * as React from "react";
import { Layers, KeyRound, UserRound } from "lucide-react";
import type { ConfigEntry } from "../../../../api.js";
import { Section } from "../../../../ui/Section.js";
import { EntityLink } from "../../../components/EntityLink.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { useCatalogUsage } from "../data.js";
import { valueText } from "../model/valueUse.js";
import type { KeyHolders } from "./RemovedValues.js";

/**
 * Where a published key is set, past its catalog default (config.entry-setting): each profile that
 * sets it with its value, and how many licenses and accounts set their own. From the usage read,
 * never a re-merge. Nothing is drawn for a key nobody sets.
 */
export function WhereItsSet({
  slug,
  entry,
  holders,
}: {
  slug: string;
  entry: ConfigEntry;
  holders: KeyHolders | undefined;
}): React.ReactElement | null {
  const usage = useCatalogUsage(slug, [entry.key]);
  const u = usage.data?.keys[entry.key];
  if (!u) return null;
  const licenses = u.licenses.length;
  const accounts = u.accounts?.length ?? 0;
  if (u.profiles.length + licenses + accounts === 0) return null;
  const drawer = `${r.catalog(slug)}?key=${encodeURIComponent(entry.key)}`;
  const valueOf = (id: string): unknown =>
    holders?.holders.find((h) => h.kind === "profile" && h.id === id)?.value;
  return (
    <Section variant="settings" id="where-set" title="Where it's set">
      <ul className="divide-y divide-border text-sm">
        {u.profiles.map((p) => {
          const v = valueOf(p.id);
          return (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <span className="flex items-center gap-3">
                <Layers aria-hidden className="size-4 text-fg-muted" />
                <EntityLink
                  slug={slug}
                  kind="profile"
                  id={p.id}
                  label={`${p.name || p.id} profile`}
                />
              </span>
              {v !== undefined ? (
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">
                  {valueText(v)}
                </code>
              ) : null}
            </li>
          );
        })}
        {licenses > 0 ? (
          <li className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="flex items-center gap-3">
              <KeyRound aria-hidden className="size-4 text-fg-muted" />
              Licenses
            </span>
            <Link to={drawer} className="underline underline-offset-2">
              {licenses} set their own
            </Link>
          </li>
        ) : null}
        {accounts > 0 ? (
          <li className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="flex items-center gap-3">
              <UserRound aria-hidden className="size-4 text-fg-muted" />
              Accounts
            </span>
            <Link to={drawer} className="underline underline-offset-2">
              {accounts} set their own
            </Link>
          </li>
        ) : null}
      </ul>
    </Section>
  );
}
