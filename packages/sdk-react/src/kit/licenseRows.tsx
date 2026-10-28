// The license step's list (SIGN-IN.md §3.7): every license as a radio of a choosable list, or as
// a row with its own Replace a device when every one is full; the keep, create and first-license
// rows. Its own module: the gate never draws it, so a gate bundle leaves it out. A part that
// draws the step hands it to the views as `KitCtx.licenseRows`.

import type { KeyboardEvent, ReactNode } from "react";
import type { LicenseChoiceRow } from "@polaris-key/ui-core";

import { adaptChoice, adaptSignIn, ORIGIN_KEY } from "./adapt.js";
import {
  button,
  GLYPHS,
  plain,
  seatMeter,
  text,
  type KitCtx,
} from "./parts.js";

type Entry =
  | { kind: "license"; id: string; row: LicenseChoiceRow }
  | { kind: "keep" | "create" | "new"; id: string; tier?: string };

/** Arrow keys move through the rows a person can choose; Space and Enter choose. */
function radioNav(e: KeyboardEvent<HTMLElement>, c: KitCtx): void {
  const go =
    e.key === "ArrowDown" || e.key === "ArrowRight"
      ? 1
      : e.key === "ArrowUp" || e.key === "ArrowLeft"
        ? -1
        : 0;
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    c.pick(e.currentTarget.dataset.id ?? "");
  } else if (go !== 0) {
    e.preventDefault();
    const rows = [
      ...e.currentTarget.parentElement!.querySelectorAll<HTMLElement>(
        '[role="radio"]:not([aria-disabled])',
      ),
    ];
    const next =
      rows[(rows.indexOf(e.currentTarget) + go + rows.length) % rows.length];
    c.pick(next?.dataset.id ?? "");
    queueMicrotask(() => next?.focus());
  }
}

/** The base anatomy of the license step in every state: the radiogroup of every license (and the
 *  keep, create and first-license rows), drawn from `input.choices` whatever the state adds. */
export function licenseRows(c: KitCtx): ReactNode {
  const ch = c.input.choices;
  if (!ch) return null;
  const has = (k: string) => c.copy.has(k);
  const entries: Entry[] = [
    ...(ch.state === "autoIssue" && ch.create
      ? [{ kind: "new" as const, id: "new", tier: ch.create.tierName }]
      : []),
    ...(ch.keep ? [{ kind: "keep" as const, id: "keep" }] : []),
    ...ch.choices.map((row) => ({ kind: "license" as const, id: row.id, row })),
    ...(ch.create && ch.state !== "autoIssue" && c.view.state !== "all-full"
      ? [{ kind: "create" as const, id: "create", tier: ch.create.tierName }]
      : []),
  ];
  if (entries.length === 0) return null;
  const selectable = (e: Entry) =>
    e.kind !== "license" || e.row.state === "free";
  const wanted = c.input.selected ?? ch.preselected ?? null;
  const selected = entries.some((e) => e.id === wanted && selectable(e))
    ? wanted
    : (entries.find(selectable)?.id ?? null);
  const allFull = !entries.some(selectable);
  const lone = allFull && entries.length === 1;
  const tag = (k: string) =>
    has(k) ? (
      <>
        {" "}
        <span className="pill" data-key={k}>
          {text(c, k)}
        </span>
      </>
    ) : null;
  const rowProps = (id: string, on: boolean) => ({
    className: "row",
    "data-part": "license-row",
    "data-id": id,
    role: "radio",
    tabIndex: on ? 0 : -1,
    "aria-checked": on ? ("true" as const) : ("false" as const),
    onClick: () => c.pick(id),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => radioNav(e, c),
  });
  const rowFor = (e: Entry): ReactNode => {
    const on = e.id === selected;
    const check = on ? GLYPHS.check() : <span />;
    if (e.kind !== "license") {
      const [titleKey, metaKey, tagKey, pill] =
        e.kind === "keep"
          ? ["signin.choice.keep", "signin.choice.keepMeta", null, null]
          : e.kind === "create"
            ? ["signin.choice.create", "signin.choice.createMeta", null, e.tier]
            : ["signin.choice.metaNew", null, "signin.choice.tag.new", e.tier];
      return (
        <div key={e.id} {...rowProps(e.id, on)}>
          {pill ? <span className="pill">{pill}</span> : <span />}
          <span>
            <span className="row-title" data-key={titleKey!}>
              {text(c, titleKey!)}
            </span>
            {tagKey ? tag(tagKey) : null}
            {metaKey && has(metaKey) ? (
              <>
                <br />
                <span className="meta" data-key={metaKey}>
                  {text(c, metaKey)}
                </span>
              </>
            ) : null}
          </span>
          {check}
        </div>
      );
    }
    const r = e.row;
    const full = r.state !== "free";
    const origin = ORIGIN_KEY[r.origin];
    const term =
      r.expiresAt === null ? "signin.term.lifetime" : "signin.term.until";
    const date = r.expiresAt
      ? new Date(r.expiresAt * 1000).toLocaleDateString(c.copy.locale)
      : "";
    // A store-origin row with no store name says nothing of its origin (never "From {store}").
    const metaArgs = {
      origin:
        origin && has(origin) && (r.origin !== "store" || r.store)
          ? plain(c, origin, r.store ? { store: r.store } : {})
          : "",
      term: has(term) ? plain(c, term, { date }) : "",
    };
    const meta = metaArgs.origin
      ? has("signin.choice.meta")
        ? text(c, "signin.choice.meta", metaArgs)
        : metaArgs.origin
      : metaArgs.term;
    const body = (
      <>
        <span className="pill">{r.tierName}</span>
        <span>
          {r.seats.limit !== null && has("signin.choice.devices") ? (
            <>
              <span className="row-title num">
                {text(c, "signin.choice.devices", {
                  used: r.seats.used,
                  limit: r.seats.limit,
                })}
              </span>
              <br />
              {seatMeter(c, r.seats.used, r.seats.limit, false)}
            </>
          ) : null}
          <span className="meta-line">
            <span className="meta">{meta}</span>
            {full ? tag("signin.choice.tag.full") : null}
            {r.current ? tag("signin.choice.tag.current") : null}
          </span>
        </span>
      </>
    );
    if (!full)
      return (
        <div key={e.id} {...rowProps(e.id, on)}>
          {body}
          {check}
        </div>
      );
    // A full license cannot be chosen. In a list that can be chosen from it is a disabled radio;
    // when every license is full, Replace a device is its action, carrying its license.
    const replaceHere = r.replace?.allowed && has("signin.replace.open");
    if (!allFull && !replaceHere)
      return (
        <div
          key={e.id}
          className="row"
          role="radio"
          data-part="license-row"
          data-id={e.id}
          aria-disabled="true"
          aria-checked="false"
          tabIndex={-1}
        >
          {body}
          <span />
        </div>
      );
    // The full row (SIGN-IN §3.19, SwiftUI's layout): the title, then the pill, the count and the
    // tag on one line, then the meter and the meta, then its Replace a device.
    const fullBody = (
      <>
        {r.name ? (
          <span className="row-name" data-part="row-name">
            <bdi>{r.name}</bdi>
          </span>
        ) : null}
        <span className="row-line">
          <span className="pill">{r.tierName}</span>
          {r.seats.limit !== null && has("signin.choice.devices") ? (
            <span className="row-title num">
              {text(c, "signin.choice.devices", {
                used: r.seats.used,
                limit: r.seats.limit,
              })}
            </span>
          ) : null}
          {tag("signin.choice.tag.full")}
          {r.current ? tag("signin.choice.tag.current") : null}
        </span>
        {r.seats.limit !== null
          ? seatMeter(c, r.seats.used, r.seats.limit, false)
          : null}
        {meta ? <span className="meta">{meta}</span> : null}
      </>
    );
    return (
      <div
        key={e.id}
        className="row"
        role="group"
        data-part="license-row"
        data-layout="full"
        data-id={e.id}
        aria-label={r.name ?? r.tierName}
      >
        {fullBody}
        {replaceHere ? (
          button(c, "signin.replace.open", lone ? "primary" : "secondary", {
            detail: { licenseId: r.id },
            // Replace in the browser leaves the app.
            external: c.input.signIn?.replace === "browser",
          })
        ) : (
          <span />
        )}
      </div>
    );
  };
  return (
    <div
      className="list pk-stagger"
      role={allFull ? "group" : "radiogroup"}
      aria-label={
        has("signin.choice.group") ? plain(c, "signin.choice.group") : ""
      }
      data-part="license-list"
      data-scroll=""
      data-key={has("signin.choice.group") ? "signin.choice.group" : undefined}
    >
      {entries.map(rowFor)}
    </div>
  );
}

/** The ctx a part draws the license step and the sign-in frame with: the base anatomy of each
 *  (the review's "additive" rule) and the list. Any other component passes through unchanged. */
export function withChoice(ctx: KitCtx): KitCtx {
  const has = (k: string) => ctx.copy.has(k);
  const view = adaptSignIn(
    adaptChoice(ctx.view, ctx.input, has),
    ctx.input,
    ctx.input.signIn?.presentation === "sheet",
    has,
  );
  return { ...ctx, view, licenseRows };
}
