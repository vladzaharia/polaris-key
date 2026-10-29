/**
 * RuleEditor (ST-32.7; mockup `admin.sso-rules`): the one editor for an access rule, built once for
 * Platform → Members → SSO rules and reused by the product Access page (LX-36) and P2-10. A rule
 * reads as a sentence: "When someone signs in with <connection> and has <a group | a verified
 * email domain | a claim>, they get <Product admin on a product, with areas | Console access>".
 * Exactly one matcher. Below it, a live preview of who the draft would match (the Worker's one
 * matcher, `POST /access/rules/preview`).
 *
 * The editor saves nothing. It hands the finished rule to `onSave`; the page asks for the
 * confirmation, the reason and the sign-in the Worker requires. What may be offered is the
 * Worker's too: only operator connections arrive in `connections`, and a domain is offered only
 * when that connection has verified and enforced it.
 */

import * as React from "react";
import { AtSign, IdCard, Users } from "lucide-react";
import type {
  AccessRuleBody,
  AreaId,
  Me,
  RuleConnection,
  RulePreview,
} from "../../api.js";
import { Button } from "../../ui/Button.js";
import { Callout } from "../../ui/Callout.js";
import { Input } from "../../ui/Input.js";
import { Select } from "../../ui/Select.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { mutate } from "../data/mutations.js";
import { AREA_NAMES, listOf } from "./can.js";
import { AreaChecks, useOfferedAreas } from "./InviteDrawerParts.js";
import { PRODUCT_AREAS } from "./membersModel.js";

export type MatchKind = "group" | "domain" | "claim";
type Role = "product_admin" | "console_access";

interface Draft {
  connection: string;
  kind: MatchKind;
  group: string;
  domain: string;
  claimName: string;
  claimValue: string;
  role: Role;
  product: string;
  areas: AreaId[];
}

/** Every area but Members by default: granting Members is asked for by name. */
const DEFAULT_AREAS = PRODUCT_AREAS.filter((a) => a !== "members");

function draftOf(
  rule: AccessRuleBody | null | undefined,
  connections: readonly RuleConnection[],
  products: readonly { slug: string }[],
): Draft {
  const base: Draft = {
    connection: connections[0]?.id ?? "",
    kind: "group",
    group: "",
    domain: "",
    claimName: "",
    claimValue: "",
    role: "product_admin",
    product: products[0]?.slug ?? "",
    areas: [...DEFAULT_AREAS],
  };
  if (!rule) return base;
  const w = rule.when;
  const d: Draft = { ...base, connection: w.connection };
  if ("group" in w) Object.assign(d, { kind: "group", group: w.group });
  else if ("domain" in w)
    Object.assign(d, { kind: "domain", domain: w.domain });
  else
    Object.assign(d, {
      kind: "claim",
      claimName: w.claim.name,
      claimValue: w.claim.equals,
    });
  d.role = rule.grant.role;
  if (rule.grant.role === "product_admin") {
    d.product = rule.grant.scope.replace(/^product:/, "");
    d.areas = [...(rule.grant.areas ?? [])];
  }
  return d;
}

/** The rule a draft describes, or `null` while a field is missing. Keeps the stored id and label. */
function ruleOf(
  d: Draft,
  keep?: Pick<AccessRuleBody, "id" | "label"> | null,
): AccessRuleBody | null {
  if (d.connection === "") return null;
  let when: AccessRuleBody["when"];
  if (d.kind === "group") {
    if (d.group.trim() === "") return null;
    when = { connection: d.connection, group: d.group.trim() };
  } else if (d.kind === "domain") {
    if (d.domain === "") return null;
    when = { connection: d.connection, domain: d.domain };
  } else {
    if (d.claimName.trim() === "" || d.claimValue.trim() === "") return null;
    when = {
      connection: d.connection,
      claim: { name: d.claimName.trim(), equals: d.claimValue.trim() },
    };
  }
  const head = {
    ...(keep?.id ? { id: keep.id } : {}),
    ...(keep?.label ? { label: keep.label } : {}),
  };
  if (d.role === "console_access")
    return {
      ...head,
      when,
      grant: { role: "console_access", scope: "platform" },
    };
  if (d.product === "" || d.areas.length === 0) return null;
  return {
    ...head,
    when,
    grant: {
      role: "product_admin",
      scope: `product:${d.product}`,
      areas: PRODUCT_AREAS.filter((a) => d.areas.includes(a)),
    },
  };
}

/** "Group release-managers" for a rule's When cell. */
export function whenWords(w: AccessRuleBody["when"]): {
  kind: string;
  value: string;
} {
  if ("group" in w) return { kind: "Group", value: w.group };
  if ("domain" in w) return { kind: "Email domain", value: w.domain };
  return { kind: "Claim", value: `${w.claim.name} is ${w.claim.equals}` };
}

const KIND_OPTIONS = [
  { value: "group", label: "A group" },
  { value: "domain", label: "A verified email domain" },
  { value: "claim", label: "A claim" },
] as const;

const ROLE_OPTIONS = [
  { value: "product_admin", label: "Product admin" },
  { value: "console_access", label: "Console access" },
];

const KIND_ICON = { group: Users, domain: AtSign, claim: IdCard } as const;
export const MATCH_ICON = KIND_ICON;

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: RulePreview }
  | { status: "error" };

/** The preview of the current draft, a beat after the last edit. */
function usePreview(
  rule: AccessRuleBody | null,
  run: (rule: AccessRuleBody) => Promise<RulePreview>,
): PreviewState {
  const [state, setState] = React.useState<PreviewState>({ status: "idle" });
  const key = rule
    ? JSON.stringify({ when: rule.when, grant: rule.grant })
    : "";
  React.useEffect(() => {
    if (!rule) {
      setState({ status: "idle" });
      return;
    }
    let live = true;
    setState({ status: "loading" });
    const t = setTimeout(() => {
      run({ when: rule.when, grant: rule.grant })
        .then((data) => live && setState({ status: "ok", data }))
        .catch(() => live && setState({ status: "error" }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // The key stands for the rule's content; `run` is stable for a page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

export interface RuleEditorProps {
  /** Operator connections only: the Worker refuses any other. */
  connections: readonly RuleConnection[];
  products: readonly { slug: string; name: string }[];
  me: Me | undefined;
  /** The rule being edited; absent for a new one. */
  initial?: AccessRuleBody | null;
  onCancel: () => void;
  onSave: (rule: AccessRuleBody) => void;
  /** Overrides the default preview call (the product Access page asks its own scope). */
  preview?: (rule: AccessRuleBody) => Promise<RulePreview>;
  saveLabel?: string;
  /** The heading; "Edit rule" or "New rule" by default. */
  title?: string;
  /** The match and the product are fixed (a conversion offer): only the connection and areas change. */
  lockMatch?: boolean;
}

export function RuleEditor({
  connections,
  products,
  me,
  initial,
  onCancel,
  onSave,
  preview,
  saveLabel = "Save rule…",
  title,
  lockMatch = false,
}: RuleEditorProps): React.ReactElement {
  const [d, setD] = React.useState<Draft>(() =>
    draftOf(initial, connections, products),
  );
  const set = (over: Partial<Draft>): void => setD((x) => ({ ...x, ...over }));
  const conn = connections.find((c) => c.id === d.connection);
  const domains = conn?.domains ?? [];
  const rule = ruleOf(d, initial);
  const run =
    preview ?? ((r: AccessRuleBody) => mutate("previewAccessRule", r));
  const result = usePreview(rule, run);
  const { offered, missing } = useOfferedAreas(
    d.role === "product_admin" ? d.product : "",
  );
  const productName = (slug: string) =>
    products.find((p) => p.slug === slug)?.name ?? slug;

  const pickConnection = (id: string): void => {
    const next = connections.find((c) => c.id === id);
    const had = next?.domains ?? [];
    set({
      connection: id,
      domain: had.includes(d.domain) ? d.domain : (had[0] ?? ""),
      kind: d.kind === "domain" && had.length === 0 ? "group" : d.kind,
    });
  };
  const pickKind = (k: MatchKind): void =>
    set({
      kind: k,
      ...(k === "domain" && !d.domain ? { domain: domains[0] ?? "" } : {}),
    });

  const noDomains = domains.length === 0;
  return (
    <section
      className="rounded-lg border border-border bg-surface-raised"
      aria-labelledby="rule-editor-title"
      data-rule-editor=""
    >
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <h2
          id="rule-editor-title"
          className="text-base font-semibold text-fg-strong"
        >
          {title ?? (initial ? "Edit rule" : "New rule")}
        </h2>
      </div>
      <div className="grid gap-x-10 gap-y-6 px-4 py-5 sm:px-6 min-[1000px]:grid-cols-2">
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            When someone
          </legend>
          <Field label="Signs in with" id="rule-connection">
            <Select
              id="rule-connection"
              value={d.connection}
              onChange={(v) => v && pickConnection(v)}
              options={connections.map((c) => ({
                value: c.id,
                label: c.label,
              }))}
              placeholder="No operator connection"
            />
          </Field>
          <Field label="And has" id="rule-kind">
            <SegmentedControl<MatchKind>
              id="rule-kind"
              aria-label="Match on"
              size="sm"
              wrap
              className="flex w-full [&>[role=radio]]:flex-1"
              value={d.kind}
              onChange={pickKind}
              options={KIND_OPTIONS.map((o) => ({
                ...o,
                disabled: lockMatch || (o.value === "domain" && noDomains),
              }))}
            />
          </Field>
          {d.kind === "group" ? (
            <Field label="Group" id="rule-group">
              <Input
                id="rule-group"
                mono
                value={d.group}
                disabled={lockMatch}
                maxLength={256}
                placeholder="release-managers"
                onValueChange={(v) => set({ group: v })}
              />
            </Field>
          ) : d.kind === "domain" ? (
            <Field label="Domain" id="rule-domain">
              <Select
                id="rule-domain"
                value={d.domain}
                onChange={(v) => v && set({ domain: v })}
                options={domains.map((x) => ({ value: x, label: x }))}
                placeholder="Choose a domain"
              />
            </Field>
          ) : (
            <Field label="Claim" id="rule-claim-name">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="rule-claim-name"
                  mono
                  aria-label="Claim name"
                  className="min-w-0 flex-1"
                  value={d.claimName}
                  maxLength={128}
                  placeholder="department"
                  onValueChange={(v) => set({ claimName: v })}
                />
                <span className="text-sm text-fg-muted">is</span>
                <Input
                  mono
                  aria-label="Claim value"
                  className="min-w-0 flex-1"
                  value={d.claimValue}
                  maxLength={256}
                  placeholder="djdl-qa"
                  onValueChange={(v) => set({ claimValue: v })}
                />
              </div>
            </Field>
          )}
          {noDomains && conn ? (
            <p className="text-xs text-fg-muted">
              A domain needs to be verified and enforced on {conn.label}.
            </p>
          ) : null}
        </fieldset>
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            They get
          </legend>
          <Field label="Role" id="rule-role">
            <Select
              id="rule-role"
              value={d.role}
              disabled={lockMatch}
              onChange={(v) => v && set({ role: v as Role })}
              options={ROLE_OPTIONS}
            />
          </Field>
          {d.role === "product_admin" ? (
            <>
              <Field label="Product" id="rule-product">
                <Select
                  id="rule-product"
                  value={d.product}
                  disabled={lockMatch}
                  onChange={(v) =>
                    v && set({ product: v, areas: [...DEFAULT_AREAS] })
                  }
                  options={products.map((p) => ({
                    value: p.slug,
                    label: p.name,
                  }))}
                  placeholder="Choose a product"
                />
              </Field>
              <div className="space-y-1.5">
                <span className="block text-sm font-medium text-fg-strong">
                  Areas
                </span>
                <AreaChecks
                  me={me}
                  slug={d.product}
                  offered={offered}
                  areas={d.areas}
                  onChange={(areas) => set({ areas })}
                  legend="Areas they get"
                  offNote={`Off for ${productName(d.product)}`}
                />
                {missing.length > 0 ? (
                  <p className="text-xs text-fg-muted">
                    {listOf(missing.map((a) => AREA_NAMES[a]))}{" "}
                    {missing.length === 1 ? "is" : "are"} off for{" "}
                    {productName(d.product)}.
                  </p>
                ) : null}
                {d.areas.includes("members") ? (
                  <p className="text-xs text-warning">
                    Members lets them change who has access to the product.
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-fg-muted">
              They can open the console. They see only what they are given.
            </p>
          )}
        </fieldset>
        <div className="min-w-0 min-[1000px]:col-span-2">
          <Preview state={result} rule={rule} productName={productName} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-6">
        <span className="me-auto text-xs text-fg-muted">
          Saving asks you to confirm.
        </span>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!rule}
          disabledReason={rule ? undefined : "Fill in every field first."}
          onClick={() => rule && onSave(rule)}
        >
          {saveLabel}
        </Button>
      </div>
    </section>
  );
}

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg-strong">
        {label}
      </label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function grantWords(
  g: RulePreview["members"][number]["grant"],
  productName: (slug: string) => string,
): string {
  if (g.role === "console_access") return "Console access";
  const slug = g.scope.replace(/^product:/, "");
  const areas = g.areas
    ? ` · ${listOf(g.areas.map((a) => AREA_NAMES[a] ?? a))}`
    : "";
  return `${productName(slug)} admin${areas}`;
}

function Preview({
  state,
  rule,
  productName,
}: {
  state: PreviewState;
  rule: AccessRuleBody | null;
  productName: (slug: string) => string;
}): React.ReactElement {
  let body: React.ReactNode;
  let title: string;
  if (!rule || state.status === "idle") {
    title = "Who it matches";
    body = (
      <p className="text-sm text-fg-muted">
        Fill in the rule to see who it matches.
      </p>
    );
  } else if (state.status === "loading") {
    title = "Who it matches";
    body = <p className="text-sm text-fg-muted">Checking…</p>;
  } else if (state.status === "error") {
    title = "Who it matches";
    body = (
      <Callout tone="warning" live>
        Couldn&apos;t check who it matches. You can still save.
      </Callout>
    );
  } else {
    const p = state.data;
    const other = p.otherLinks ?? 0;
    title =
      p.matchedMembers === 0
        ? "Nobody matches yet"
        : `Matches ${p.matchedMembers} ${p.matchedMembers === 1 ? "person" : "people"}`;
    body = (
      <div className="space-y-3">
        {p.members.length > 0 ? (
          <ul className="divide-y divide-border" data-testid="rule-matches">
            {p.members.map((m) => (
              <li
                key={m.memberId}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="font-medium text-fg-strong">
                    {m.name || m.email}
                  </span>
                  {m.name ? (
                    <span className="ms-2 text-xs text-fg-muted">
                      {m.email}
                    </span>
                  ) : null}
                </span>
                <span className="text-fg-muted">
                  Gets {grantWords(m.grant, productName)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {other > 0 ? (
          <p className="text-sm text-fg-muted">
            {other} {other === 1 ? "other person" : "other people"} who signed
            in with this connection would get it at their next sign-in.
          </p>
        ) : p.matchedMembers === 0 ? (
          <p className="text-sm text-fg-muted">
            It applies at the next sign-in of anyone who matches.
          </p>
        ) : null}
        {p.truncated ? (
          <p className="text-xs text-fg-muted">
            The list is cut; more people may match.
          </p>
        ) : null}
        {p.incomplete ? (
          <p className="text-xs text-fg-muted">
            Some people couldn&apos;t be listed.
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <section
      aria-labelledby="rule-preview-title"
      aria-live="polite"
      className="rounded-md border border-border bg-surface px-4 py-3"
      data-rule-preview=""
    >
      <h3
        id="rule-preview-title"
        className="mb-2 text-sm font-semibold text-fg-strong"
      >
        {title}
      </h3>
      {body}
    </section>
  );
}
