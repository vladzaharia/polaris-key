import * as React from "react";

/**
 * Has `value` changed since the component mounted? (notes/S-23 §6.1 "status"; MO-09.) A status
 * pill pops its word when the word changes, never when it first appears: a table of 48 pills on
 * load stays still. Once true it stays true, so each later change pops too (the caller keys the
 * popping element on the value, so it remounts and animates once per change).
 */
export function useChangedSinceMount(value: string): boolean {
  const [first] = React.useState(value);
  const [changed, setChanged] = React.useState(false);
  if (!changed && value !== first) setChanged(true);
  return changed || value !== first;
}
