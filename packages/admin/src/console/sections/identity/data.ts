/** The Identity section's reads (components.md §7). */

import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../api.js";
import { qk } from "../../data/queries.js";

/** The product's sign-in settings. */
export const signInSettingsQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.signInSettings(slug),
    queryFn: () => api.signInSettings(slug).then((res) => res.settings),
  });
