import * as React from "react";
import { AlertCircle, ChevronRight } from "lucide-react";
import type {
  UserSettingConflict,
  UserSettingPolicy,
} from "@polaris-key/catalog";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { Select } from "../../../../ui/Select.js";
import { USER_CONFLICT_LABELS, USER_SCOPE_OPTIONS } from "./entryType.js";

type Json = Record<string, unknown>;

/**
 * The conflict policies a value type allows (plans/U-01b.md §2.2, R7): a number gets last write,
 * highest or lowest; an object (a set is an object of booleans) gets last write or merge; every
 * other type, a list included, gets last write only. `union` and `revision` are record policies.
 */
export function conflictOptionsFor(type: string): UserSettingConflict[] {
  if (type === "number" || type === "integer")
    return ["lastWrite", "max", "min"];
  if (type === "object") return ["lastWrite", "merge"];
  return ["lastWrite"];
}

/** A copy of `obj` with `field` set, or removed when `value` is empty. */
export function withField<T extends object>(
  obj: T,
  field: string,
  value: unknown,
): T {
  const next = { ...obj } as Record<string, unknown>;
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  ) {
    delete next[field];
  } else {
    next[field] = value;
  }
  return next as T;
}

export const numberOrUndefined = (raw: string): number | undefined => {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

/** `user` with no members is no block: an absent block means synced everywhere, last write. */
function compact(user: UserSettingPolicy): UserSettingPolicy | undefined {
  return Object.keys(user).length > 0 ? user : undefined;
}

/**
 * The entry's `user` block (plans/U-01b.md D2). Every Editable `config` key is a synced setting:
 * a person's choice, kept on the device and, with Cloud Sync on and the person signed in, synced.
 * The block only tunes it, so turning the Syncs switch off writes `user: {sync: "local"}` rather
 * than dropping the block (no block means "synced"). A catalog-locked key (`enforced` or `hidden`)
 * never syncs, and a block on it is a no-op: the publish route warns, and so does the form.
 */
export function UserSettingFields({
  user,
  type,
  locked,
  note,
  error,
  onChange,
}: {
  user: UserSettingPolicy | undefined;
  /** The schema's type, which decides the conflict policies on offer. */
  type: string;
  /** The key's management default locks it, so it never syncs. */
  locked: boolean;
  /** A non-blocking note from the publish route's checks. */
  note: string | undefined;
  error: string | undefined;
  onChange: (next: UserSettingPolicy | undefined) => void;
}): React.ReactElement {
  const u = user ?? {};
  const syncs = u.sync !== "local";
  const conflict = u.conflict ?? "lastWrite";
  const allowed = conflictOptionsFor(type);
  // A policy the type does not allow stays on offer, so the refusal below it can be read and fixed.
  const offered = allowed.includes(conflict) ? allowed : [...allowed, conflict];
  return (
    <div className="space-y-4">
      {locked ? (
        <p className="text-sm text-fg-muted">
          Locked keys never sync: people cannot change them.
        </p>
      ) : (
        <>
          <Checkbox
            label="Syncs across devices"
            description="With Cloud Sync on, a person's choice follows them to every device they sign in on. Off: it stays on the device."
            checked={syncs}
            onCheckedChange={(on) => {
              if (on) {
                const { sync: _local, ...rest } = u;
                onChange(compact(rest));
              } else {
                onChange({
                  sync: "local",
                  ...(u.listed === false ? { listed: false } : {}),
                });
              }
            }}
          />
          {syncs ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                name="user-sync"
                label="Syncs"
                value={u.sync ?? "user"}
              >
                {(f) => (
                  <Select
                    {...f}
                    value={u.sync ?? "user"}
                    options={USER_SCOPE_OPTIONS}
                    onChange={(v) =>
                      onChange(
                        compact(
                          withField(
                            u,
                            "sync",
                            v === "platform" ? "platform" : undefined,
                          ),
                        ),
                      )
                    }
                  />
                )}
              </FormField>
              {offered.length === 1 ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-fg-strong">
                    When two devices disagree
                  </p>
                  <p className="text-sm">{USER_CONFLICT_LABELS.lastWrite}</p>
                </div>
              ) : (
                <FormField
                  name="user-conflict"
                  label="When two devices disagree"
                  value={conflict}
                >
                  {(f) => (
                    <Select
                      {...f}
                      value={conflict}
                      options={offered.map((value) => ({
                        value,
                        label: USER_CONFLICT_LABELS[value],
                      }))}
                      onChange={(v) =>
                        onChange(
                          compact(
                            withField(
                              u,
                              "conflict",
                              v === "lastWrite" ? undefined : v,
                            ),
                          ),
                        )
                      }
                    />
                  )}
                </FormField>
              )}
            </div>
          ) : null}
        </>
      )}
      {note ? <p className="text-xs text-fg-muted">{note}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A collapsed group of the form: a native disclosure, so it needs no script to open and is
 * announced as expandable. LX-14's `combine` and `entitlementKind` selects join Validation.
 */
export function Group({
  title,
  open,
  onOpenChange,
  problem = false,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Something inside is wrong: the summary says so while the group is closed. */
  problem?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <details
      open={open}
      onToggle={(e) => onOpenChange(e.currentTarget.open)}
      className="group rounded-md border border-border"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-4 py-3 text-sm font-medium text-fg-strong focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-fg-muted transition-transform group-open:rotate-90"
        />
        <span className="flex-1">{title}</span>
        {problem && !open ? (
          <span className="inline-flex items-center gap-1 text-xs font-normal text-danger">
            <AlertCircle aria-hidden className="size-3" />
            Has a problem
          </span>
        ) : null}
      </summary>
      <div className="space-y-4 border-t border-border p-4">{children}</div>
    </details>
  );
}

export function NumberKeyword({
  name,
  label,
  schema,
  onChange,
}: {
  name: string;
  label: string;
  schema: Json;
  onChange: (field: string, value: unknown) => void;
}): React.ReactElement {
  const value = schema[name];
  return (
    <FormField name={name} label={label} value={value}>
      {(f) => (
        <Input
          {...f}
          type="number"
          value={typeof value === "number" ? String(value) : ""}
          onChange={(e) => onChange(name, numberOrUndefined(e.target.value))}
        />
      )}
    </FormField>
  );
}
