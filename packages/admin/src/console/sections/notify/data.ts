/** The alert destinations read (components.md §7). */

import { queryOptions } from "@tanstack/react-query";
import { api, type AlertScope } from "../../../api.js";
import { qk } from "../../data/queries.js";

export const notifyReads = {
  alertDestinations: (scope: AlertScope) =>
    queryOptions({
      queryKey: qk.alertDestinations(scope),
      queryFn: () => api.alertDestinations(scope),
    }),
};
