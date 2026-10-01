import { configure } from "@testing-library/react";

// Testing Library's default async timeout is 1 s. A view that seeds its form from a mocked fetch
// in an effect can take longer than that to settle on a loaded machine or a slow CI runner, so
// `waitFor`/`findBy*` would give up on a correct render. 5 s keeps a real hang visible while
// removing the load-dependent failures (identity, licenses, updateSettings).
configure({ asyncUtilTimeout: 5_000 });
