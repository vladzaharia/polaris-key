/** The account pages' reads: one `queryOptions` factory per key family (components.md §7). */

import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../api.js";
import { qk } from "../../data/queries.js";

export const accountReads = {
  /** The signed-in operator's own sign-in methods (ST-30c.4). */
  myMethods: () =>
    queryOptions({ queryKey: qk.myMethods(), queryFn: () => api.myMethods() }),
};
