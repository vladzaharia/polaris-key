import * as React from "react";
import { Catalog, type ProductCatalog } from "@polaris-key/catalog";
import { CircleHelp, RotateCcw, X } from "lucide-react";
import type { ConfigEntry, ManagementState } from "./api.js";
import { cn } from "./lib/cn.js";
import { docsUrl } from "./lib/docsLinks.js";
import {
  Badge,
  Button,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from "./components/ui/index.js";

/**
 * Schema-driven form fields — the ONE place the console turns a catalog `ConfigEntry` into an
 * editor. `SchemaField` picks the control from the JSON-Schema fragment (boolean → Switch,
 * enum → Select, integer/number → number input with min/max/step, array/object → a JSON
 * textarea, string → text/password/textarea) and reports validity per keystroke.
 * `ManagedField` wraps that with the v2 management-state control, the set/unset affordance and
 * the `updatedAt` stamp — one row, shared verbatim by profile payloads and license overrides.
 *
 * ── VALIDATION IS THE SERVER'S, NOT A LOOKALIKE ──────────────────────────────────────────────
 *
 * This module used to carry a hand-written Draft-07 subset (type/enum/minimum/maximum/
 * minLength/maxLength/pattern). It could not see `format`, `const`, `multipleOf`, `items`,
 * `properties`, `required`, `uniqueItems` or any combinator, so an array/object entry — or a
 * `format: "uri"` string — validated as "fine" here and came back 422 from the worker. It also
 * had to be kept in step with `shared-catalog` by hand.
 *
 * `@polaris-key/catalog` is workerd-safe *because* it interprets schemas instead of compiling
 * them (no `Function` constructor), which is exactly what makes it importable in a browser too.
 * So the console now runs `Catalog#validateEntryValue` — byte-for-byte the call
 * `admin/lib/overrides.ts` makes server-side. A value this file accepts is a value the PUT
 * accepts, and the message an operator reads inline is the message the 422 would have carried.
 *
 * `pattern` is still matched by the linear-time NFA in `shared-catalog/src/regex.ts` rather than
 * the host `RegExp`: a catalog `pattern` is operator-supplied and can reach us from `.pkey/` in
 * a linked repo via a webhook resync with no review step, and the eight-character `(x+x+)+y`
 * takes V8 ~54 s on a 41-character input — a frozen console tab. Getting that for free is one
 * more reason not to keep a second validator here.
 */

export interface FieldResult {
  value: unknown;
  valid: boolean;
  error?: string;
}

// ── the validator ────────────────────────────────────────────────────────────

/**
 * One `Catalog` per `ProductCatalog` object. `Catalog` memoises each entry's *prepared* schema
 * internally (`analysed`), so sharing the instance across every row of an editor means each
 * fragment — including its compiled `pattern` — is analysed once per catalog load, not once per
 * keystroke. Keyed weakly so a product switch drops the whole thing.
 */
const CATALOGS = new WeakMap<ProductCatalog, Catalog>();

export function catalogFor(catalog: ProductCatalog): Catalog {
  let hit = CATALOGS.get(catalog);
  if (!hit) {
    hit = new Catalog(catalog);
    CATALOGS.set(catalog, hit);
  }
  return hit;
}

/** React binding for `catalogFor` — stable for the lifetime of a loaded catalog. */
export function useCatalog(
  catalog: ProductCatalog | null | undefined,
): Catalog | null {
  return React.useMemo(() => (catalog ? catalogFor(catalog) : null), [catalog]);
}

/**
 * A single-entry `Catalog` for a bare schema fragment, so the entry-less `validate()` below
 * runs the identical code path (and gets the identical memoisation) as an entry does.
 */
const LOOSE = new WeakMap<object, Catalog>();

function looseCatalog(schema: Record<string, unknown>): Catalog {
  let hit = LOOSE.get(schema);
  if (!hit) {
    // An empty `key` makes `validateEntryValue`'s `${key}${instancePath} ${message}` come back
    // as a bare message, which is what an inline field error wants.
    hit = new Catalog({
      schemaVersion: 0,
      entries: [
        {
          key: "",
          kind: "config",
          category: "",
          label: "",
          description: "",
          schema,
        },
      ],
    });
    LOOSE.set(schema, hit);
  }
  return hit;
}

/**
 * `validateEntryValue` prefixes every message with the entry key so a 422 body can name the
 * offending key in a flat list. Inline, next to the control that already carries the label,
 * that prefix is noise — strip it, keeping any JSON-Pointer path (`/0`, `/host`) that follows.
 */
function stripKey(key: string, message: string): string {
  const rest = message.startsWith(key) ? message.slice(key.length) : message;
  return rest.trimStart() || message;
}

/**
 * Validate one catalog entry's value. `undefined` means "not set", which is never an error —
 * an absent key is how the payload says "this layer contributes nothing" (see `applyOverrides`,
 * which deletes rather than storing a blank). Returns the first message, or `null`.
 */
export function validateEntry(
  entry: ConfigEntry,
  value: unknown,
  catalog?: Catalog | null,
): string | null {
  if (value === undefined) return null;
  const cat = catalog ?? looseCatalog(entry.schema);
  const res = cat.validateEntryValue(entry, value);
  if (res.ok) return null;
  const first = res.errors[0] ?? "is not valid";
  return stripKey(entry.key, first);
}

/**
 * Validate a value against a bare schema fragment (no catalog entry to hand). Kept for callers
 * that hold a fragment rather than an entry; it is the same interpreter, not a second one.
 */
export function validate(
  schema: Record<string, unknown>,
  value: unknown,
): string | null {
  if (value === undefined) return null;
  const cat = looseCatalog(schema);
  const res = cat.validateEntryValue(cat.entries[0]!, value);
  return res.ok ? null : (res.errors[0] ?? "is not valid").trimStart();
}

// ── entry helpers ────────────────────────────────────────────────────────────

export const KIND_VARIANT: Record<string, "primary" | "warning" | "default"> = {
  config: "default",
  secret: "warning",
  flag: "primary",
};

const STATE_VARIANT: Record<
  ManagementState,
  "default" | "primary" | "warning"
> = {
  default: "default",
  enforced: "primary",
  hidden: "warning",
};

/** A write-only entry: its value never crosses the wire in either direction. */
export function isSecretEntry(entry: ConfigEntry): boolean {
  return entry.kind === "secret" || entry.secret === true;
}

/** What a client falls back to when no layer sets this key: the catalog's `default`, else the
 *  schema's own `default` annotation. `undefined` means "genuinely nothing". */
export function entryDefault(entry: ConfigEntry): unknown {
  if (entry.default !== undefined) return entry.default;
  return (entry.schema as { default?: unknown }).default;
}

/** Render any managed value compactly — for the ghosted default and the inherited line. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value === "" ? '""' : value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

/** The seed value used when an operator materialises a previously-unset row. */
export function initialValueFor(entry: ConfigEntry): unknown {
  const fallback = entryDefault(entry);
  if (fallback !== undefined) return fallback;
  const schema = entry.schema;
  if (schema.type === "boolean") return false;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === "integer" || schema.type === "number") {
    return typeof schema.minimum === "number" ? schema.minimum : 0;
  }
  if (schema.type === "array") return [];
  if (schema.type === "object") return {};
  return "";
}

type Widget =
  | "switch"
  | "select"
  | "number"
  | "json"
  | "textarea"
  | "password"
  | "text";

/**
 * Which control an entry gets. The JSON-Schema decides; `ui.widget` only breaks ties the schema
 * leaves open (a string that wants a textarea, a config key that wants masking) — a hint may
 * never contradict the type, or the control would emit values the server rejects.
 */
export function widgetFor(entry: ConfigEntry): Widget {
  const schema = entry.schema;
  const hint = entry.ui?.widget;
  if (schema.type === "boolean") return "switch";
  if (Array.isArray(schema.enum)) return "select";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "array" || schema.type === "object") return "json";
  if (isSecretEntry(entry) || hint === "password") return "password";
  if (hint === "textarea") return "textarea";
  return "text";
}

/**
 * An empty number box is "not set", not `NaN`. Anything else that will not parse is handed on
 * as the raw string so the catalog reports a type error the operator can read, rather than a
 * `NaN` that would serialise to `null`.
 */
function coerceNumber(raw: string): unknown {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? raw : n;
}

function numberStep(schema: Record<string, unknown>): number | "any" {
  if (typeof schema.multipleOf === "number") return schema.multipleOf;
  return schema.type === "integer" ? 1 : "any";
}

// ── the value control ────────────────────────────────────────────────────────

/**
 * The type-correct editor for one entry, wrapped in the console's `Field` so label, help,
 * `aria-describedby`, `aria-invalid` and the `role="alert"` error are wired the same way as
 * every other form in the console. Callers that draw their own header pass `label`/`labelAside`
 * nodes rather than re-implementing the accessibility plumbing.
 */
export function SchemaField({
  entry,
  value,
  onChange,
  disabled,
  catalog,
  label,
  labelAside,
  help,
  error: externalError,
  className,
}: {
  entry: ConfigEntry;
  value: unknown;
  onChange: (result: FieldResult) => void;
  disabled?: boolean;
  /** Share one `Catalog` across a whole editor so each fragment is analysed once. */
  catalog?: Catalog | null;
  label?: React.ReactNode;
  labelAside?: React.ReactNode;
  help?: React.ReactNode;
  /** A server-reported error for this key — shown in place of (and outranking) the local one. */
  error?: string;
  className?: string;
}): React.ReactElement {
  const schema = entry.schema;
  const localError = React.useMemo(
    () => validateEntry(entry, value, catalog),
    [entry, value, catalog],
  );
  const error = externalError ?? localError;

  const emit = (v: unknown): void => {
    const e = validateEntry(entry, v, catalog);
    onChange({ value: v, valid: e === null, error: e ?? undefined });
  };

  const widget = widgetFor(entry);
  let control: React.ReactElement;

  if (widget === "switch") {
    control = (
      <Switch
        aria-label={entry.label}
        checked={value === true}
        disabled={disabled}
        onCheckedChange={(checked) =>
          onChange({ value: checked === true, valid: true })
        }
      />
    );
  } else if (widget === "select") {
    const labels = entry.ui?.optionLabels ?? {};
    control = (
      <Select
        value={value == null ? "" : String(value)}
        disabled={disabled}
        onValueChange={(raw) => {
          // Round-trip through the declared enum so a numeric/boolean option keeps its type;
          // `<Select>` can only carry strings.
          const options = (schema.enum as unknown[] | undefined) ?? [];
          emit(options.find((o) => String(o) === raw) ?? raw);
        }}
      >
        <SelectTrigger aria-label={entry.label}>
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {((schema.enum as unknown[] | undefined) ?? []).map((opt) => (
            <SelectItem key={String(opt)} value={String(opt)}>
              {labels[String(opt)] ?? String(opt)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (widget === "number") {
    control = (
      <Input
        type="number"
        aria-label={entry.label}
        disabled={disabled}
        inputMode={schema.type === "integer" ? "numeric" : "decimal"}
        value={value === undefined || value === null ? "" : String(value)}
        min={typeof schema.minimum === "number" ? schema.minimum : undefined}
        max={typeof schema.maximum === "number" ? schema.maximum : undefined}
        step={numberStep(schema)}
        placeholder={entry.ui?.placeholder}
        onChange={(ev) => emit(coerceNumber(ev.target.value))}
      />
    );
  } else if (widget === "json") {
    control = (
      <JsonControl
        entry={entry}
        value={value}
        disabled={disabled}
        catalog={catalog}
        onChange={onChange}
      />
    );
  } else if (widget === "textarea") {
    control = (
      <Textarea
        aria-label={entry.label}
        disabled={disabled}
        rows={4}
        value={value == null ? "" : String(value)}
        placeholder={entry.ui?.placeholder}
        onChange={(ev) => emit(ev.target.value)}
      />
    );
  } else {
    control = (
      <Input
        type={widget === "password" ? "password" : "text"}
        aria-label={entry.label}
        disabled={disabled}
        autoComplete={widget === "password" ? "new-password" : undefined}
        spellCheck={widget === "password" ? false : undefined}
        value={value == null ? "" : String(value)}
        placeholder={entry.ui?.placeholder}
        onChange={(ev) => emit(ev.target.value)}
      />
    );
  }

  // `Field` clones its SINGLE child to inject `id`/`aria-describedby`/`aria-invalid`, so the
  // control has to BE that child. A `ui.unit` therefore rides in the label rather than in a
  // wrapper div, which would have taken the id and left the input unlabelled and never
  // `aria-invalid` — the exact plumbing this component exists to get right.
  const unit = entry.ui?.unit;
  const labelNode = unit ? (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      {label ?? entry.label}
      <span className="text-xs font-normal text-muted-foreground">
        ({unit})
      </span>
    </span>
  ) : (
    (label ?? entry.label)
  );

  return (
    <Field
      label={labelNode}
      help={help ?? (entry.description || undefined)}
      error={error ?? undefined}
      className={className}
      labelAside={
        labelAside ?? (
          <Badge variant={KIND_VARIANT[entry.kind] ?? "default"}>
            {entry.kind}
          </Badge>
        )
      }
    >
      {control}
    </Field>
  );
}

/**
 * The array/object editor.
 *
 * The *text* is local state, because the value and the text are not the same thing: a half-typed
 * `[1,` has no value, and pretty-printing every keystroke would fight the operator's cursor. A
 * parse failure reports `valid: false` — which disables Save — while leaving the stored value
 * exactly as it was, so a typo never blanks a key.
 *
 * The re-seed rule is the subtle part. The box must follow the value when the value changes for
 * an OUTSIDE reason (a save + reload, Discard, a revert to unset) and must NOT follow its own
 * echo, or the operator's text would be reformatted mid-edit. `JSON.parse` returns a fresh
 * object each time, so identity against the last value we emitted distinguishes the two exactly.
 */
function JsonControl({
  entry,
  value,
  disabled,
  catalog,
  onChange,
}: {
  entry: ConfigEntry;
  value: unknown;
  disabled?: boolean;
  catalog?: Catalog | null;
  onChange: (result: FieldResult) => void;
}): React.ReactElement {
  const serialised = React.useMemo(() => {
    if (value === undefined) return "";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
  }, [value]);
  const [text, setText] = React.useState(serialised);
  const emitted = React.useRef<unknown>(value);
  React.useEffect(() => {
    if (Object.is(value, emitted.current)) return; // our own echo
    emitted.current = value;
    setText(serialised);
  }, [value, serialised]);

  const publish = (result: FieldResult): void => {
    emitted.current = result.value;
    onChange(result);
  };

  return (
    <Textarea
      aria-label={entry.label}
      disabled={disabled}
      rows={5}
      spellCheck={false}
      value={text}
      placeholder={
        entry.ui?.placeholder ?? (entry.schema.type === "array" ? "[]" : "{}")
      }
      onChange={(ev) => {
        const next = ev.target.value;
        setText(next);
        if (next.trim() === "") {
          publish({ value: undefined, valid: true });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(next);
        } catch (err) {
          publish({
            value,
            valid: false,
            error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        const e = validateEntry(entry, parsed, catalog);
        publish({ value: parsed, valid: e === null, error: e ?? undefined });
      }}
    />
  );
}

// ── management state ─────────────────────────────────────────────────────────

/**
 * The three management states, worded from the protocol's own definition
 * (`@polaris-key/protocol` `ManagementState`) so the console cannot drift from the semantics
 * the SDKs implement.
 */
export const MANAGEMENT_STATES: {
  value: ManagementState;
  label: string;
  help: string;
}[] = [
  {
    value: "default",
    label: "Default",
    help: "The server's value is a default — the client may override it locally or by environment variable.",
  },
  {
    value: "enforced",
    label: "Enforced",
    help: "The server value wins; the client cannot override it and shows it read-only.",
  },
  {
    value: "hidden",
    label: "Hidden",
    help: "Enforced, and withheld from user-facing enumeration — still applied, never listed.",
  },
];

/**
 * A compact segmented control for the management state. A `radiogroup` rather than three
 * buttons: it is a single-choice control, so arrow keys move between options and only the
 * selected one is a tab stop (WAI-ARIA radio-group pattern), which is what the console's other
 * grouped controls do.
 */
export function ManagementStateControl({
  value,
  onChange,
  label,
  disabled,
}: {
  value: ManagementState;
  onChange: (next: ManagementState) => void;
  /** Accessible group name, e.g. `Management state for Theme`. */
  label: string;
  disabled?: boolean;
}): React.ReactElement {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, delta: number): void => {
    const next =
      (from + delta + MANAGEMENT_STATES.length) % MANAGEMENT_STATES.length;
    onChange(MANAGEMENT_STATES[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <div
        role="radiogroup"
        aria-label={label}
        className="inline-flex rounded-md border border-input bg-background p-0.5"
      >
        {MANAGEMENT_STATES.map((option, index) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              title={option.help}
              onClick={() => onChange(option.value)}
              onKeyDown={(ev) => {
                if (ev.key === "ArrowRight" || ev.key === "ArrowDown") {
                  ev.preventDefault();
                  move(index, 1);
                } else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
                  ev.preventDefault();
                  move(index, -1);
                }
              }}
              className={cn(
                "rounded-[calc(var(--pk-radius)-6px)] px-2.5 py-1 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-50",
                selected
                  ? "bg-primary text-primary-foreground shadow-pk-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <a
        href={docsUrl("managementStates")}
        target="_blank"
        rel="noreferrer"
        aria-label="Learn more about management states"
        title="Learn more about management states"
        className="text-muted-foreground hover:text-foreground"
      >
        <CircleHelp aria-hidden className="size-3.5" />
      </a>
    </span>
  );
}

function formatStamp(updatedAt?: number): string | null {
  if (!updatedAt) return null;
  try {
    return new Date(updatedAt * 1000).toLocaleString();
  } catch {
    return null;
  }
}

/** What a lower layer of the payload stack contributes for a key (license overrides only). */
export interface InheritedValue {
  /** Where it comes from, e.g. `profile “base”` or `catalog default`. */
  source: string;
  value: unknown;
  state: ManagementState;
}

// ── the row ──────────────────────────────────────────────────────────────────

/**
 * One managed key, end to end: header (catalog label, dotted key, kind + state badges), the
 * type-correct editor, the management-state segmented control, provenance, and — when the
 * caller opts in with `set`/`onSetChange` — the set/unset affordance.
 *
 * SET-VS-UNSET IS THE POINT. `applyOverrides` deletes a key whose update carries no value and
 * state `default`; anything else writes one. So "unset" is a real, representable state, not an
 * empty string, and the row says so: an absent key reads "Not set" with the fallback ghosted,
 * "Set value" materialises an editor, and ✕ takes it back to absent. Writing `""` to mean
 * "unset" would store a blank string the SDKs would faithfully hand to the app.
 *
 * Both consumers — profile payloads and license overrides — render this exact component; the
 * only thing overrides add is the `inherited` line.
 */
export function ManagedField({
  entry,
  value,
  state,
  updatedAt,
  onValueChange,
  onStateChange,
  set,
  onSetChange,
  catalog,
  error,
  dirty,
  secretConfigured,
  inherited,
  disabled,
}: {
  entry: ConfigEntry;
  value: unknown;
  state: ManagementState;
  updatedAt?: number;
  onValueChange: (result: FieldResult) => void;
  onStateChange: (state: ManagementState) => void;
  /** Omit for the always-editable legacy shape; pass it to get the set/unset affordance. */
  set?: boolean;
  onSetChange?: (set: boolean) => void;
  catalog?: Catalog | null;
  /** An error the row's owner computed (a JSON parse failure, a server 422) — outranks the
   *  fragment check so the operator sees the thing that actually blocked the save. */
  error?: string;
  dirty?: boolean;
  /** A secret with a stored value on the server. Its value is never sent, so never rendered. */
  secretConfigured?: boolean;
  inherited?: InheritedValue | null;
  disabled?: boolean;
}): React.ReactElement {
  const stamp = formatStamp(updatedAt);
  const secret = isSecretEntry(entry);
  // A configured secret starts masked: there is nothing to show (the API redacts it), and a
  // blank box next to "configured" reads as "no value stored", which is a lie.
  const [replacing, setReplacing] = React.useState(false);
  const managed = set !== false;
  const stateHelp = MANAGEMENT_STATES.find((s) => s.value === state)?.help;

  const header = (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="font-medium text-foreground">{entry.label}</span>
      <code className="font-mono text-xs font-normal text-muted-foreground">
        {entry.key}
      </code>
      {dirty ? (
        <span
          className="inline-block size-1.5 rounded-full bg-primary"
          aria-label="Modified"
        />
      ) : null}
    </span>
  );

  const badges = (
    <span className="flex shrink-0 flex-wrap items-center gap-1.5">
      <Badge variant={KIND_VARIANT[entry.kind] ?? "default"}>
        {entry.kind}
      </Badge>
      {managed ? <Badge variant={STATE_VARIANT[state]}>{state}</Badge> : null}
      {secret ? (
        <Badge variant={secretConfigured ? "success" : "outline"}>
          {secretConfigured ? "configured" : "not set"}
        </Badge>
      ) : null}
      {managed && onSetChange ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={disabled}
          aria-label={`Clear ${entry.label}`}
          title="Remove this key from the payload"
          onClick={() => {
            setReplacing(false);
            onSetChange(false);
          }}
        >
          <X aria-hidden />
        </Button>
      ) : null}
    </span>
  );

  const fallback = entryDefault(entry);

  if (!managed) {
    // ── the unset row ────────────────────────────────────────────────────────
    return (
      <div className="rounded-md border border-dashed border-border bg-card/20 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            {header}
            {entry.description ? (
              <p className="text-xs text-muted-foreground">
                {entry.description}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground/70">Not set</span>
              {inherited ? (
                <>
                  {" "}
                  — inherits {formatValue(inherited.value)} from{" "}
                  {inherited.source}.
                </>
              ) : fallback !== undefined ? (
                <> — clients fall back to {formatValue(fallback)}.</>
              ) : (
                <> — this key contributes nothing.</>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant={KIND_VARIANT[entry.kind] ?? "default"}>
              {entry.kind}
            </Badge>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onSetChange?.(true)}
            >
              Set value
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── the set row ────────────────────────────────────────────────────────────
  const maskedSecret = secret && secretConfigured && !replacing;

  return (
    <div
      className={cn(
        "space-y-3 rounded-md border bg-card/40 p-3 transition-colors",
        dirty ? "border-primary/50" : "border-border",
      )}
    >
      {maskedSecret ? (
        // The Input is `Field`'s direct child so the injected id/aria land on the control, not
        // on a layout wrapper; Replace sits after the field rather than inside it.
        <div className="space-y-2">
          <Field
            label={header}
            labelAside={badges}
            help="A value is stored. The server never returns it — replace it or leave it alone."
          >
            <Input
              type="password"
              readOnly
              aria-label={entry.label}
              value="••••••••••••"
              className="max-w-xs font-mono"
            />
          </Field>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setReplacing(true)}
          >
            Replace
          </Button>
        </div>
      ) : (
        <>
          <SchemaField
            entry={entry}
            value={value}
            disabled={disabled}
            catalog={catalog}
            onChange={onValueChange}
            label={header}
            labelAside={badges}
            error={error}
            help={
              secret
                ? "Write-only — the server never returns a stored secret."
                : entry.description || undefined
            }
          />
          {secret && secretConfigured && replacing ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setReplacing(false);
                onValueChange({ value: undefined, valid: true });
              }}
            >
              <RotateCcw aria-hidden />
              Keep the stored secret
            </Button>
          ) : null}
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border/60 pt-2.5">
        <div className="space-y-1">
          <ManagementStateControl
            value={state}
            disabled={disabled}
            label={`Management state for ${entry.label}`}
            onChange={onStateChange}
          />
          {stateHelp ? (
            <p className="max-w-prose text-xs text-muted-foreground">
              {stateHelp}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-0.5 text-xs text-muted-foreground">
          {inherited ? (
            <span>
              Overrides {formatValue(inherited.value)} from {inherited.source}
            </span>
          ) : null}
          {stamp ? <span>Updated {stamp}</span> : null}
        </div>
      </div>

      {/* `applyOverrides` deletes a key whose update carries no value and state `default`. For a
          secret the console has no value to resend, so choosing Default really does clear it —
          say so rather than letting the stored secret vanish on save. */}
      {secret && secretConfigured && state === "default" && !replacing ? (
        <p className="text-xs font-medium text-warning">
          Saving with “Default” removes the stored secret — the server keeps no
          value for an unmanaged key.
        </p>
      ) : null}
    </div>
  );
}
