import * as React from "react";
import { RadioGroup } from "radix-ui";
import { cn } from "../lib/cn.js";
import { reducedMotion, tokenMs } from "./motion/reducedMotion.js";
import { useWriteLock } from "./WriteLock.js";

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: React.ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  /** 2–4 short options. */
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange?: (value: V) => void;
  size?: "sm" | "md";
  /** Labels wrap inside their segments instead of running off a narrow screen (200 % text). */
  wrap?: boolean;
  id?: string;
  name?: string;
  disabled?: boolean;
  /** Focusable but unchangeable (a locked or busy row): arrows move, nothing is selected. */
  readOnly?: boolean;
  className?: string;
  ref?: React.Ref<HTMLDivElement>;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/** A motion token's value on `<html>` (an easing curve), or `fallback` where it is unset. */
function cssToken(name: string, fallback: string): string {
  if (typeof getComputedStyle !== "function") return fallback;
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

/**
 * The thumb's slide (S-23 §6.1 morph; MO-04). At rest the checked item paints its own raised
 * background, exactly as before. When the value changes, a thumb under the items takes the new
 * item's box and slides there from the old one with a transform-only animation (FLIP: a translate
 * and a horizontal scale back to none, on `slow`·`emphasized`, like the tab indicator) while the
 * checked item's own background waits (`data-moving` on the root). A change mid-slide starts from
 * where the thumb is. Under reduced motion, or where nothing is laid out (a hidden control, jsdom),
 * the background swaps at once and nothing animates. Geometry reaches the thumb through the CSSOM
 * (custom properties), never markup (S-23 D8).
 */
function useThumb(
  value: string,
  root: React.RefObject<HTMLDivElement | null>,
  thumb: React.RefObject<HTMLSpanElement | null>,
  items: React.RefObject<Map<string, HTMLButtonElement>>,
): void {
  const previous = React.useRef(value);
  const running = React.useRef<Animation | null>(null);

  React.useLayoutEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (from === value) return;
    // No slide this time: stop one still running, so its settle clears `data-moving` and the new
    // option paints its own background at once.
    const stop = (): void => running.current?.cancel();
    const box = root.current;
    const el = thumb.current;
    const a = items.current.get(from);
    const b = items.current.get(value);
    if (!box || !el || !a || !b) return stop();
    if (reducedMotion() || typeof el.animate !== "function") return stop();
    const duration = tokenMs("--pk-duration-slow", 320);
    if (!(duration > 0)) return stop();

    const r = box.getBoundingClientRect();
    const start = (running.current ? el : a).getBoundingClientRect();
    const end = b.getBoundingClientRect();
    if (!start.width || !end.width) return stop();
    running.current?.cancel();

    // The thumb is placed by its inline-start inset, so the offset is measured from the start edge:
    // the left in left-to-right text, the right in right-to-left. The slide itself (a transform)
    // is a physical shift of where it paints, so it stays in left/right terms.
    const rtl = getComputedStyle(box).direction === "rtl";
    el.style.setProperty(
      "--pk-thumb-x",
      `${rtl ? r.right - end.right - box.clientLeft : end.left - r.left - box.clientLeft}px`,
    );
    el.style.setProperty(
      "--pk-thumb-y",
      `${end.top - r.top - box.clientTop}px`,
    );
    el.style.setProperty("--pk-thumb-w", `${end.width}px`);
    el.style.setProperty("--pk-thumb-h", `${end.height}px`);
    box.dataset.moving = "";

    let animation: Animation;
    try {
      animation = el.animate(
        [
          {
            transform: `translateX(${start.left - end.left}px) scaleX(${start.width / end.width})`,
          },
          { transform: "none" },
        ],
        { duration, easing: cssToken("--pk-ease-emphasized", "ease-out") },
      );
    } catch {
      delete box.dataset.moving;
      return;
    }
    running.current = animation;
    const settle = (): void => {
      if (running.current !== animation) return;
      running.current = null;
      delete box.dataset.moving;
    };
    animation.finished.then(settle, settle);
  }, [value, root, thumb, items]);

  React.useEffect(
    () => () => {
      running.current?.cancel();
    },
    [],
  );
}

/**
 * 2–4 short, mutually exclusive options (components.md §3.3): table density, the Update health
 * window, the Matrix view mode. Radio-group semantics: one tab stop; arrow keys move and select.
 * The checked background slides to the new option (`useThumb`).
 */
export function SegmentedControl<V extends string = string>({
  options,
  value,
  onChange,
  size = "md",
  wrap = false,
  id,
  name,
  disabled,
  readOnly,
  className,
  ref,
  ...aria
}: SegmentedControlProps<V>): React.ReactElement {
  const { locked } = useWriteLock();
  // A locked page keeps the control in the tab order: only the change is refused (B-031).
  const frozen = readOnly || locked;
  const root = React.useRef<HTMLDivElement | null>(null);
  const thumb = React.useRef<HTMLSpanElement | null>(null);
  const items = React.useRef(new Map<string, HTMLButtonElement>());
  useThumb(value, root, thumb, items);

  const setRoot = React.useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  return (
    <RadioGroup.Root
      ref={setRoot}
      id={id}
      name={name}
      value={value}
      disabled={disabled}
      aria-readonly={frozen || undefined}
      orientation="horizontal"
      loop
      onValueChange={(v) => {
        if (!frozen) onChange?.(v as V);
      }}
      className={cn(
        "group/seg relative inline-flex items-center gap-0.5 rounded-md border border-border bg-surface-sunken p-0.5",
        // Never wider than the room: at 200 % text on a phone the segments wrap onto a second row.
        "max-w-full flex-wrap",
        className,
      )}
      {...aria}
    >
      <span
        ref={thumb}
        aria-hidden
        data-segmented-thumb=""
        className="pointer-events-none absolute start-(--pk-thumb-x) top-(--pk-thumb-y) hidden h-(--pk-thumb-h) w-(--pk-thumb-w) ltr:origin-left rtl:origin-right rounded-sm bg-surface-raised shadow-elevation-1 group-data-[moving]/seg:block"
      />
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          ref={(el) => {
            if (el) items.current.set(o.value, el);
            else items.current.delete(o.value);
          }}
          value={o.value}
          disabled={o.disabled}
          className={cn(
            // `relative` keeps every label above the thumb while it slides.
            "relative inline-flex items-center justify-center rounded-sm px-3 text-fg-muted",
            wrap ? "min-h-8 min-w-0 py-1 text-center" : "whitespace-nowrap",
            !wrap && (size === "sm" ? "h-7" : "h-8"),
            // The customer site's touch layout: 44 px (the console keeps its 24 px floor).
            "max-desk:not-console:min-h-11 max-desk:not-console:min-w-11",
            size === "sm" ? "text-xs" : "text-sm",
            // The text colour eases; the background swaps at once, so the thumb hands over to the
            // checked item's own background without a dip.
            "transition-[color] duration-(--pk-duration-fast) ease-standard hover:text-fg-strong",
            "focus-visible:outline-2 focus-visible:outline-focus",
            "data-[state=checked]:bg-surface-raised data-[state=checked]:font-medium data-[state=checked]:text-fg-strong data-[state=checked]:shadow-elevation-1 console:data-[state=checked]:text-accent-fg",
            "group-data-[moving]/seg:data-[state=checked]:bg-transparent group-data-[moving]/seg:data-[state=checked]:shadow-none",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {o.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
