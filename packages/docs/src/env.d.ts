// Starlight augments Astro.locals with `starlightRoute`; the component overrides in
// src/components/ read it, so its global types are referenced here.
/// <reference types="@astrojs/starlight" />

// The header renders Starlight's own slots through the virtual module that resolves overrides
// (so a user override of Search or SiteTitle is the one drawn); Starlight ships no types for it.
declare module "virtual:starlight/components/*" {
  const component: (props: Record<string, unknown>) => unknown;
  export default component;
}
