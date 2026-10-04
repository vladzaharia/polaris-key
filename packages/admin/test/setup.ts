import { configure } from "@testing-library/react";

// Testing Library's default async timeout is 1 s. A view that seeds its form from a mocked fetch
// in an effect can take longer than that to settle on a loaded machine or a slow CI runner, so
// `waitFor`/`findBy*` would give up on a correct render. 5 s keeps a real hang visible while
// removing the load-dependent failures (identity, licenses, updateSettings).
configure({ asyncUtilTimeout: 5_000 });

// jsdom cannot navigate to another document: following a non-hash link (Docs, Sign in, a
// download) logs "Not implemented: navigation". Tests assert the href, never the navigation, so
// swallow the default action after every handler has run (a bubbling listener on window fires
// after React's). Hash links still work: the router depends on them.
window.addEventListener("click", (e) => {
  const anchor = (e.target as Element | null)?.closest?.("a[href]");
  const href = anchor?.getAttribute("href") ?? "";
  if (anchor && !href.startsWith("#")) e.preventDefault();
});
