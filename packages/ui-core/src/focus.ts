// DL9's focus-on-mount rule, once, for every web kit (elements and React): where focus lands
// when a view appears. A model says what it wants (`decisions.focus`); this says whether the kit
// may take it. No DOM here: each kit reads its own environment and passes it in.

export interface MountFocusEnv {
  /** The component owns the window: a screen or dialog. A pane, strip or toast sits in a host
   *  page and never pulls focus on mount. */
  owns: boolean;
  /** The host asked for focus (`autofocus` / `autoFocus`). */
  asked: boolean;
  /** Focus is already inside the kit. */
  within: boolean;
  /** Nothing holds focus (the page body does) and the kit fills the window, so a cold start
   *  lands inside the screen. */
  coldStart: boolean;
  /** A coarse pointer: the keyboard would cover the screen. */
  coarse: boolean;
  /** The target resolved to a text field. */
  targetIsField: boolean;
}

/** Where focus goes on mount: nowhere, the heading, or the model's target. */
export function focusOnMount(
  target: string | null,
  env: MountFocusEnv,
): "none" | "heading" | "target" {
  if (target === null || !env.owns) return "none";
  if (!(env.asked || env.within || env.coldStart)) return "none";
  // A text field is never focused on appear under a coarse pointer: the heading takes it.
  if (target === "heading" || (env.coarse && env.targetIsField))
    return "heading";
  return "target";
}
