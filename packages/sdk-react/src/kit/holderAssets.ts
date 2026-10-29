// The holder screens' rules (ActivateDone, AddToAccount) in light-DOM form: the one stylesheet the
// elements draw them with. Its own file in the build (scripts/bundle-contract.mjs), so the gate's
// entry does not carry it; holders.tsx imports it and adopts the sheet with the first screen drawn.
export { lightDomHolderCss } from "@polaris-key/elements/sync";
