// The desktop chrome's stylesheet (UK-06: Windows, GNOME and macOS rules and tokens), its own file in
// the build (scripts/bundle-contract.mjs) so the web gate's entry does not carry it: styles.ts
// imports it on demand when a kit root resolves to a desktop variant.
export { lightDomDesktopCss } from "@polaris-key/elements/contract";
