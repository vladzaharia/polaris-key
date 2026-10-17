import * as React from "react";
import type {
  EdgeMintRecipe,
  EdgeMintRecipesResponse,
} from "../../../../api.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import {
  claimLines,
  FIELD_LABELS,
  FIELD_ORDER,
  lineDiff,
  readable,
} from "../model/edgeMintFields.js";

/** Why the mint is public, in words, from the response's three flags. */
export function publicReasons(data: EdgeMintRecipesResponse): string {
  const reasons = [
    ...(data.registration === "open" ? ["registration is open"] : []),
    ...(data.anonymousEnroll ? ["anonymous enrollment is on"] : []),
    ...(data.oidcDefault
      ? ["every account that can sign in gets a default tier"]
      : []),
  ];
  if (reasons.length > 1)
    return `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
  return reasons[0] ?? "registration is open";
}

export function SecretUsage({
  usage,
}: {
  usage: EdgeMintRecipe["secretUsage"];
}): React.ReactElement {
  if (usage === "edge-mint")
    return (
      <StatusPill tone="success" size="sm">
        Marked edge-mint
      </StatusPill>
    );
  if (usage === "missing")
    return (
      <StatusPill tone="danger" size="sm">
        Not set
      </StatusPill>
    );
  if (usage === "unrecognised")
    return (
      <StatusPill tone="danger" size="sm">
        Unrecognized usage
      </StatusPill>
    );
  return (
    <StatusPill tone="warning" size="sm">
      General: cannot sign
    </StatusPill>
  );
}

export type Field = keyof EdgeMintRecipe & (typeof FIELD_ORDER)[number];

const TINT = {
  del: "bg-danger-subtle text-danger",
  add: "bg-success-subtle text-success",
  same: "",
} as const;

/** A claims template as one code block; with `was`, a line diff (removed −, added +). */
function Claims({
  now,
  was,
}: {
  now: string | null;
  was?: string | null;
}): React.ReactElement {
  const lines =
    was === undefined
      ? claimLines(now).map((text) => ({ kind: "same" as const, text }))
      : lineDiff(claimLines(was), claimLines(now));
  if (lines.length === 0) return <span className="text-fg-muted">Not set</span>;
  return (
    <pre
      role="region"
      aria-label={
        was === undefined ? "Claims template" : "Claims template changes"
      }
      className="max-w-full whitespace-pre-wrap rounded-md border border-border bg-surface-sunken py-1 font-mono text-xs [overflow-wrap:anywhere]"
    >
      {lines.map((l, i) => (
        <div key={i} className={`px-2 ${TINT[l.kind]}`}>
          <span aria-hidden="true">
            {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}
          </span>
          {l.kind !== "same" ? (
            <span className="sr-only">
              {l.kind === "add" ? "Added " : "Removed "}
            </span>
          ) : null}
          {l.text || " "}
        </div>
      ))}
    </pre>
  );
}

function ValueText({
  field,
  value,
}: {
  field: Field;
  value: string | number | null | undefined;
}): React.ReactElement {
  const text = readable(field, value);
  return (
    <span
      className={
        text === "Not set"
          ? "break-words text-fg-muted"
          : field === "requires" || field === "ttlSeconds"
            ? "break-words"
            : "break-all font-mono text-xs"
      }
    >
      {text}
    </span>
  );
}

/** One aligned grid of fields: a fixed label column, then the value (old struck, new marked). */
export function FieldGrid({
  recipe,
  rows,
}: {
  recipe: EdgeMintRecipe;
  rows: { field: Field; moved: boolean }[];
}): React.ReactElement {
  return (
    <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 divide-y divide-border sm:grid-cols-[10rem_minmax(0,1fr)]">
      {rows.map(({ field, moved }) => {
        const now = recipe[field];
        const was = recipe.approval?.[field];
        return (
          <div key={field} className="col-span-2 grid grid-cols-subgrid py-1.5">
            <dt className="text-fg-muted">
              {FIELD_LABELS[field]}
              {moved ? <span className="sr-only"> (changed)</span> : null}
            </dt>
            <dd className="min-w-0 space-y-1">
              {field === "claimsTemplateJson" ? (
                <Claims
                  now={now as string | null}
                  was={moved ? (was as string | null) : undefined}
                />
              ) : moved ? (
                <>
                  <div
                    data-testid={`was-${field}`}
                    className={`rounded px-1.5 py-0.5 line-through ${TINT.del}`}
                  >
                    <span aria-hidden="true">− </span>
                    <span className="sr-only">Approved as </span>
                    <ValueText field={field} value={was} />
                  </div>
                  <div
                    className={`rounded px-1.5 py-0.5 font-semibold ${TINT.add}`}
                  >
                    <span aria-hidden="true">+ </span>
                    <span className="sr-only">Now </span>
                    <ValueText field={field} value={now} />
                  </div>
                </>
              ) : (
                <ValueText field={field} value={now} />
              )}
              {field === "signingKeySecret" ? (
                <span className="flex">
                  <SecretUsage usage={recipe.secretUsage} />
                </span>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
