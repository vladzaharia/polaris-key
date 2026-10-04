/**
 * The form layer (docs/design/admin/components.md §3.1–§3.2): react-hook-form behind three names,
 * so views never touch the library.
 *
 * - `useAdminForm({ values, resetOn, onSubmit, mapServerErrors })` seeds a draft from the server's
 *   values and **re-seeds only while the draft is clean** (fixes MPE-1, UPS-2, UHL-4: a refetch or
 *   focus refresh never wipes an edit). When the server's identity (`resetOn`, or the values
 *   themselves) moves while the draft is dirty, nothing is overwritten: `serverChanged` turns on
 *   and the page offers "Review changes" / "Discard mine" (`acceptServer`, `keepMine`).
 * - `<Form form>` is a `noValidate` `<form>` that submits through the hook.
 * - `<FormField name label help required>{(field) => control}</FormField>` hands `id`, `value`,
 *   `onChange`, `onBlur`, `ref` and the `aria-*` wiring to ANY control through a render prop,
 *   Radix Select's trigger included (fixes UI-6, SCF-1). Outside a `Form` it works controlled.
 * - `diffValues(server, draft)` is the minimal PATCH body, with `null` for a cleared nullable
 *   field (fixes TIR-1, LDT-2, PRD-6 at the client).
 *
 * After a failed submit focus moves to the first invalid field (ADMIN.md §5.6), and the server's
 * `ApiError.fields` land on the matching fields.
 */

import * as React from "react";
import {
  Controller,
  useForm,
  type FieldValues,
  type Path,
  type RegisterOptions,
  type UseFormReturn,
} from "react-hook-form";
import { AlertCircle } from "lucide-react";
import { ApiError } from "../api.js";
import { cn } from "../lib/cn.js";

// ── diff ───────────────────────────────────────────────────────────────────────────────────────

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Is a draft value "cleared" (blank text, `null`, `undefined`)? */
function isCleared(v: unknown): boolean {
  return (
    v === null || v === undefined || (typeof v === "string" && v.trim() === "")
  );
}

/**
 * The minimal PATCH body: only the keys whose draft value differs from the server's. A key in
 * `nullable` whose draft is cleared is sent as `null` (the server's "use the default"), never
 * dropped and never `""`/`0`.
 */
export function diffValues<T extends Record<string, unknown>>(
  server: T,
  draft: T,
  opts: { nullable?: readonly (keyof T)[] } = {},
): Partial<{ [K in keyof T]: T[K] | null }> {
  const out: Partial<{ [K in keyof T]: T[K] | null }> = {};
  const nullable = new Set(opts.nullable ?? []);
  const keys = new Set<keyof T>([
    ...(Object.keys(server) as (keyof T)[]),
    ...(Object.keys(draft) as (keyof T)[]),
  ]);
  for (const key of keys) {
    const before = server[key];
    let after: T[keyof T] | null = draft[key];
    if (nullable.has(key) && isCleared(after)) after = null;
    const beforeNorm = nullable.has(key) && isCleared(before) ? null : before;
    if (!same(beforeNorm, after)) out[key] = after;
  }
  return out;
}

// ── useAdminForm ───────────────────────────────────────────────────────────────────────────────

/** Field errors keyed by field name. */
export type FieldErrorMap = Record<string, string>;

export interface AdminFormOptions<T extends FieldValues> {
  /** The server's values. Re-seeds the draft only while it is clean. */
  values: T;
  /**
   * The server identity ("server changed under you"), e.g. `[license.modifiedAt]`. Without it the
   * values themselves (deep-compared) are the identity, so an identical refetch changes nothing.
   */
  resetOn?: readonly unknown[];
  onSubmit: (values: T, ctx: { server: T }) => unknown | Promise<unknown>;
  /**
   * Map a submit error onto fields. The default maps an `ApiError`'s `fields` to "Check this
   * value." on each named field. Return `null` to show the error only in the summary.
   */
  mapServerErrors?: (error: unknown) => FieldErrorMap | null;
  /** Client validation run before submit: field name → message. */
  validate?: (values: T) => FieldErrorMap;
}

export interface AdminForm<T extends FieldValues> {
  /** The underlying react-hook-form instance (for the form layer's own components). */
  rhf: UseFormReturn<T>;
  /** The values the draft is compared against. */
  server: T;
  isDirty: boolean;
  /** How many fields differ from the server's values. */
  dirtyCount: number;
  /** The names of the fields that differ. */
  dirtyFields: string[];
  isSubmitting: boolean;
  /** At least one submit was attempted (errors then announce with role="alert"). */
  submitted: boolean;
  /** The last submit's error, or `null`. */
  submitError: unknown;
  /** Current field errors. */
  errors: FieldErrorMap;
  /** The server's values moved while the draft was dirty. */
  serverChanged: boolean;
  /** The server values that arrived while dirty (for a "Review changes" diff). */
  incoming: T | null;
  /** Take the server's new values (discarding the draft). */
  acceptServer: () => void;
  /** Keep the draft; it is now compared against the server's new values. */
  keepMine: () => void;
  /** Validate and submit. Resolves when done (success or failure). */
  submit: () => Promise<void>;
  /** Throw the draft away (back to the server's values). */
  discard: () => void;
  /** Focus a field by name. */
  focus: (name: string) => void;
  /** Field labels registered by `FormField`, for the SaveBar's error summary. */
  labels: React.RefObject<Map<string, string>>;
  /** The `<form>` element, once `Form` mounts. */
  element: React.RefObject<HTMLFormElement | null>;
}

function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj === true) return [prefix];
  if (Array.isArray(obj)) {
    return obj.some((v) => v === true || (v && typeof v === "object"))
      ? [prefix]
      : [];
  }
  if (obj && typeof obj === "object") {
    return Object.entries(obj).flatMap(([k, v]) =>
      leafPaths(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [];
}

function defaultServerErrors(error: unknown): FieldErrorMap | null {
  if (error instanceof ApiError && error.fields?.length) {
    return Object.fromEntries(
      error.fields.map((f) => [f, "Check this value."]),
    );
  }
  return null;
}

export function useAdminForm<T extends FieldValues>(
  opts: AdminFormOptions<T>,
): AdminForm<T> {
  const { values, resetOn, onSubmit, mapServerErrors, validate } = opts;
  const rhf = useForm<T>({
    // react-hook-form's DefaultValues type is a deep partial of T.
    defaultValues: values as never,
    mode: "onSubmit",
    reValidateMode: "onChange",
    shouldFocusError: true,
  });
  const [server, setServer] = React.useState<T>(values);
  const [incoming, setIncoming] = React.useState<T | null>(null);
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const labels = React.useRef(new Map<string, string>());
  const element = React.useRef<HTMLFormElement | null>(null);

  const identity = JSON.stringify(resetOn ?? values);
  const lastIdentity = React.useRef(identity);
  const { isDirty, dirtyFields, isSubmitting, submitCount, errors } =
    rhf.formState;

  React.useEffect(() => {
    if (identity === lastIdentity.current) return;
    lastIdentity.current = identity;
    if (!rhf.formState.isDirty) {
      setServer(values);
      setIncoming(null);
      rhf.reset(values);
    } else {
      setIncoming(values);
    }
    // `values` is read through `identity`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  const acceptServer = React.useCallback(() => {
    const next = incoming ?? values;
    setServer(next);
    setIncoming(null);
    rhf.reset(next);
  }, [incoming, values, rhf]);

  const keepMine = React.useCallback(() => {
    if (!incoming) return;
    const draft = rhf.getValues();
    setServer(incoming);
    setIncoming(null);
    // New baseline, same draft: the draft stays dirty against the new server values.
    rhf.reset(incoming, { keepValues: false });
    for (const [k, v] of Object.entries(draft)) {
      rhf.setValue(k as Path<T>, v as never, { shouldDirty: true });
    }
  }, [incoming, rhf]);

  const focus = React.useCallback(
    (name: string) => {
      try {
        rhf.setFocus(name as Path<T>);
      } catch {
        // an unregistered field (no ref): nothing to focus
      }
    },
    [rhf],
  );

  const submit = React.useCallback(async () => {
    setSubmitError(null);
    rhf.clearErrors();
    const draft = rhf.getValues();
    const clientErrors = validate?.(draft) ?? {};
    const clientNames = Object.keys(clientErrors);
    let ok = false;
    await rhf.handleSubmit(
      async (v) => {
        if (clientNames.length) return;
        try {
          await onSubmit(v, { server });
          ok = true;
        } catch (err) {
          setSubmitError(err);
          const mapped = (mapServerErrors ?? defaultServerErrors)(err);
          const names = Object.keys(mapped ?? {});
          for (const name of names) {
            rhf.setError(name as Path<T>, {
              type: "server",
              message: mapped![name],
            });
          }
          if (names[0]) focus(names[0]);
        }
      },
      () => undefined,
    )();
    if (clientNames.length) {
      for (const name of clientNames) {
        rhf.setError(name as Path<T>, {
          type: "validate",
          message: clientErrors[name],
        });
      }
      focus(clientNames[0]!);
    }
    if (ok) {
      // The submitted draft is the new baseline until the refetch arrives (then re-seeds clean).
      const saved = rhf.getValues();
      setServer(saved);
      setIncoming(null);
      rhf.reset(saved);
    }
  }, [rhf, validate, onSubmit, server, mapServerErrors, focus]);

  const discard = React.useCallback(() => {
    setSubmitError(null);
    const base = incoming ?? server;
    setServer(base);
    setIncoming(null);
    rhf.reset(base);
  }, [incoming, server, rhf]);

  const dirty = leafPaths(dirtyFields);
  const errorMap: FieldErrorMap = {};
  const collect = (obj: unknown, prefix = ""): void => {
    if (!obj || typeof obj !== "object") return;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.message === "string" && "type" in rec) {
      errorMap[prefix] = rec.message;
      return;
    }
    for (const [k, v] of Object.entries(rec)) {
      if (k === "ref" || k === "root") continue;
      collect(v, prefix ? `${prefix}.${k}` : k);
    }
  };
  collect(errors);

  return {
    rhf,
    server,
    isDirty: isDirty && dirty.length > 0,
    dirtyCount: dirty.length,
    dirtyFields: dirty,
    isSubmitting,
    submitted: submitCount > 0,
    submitError,
    errors: errorMap,
    serverChanged: incoming !== null,
    incoming,
    acceptServer,
    keepMine,
    submit,
    discard,
    focus,
    labels,
    element,
  };
}

// ── Form ───────────────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FormCtx = React.createContext<AdminForm<any> | null>(null);

/** The surrounding `Form`'s hook, or `null` outside one. */
export function useFormContext<T extends FieldValues>(): AdminForm<T> | null {
  return React.useContext(FormCtx);
}

export function Form<T extends FieldValues>({
  form,
  children,
  className,
  id,
  "aria-label": ariaLabel,
}: {
  form: AdminForm<T>;
  children: React.ReactNode;
  className?: string;
  id?: string;
  "aria-label"?: string;
}): React.ReactElement {
  return (
    <FormCtx.Provider value={form}>
      <form
        ref={form.element}
        id={id}
        aria-label={ariaLabel}
        noValidate
        className={className}
        onSubmit={(e) => {
          e.preventDefault();
          void form.submit();
        }}
      >
        {children}
      </form>
    </FormCtx.Provider>
  );
}

// ── FormField ──────────────────────────────────────────────────────────────────────────────────

/** What a `FormField` hands its control. Spread it onto the control. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface FieldControlProps<V = any> {
  id: string;
  name: string;
  value: V;
  /** Accepts a change event or the new value. */
  onChange: (valueOrEvent: unknown) => void;
  onBlur: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref: React.Ref<any>;
  readOnly?: boolean;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
  /** For group controls (RadioCards, SegmentedControl, ChannelPicker): the label's id. */
  "aria-labelledby"?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface FormFieldProps<V = any> {
  name: string;
  label: React.ReactNode;
  help?: React.ReactNode;
  required?: boolean;
  /** Client rules (react-hook-form `RegisterOptions`), inside a `Form` only. */
  rules?: Omit<RegisterOptions, "valueAsNumber" | "valueAsDate" | "setValueAs">;
  /**
   * The control is a group (radio cards, a segmented control, a checkbox group): the label is
   * not a `<label for>` but names the group through `aria-labelledby`.
   */
  group?: boolean;
  /** Trailing content beside the label (a SourceBadge). */
  labelAside?: React.ReactNode;
  className?: string;
  disabled?: boolean;
  // Controlled use outside a Form:
  value?: V;
  onChange?: (value: V) => void;
  error?: string;
  dirty?: boolean;
  /** Announce the error with role="alert" (outside a Form; inside, after a submit attempt). */
  announceError?: boolean;
  children: (field: FieldControlProps<V>) => React.ReactNode;
}

/** The value a change carries, from an event or a plain value. */
function valueOf(x: unknown): unknown {
  if (x && typeof x === "object" && "target" in x) {
    const t = (x as { target: HTMLInputElement }).target;
    if (t && typeof t === "object" && "value" in t) {
      return t.type === "checkbox" ? t.checked : t.value;
    }
  }
  return x;
}

function FieldFrame({
  id,
  label,
  help,
  required,
  group,
  labelAside,
  error,
  announce,
  dirty,
  className,
  children,
}: {
  id: string;
  label: React.ReactNode;
  help?: React.ReactNode;
  required?: boolean;
  group?: boolean;
  labelAside?: React.ReactNode;
  error?: string;
  announce: boolean;
  dirty: boolean;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const LabelTag = group ? "span" : "label";
  return (
    <div
      className={cn("flex flex-col gap-1.5", className)}
      data-field={id}
      role={group ? "group" : undefined}
      aria-labelledby={group ? `${id}-label` : undefined}
    >
      <div className="flex min-h-5 items-center justify-between gap-2">
        <LabelTag
          id={`${id}-label`}
          {...(group ? {} : { htmlFor: id })}
          className="flex items-center gap-1.5 text-sm font-bold text-fg-strong"
        >
          {label}
          {required ? (
            <span className="text-xs font-normal text-fg-subtle">Required</span>
          ) : null}
          {dirty ? (
            <span className="inline-flex items-center">
              <span aria-hidden className="size-1.5 rounded-full bg-accent" />
              <span className="sr-only">changed</span>
            </span>
          ) : null}
        </LabelTag>
        {labelAside}
      </div>
      {children}
      {help ? (
        <p id={`${id}-help`} className="text-xs text-fg-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        <p
          id={`${id}-error`}
          role={announce ? "alert" : undefined}
          className="flex items-start gap-1.5 text-xs text-danger"
        >
          <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(
  id: string,
  help: unknown,
  error: unknown,
): string | undefined {
  return (
    [help ? `${id}-help` : null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function FormField<V = any>(
  props: FormFieldProps<V>,
): React.ReactElement {
  const form = useFormContext();
  const reactId = React.useId();
  const id = `f-${props.name.replace(/[^\w-]/g, "-")}-${reactId.replace(/:/g, "")}`;
  const labelText = typeof props.label === "string" ? props.label : props.name;

  React.useEffect(() => {
    if (!form) return;
    const map = form.labels.current;
    map.set(props.name, labelText);
    return () => {
      map.delete(props.name);
    };
  }, [form, props.name, labelText]);

  if (!form) {
    const error = props.error;
    return (
      <FieldFrame
        id={id}
        label={props.label}
        help={props.help}
        required={props.required}
        group={props.group}
        labelAside={props.labelAside}
        error={error}
        announce={Boolean(props.announceError)}
        dirty={Boolean(props.dirty)}
        className={props.className}
      >
        {props.children({
          id,
          name: props.name,
          value: props.value as V,
          onChange: (x) => props.onChange?.(valueOf(x) as V),
          onBlur: () => undefined,
          ref: () => undefined,
          disabled: props.disabled,
          "aria-describedby": describedBy(id, props.help, error),
          "aria-invalid": error ? true : undefined,
          "aria-required": props.required ? true : undefined,
          "aria-labelledby": props.group ? `${id}-label` : undefined,
        })}
      </FieldFrame>
    );
  }

  return (
    <Controller
      control={form.rhf.control}
      name={props.name}
      rules={props.rules as never}
      render={({ field, fieldState }) => {
        const error = fieldState.error?.message ?? form.errors[props.name];
        return (
          <FieldFrame
            id={id}
            label={props.label}
            help={props.help}
            required={props.required}
            group={props.group}
            labelAside={props.labelAside}
            error={error}
            announce={form.submitted}
            dirty={fieldState.isDirty}
            className={props.className}
          >
            {props.children({
              id,
              name: field.name,
              value: field.value as V,
              onChange: (x) => field.onChange(valueOf(x)),
              onBlur: field.onBlur,
              ref: field.ref,
              readOnly: form.isSubmitting || undefined,
              disabled: props.disabled,
              "aria-describedby": describedBy(id, props.help, error),
              "aria-invalid": error ? true : undefined,
              "aria-required": props.required ? true : undefined,
              "aria-labelledby": props.group ? `${id}-label` : undefined,
            })}
          </FieldFrame>
        );
      }}
    />
  );
}
