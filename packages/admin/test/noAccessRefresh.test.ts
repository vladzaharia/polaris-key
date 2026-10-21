import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.js";
import { createQueryClient } from "../src/console/data/queryClient.js";
import {
  bindWriteInvalidation,
  refreshMeOnNoAccess,
} from "../src/console/data/mutations.js";
import { qk } from "../src/console/data/queries.js";

/** B-212: a refusal with reason `no_access` re-reads who the member is, so the shell shows NoAccess. */
describe("a no_access refusal refreshes me", () => {
  let unbind: (() => void) | null = null;
  afterEach(() => unbind?.());

  it("invalidates qk.me() for a 403 no_access, and nothing else", () => {
    const client = createQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    unbind = bindWriteInvalidation(client);
    refreshMeOnNoAccess(
      new ApiError(403, undefined, undefined, undefined, "no_access"),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.me(), exact: true });
    spy.mockClear();
    refreshMeOnNoAccess(
      new ApiError(403, undefined, undefined, undefined, "other"),
    );
    refreshMeOnNoAccess(new ApiError(500));
    refreshMeOnNoAccess(new Error("x"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("a failed read refreshes me through the query client", async () => {
    const client = createQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    unbind = bindWriteInvalidation(client);
    await client
      .fetchQuery({
        queryKey: ["probe"],
        queryFn: () =>
          Promise.reject(
            new ApiError(403, undefined, undefined, undefined, "no_access"),
          ),
      })
      .catch(() => undefined);
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.me(), exact: true });
  });
});
