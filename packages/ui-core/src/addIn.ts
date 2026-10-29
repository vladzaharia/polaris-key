// Where a web gate adds a floating license to an account (UK-42.21). `portal` opens the Polaris
// Locker card (the key rides in `#key=` for trusted origins), which handles name and email hints and
// attaching; `app` runs the in-page AddToAccount form on the device-code channel. The web gates use
// `portal` until the Worker's device start honours the hints (UK-43's `licenseHolder.addIn` then
// replaces this constant). The same switch routes "Sign in to that account" on a license-owned
// refusal. The AddToAccount code stays; this is the one place it is turned off.

export type AddIn = "portal" | "app";

export const WEB_ADD_IN: AddIn = "portal";
