/** The Commerce pages' reads (components.md §7). The services view is a shared read in `data/reads.ts`. */

import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../api.js";
import { qk } from "../../data/queries.js";

export const commerceReads = {
  view: (slug: string) =>
    queryOptions({
      queryKey: qk.commerceView(slug),
      queryFn: () => api.commerceView(slug),
    }),
};
