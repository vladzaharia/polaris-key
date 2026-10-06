// S-23 prototypes: shared bits (toasts, the prototype toolbar).
import { h } from "./h.js";
import { presence, viewTransition } from "./motion.js";

/** A toast: enters with pk-transient, leaves after 4 s (errors would stay; see ui/toast.tsx). */
export function toast(text, { action, onAction } = {}) {
  const host = document.getElementById("toasts");
  const el = h(
    "div.toast.pk-transient",
    { role: "status", "data-state": "open" },
    h("span.ok", { "aria-hidden": "true" }, "✓"),
    h("span", text),
    action
      ? h(
          "button.btn.sm.pk-pressable",
          {
            type: "button",
            on: {
              click: () => {
                onAction?.();
                dismiss();
              },
            },
          },
          action,
        )
      : null,
  );
  host.append(el);
  const dismiss = async () => {
    await presence(el, false);
    el.remove();
  };
  setTimeout(dismiss, 4000);
  return el;
}

/** Theme (a View Transition cross-fade), reduced motion (html[data-motion]), replay. */
export function wireProtoBar(replay) {
  const html = document.documentElement;
  const q = new URLSearchParams(location.search);
  if (q.get("theme")) html.dataset.theme = q.get("theme");
  if (q.get("motion") === "reduce") html.dataset.motion = "reduce";
  document.getElementById("t-theme").addEventListener("click", () =>
    viewTransition(
      () => {
        html.dataset.theme = html.dataset.theme === "light" ? "dark" : "light";
      },
      { type: "theme" },
    ),
  );
  const motion = document.getElementById("t-motion");
  motion.setAttribute("aria-pressed", String(html.dataset.motion === "reduce"));
  motion.addEventListener("click", () => {
    const on = html.dataset.motion !== "reduce";
    if (on) html.dataset.motion = "reduce";
    else delete html.dataset.motion;
    motion.setAttribute("aria-pressed", String(on));
  });
  document.getElementById("t-replay").addEventListener("click", replay);
}
