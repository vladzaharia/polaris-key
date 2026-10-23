/**
 * The wizard kit's saved choices (ST-39): `core.setup`, read and written through the product
 * settings routes, so the audit row, history, Revert and RBAC come with the registry. No table and
 * no route of its own.
 *
 * Every edit is a pure function of the choices in force (`./setup.ts`). A write carries the
 * version it read; when another operator saved first (409) the edit is applied to what they saved
 * and sent once more, so two operators' choices both stay.
 */

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api.js";
import { errorCopy } from "../../lib/errorCopy.js";
import { toast } from "../../ui/toast.js";
import { useMe } from "../data/hooks.js";
import { mutate } from "../data/mutations.js";
import { reads } from "../data/reads.js";
import { useWriteGate } from "../access/useCan.js";
import {
  edit,
  parseSetup,
  SETUP_AREA,
  SETUP_KEY,
  type SetupChoices,
  type SetupEdit,
  type SetupStamp,
} from "./setup.js";

export interface UseSetup {
  choices: SetupChoices;
  /** The choices have been read (the defaults show before). */
  ready: boolean;
  error: unknown;
  /** The member may save choices; else the words that say who can. */
  allowed: boolean;
  disabledReason: string | undefined;
  /** Apply an edit and save it. Rejects with the API error when the save fails. */
  save: (edit: SetupEdit) => Promise<SetupChoices>;
  /** Who and when, for a choice that records them. */
  stamp: () => SetupStamp;
  /** Skip a step: saved as a choice. Says why in a toast and answers false when it fails. */
  skip: (flow: string, step: string) => Promise<boolean>;
  /** Undo a skip. Same failure words as `skip`. */
  unskip: (flow: string, step: string) => Promise<boolean>;
  /** Hide or show Integration (the operator's choice). Same failure words as `skip`. */
  setIntegrationHidden: (hidden: boolean) => Promise<boolean>;
  saving: boolean;
}

const isConflict = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 409;

export function useSetup(slug: string): UseSetup {
  const area = SETUP_AREA;
  const queryClient = useQueryClient();
  const q = useQuery(reads.productSettings(slug, area));
  const me = useMe().data;
  const gate = useWriteGate("core", slug);
  const [saving, setSaving] = React.useState(false);
  const row = q.data?.settings?.find((s) => s.key === SETUP_KEY);
  const choices = parseSetup(row?.value);

  const save = async (edit: SetupEdit): Promise<SetupChoices> => {
    setSaving(true);
    try {
      const write = async (from: SetupChoices, version: number) => {
        const next = edit(from);
        const res = await mutate("updateProductSetting", slug, SETUP_KEY, {
          value: next,
          expectedVersion: version,
        });
        return parseSetup(res.setting.value);
      };
      try {
        return await write(choices, row?.version ?? 0);
      } catch (e) {
        if (!isConflict(e)) throw e;
        // Someone saved first: apply this edit to what they saved, once.
        const fresh = await queryClient.fetchQuery({
          ...reads.productSettings(slug, area),
          staleTime: 0,
        });
        const now = fresh.settings?.find((s) => s.key === SETUP_KEY);
        return await write(parseSetup(now?.value), now?.version ?? 0);
      }
    } finally {
      setSaving(false);
    }
  };

  /** Save a choice; on failure say why and what to do, not only that it failed. */
  const change = async (e: SetupEdit): Promise<boolean> => {
    try {
      await save(e);
      return true;
    } catch (err) {
      const copy = errorCopy(err, { thing: "Your choice" });
      const forbidden = err instanceof ApiError && err.status === 403;
      toast.error(copy.title, {
        description:
          (forbidden ? gate.disabledReason : undefined) || copy.description,
      });
      return false;
    }
  };

  const stampNow = (): SetupStamp => ({
    at: Math.floor(Date.now() / 1000),
    by: me?.email || me?.sub || "operator",
  });

  return {
    choices,
    ready: q.isSuccess,
    error: q.error,
    allowed: gate.allowed,
    disabledReason: gate.disabledReason,
    save,
    stamp: stampNow,
    skip: (flow, step) => change(edit.skip(flow, step)),
    unskip: (flow, step) => change(edit.skip(flow, step, false)),
    setIntegrationHidden: (hidden) =>
      change(edit.hideIntegration(hidden ? stampNow() : null)),
    saving,
  };
}
