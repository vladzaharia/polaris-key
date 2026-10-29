// U-09.2: the Cloud Sync records contract (WIRE-CONTRACT-V5 §13.3, §13.4, §13.10.4). The wire
// shapes the later slices serve are typed in @polaris-key/protocol/sync and published in the
// OpenAPI schemas; this holds one example of each to both, so the two cannot drift apart. No
// Worker behaviour is under test.

import { describe, expect, it } from "vitest";
import type {
  MutationResult,
  SyncChange,
  SyncMutation,
  SyncSealedChange,
  SyncTombstone,
} from "@polaris-key/protocol/sync";
import { validateAgainst } from "../../specSchema.js";

const HLC = "0190f3a2c1b4:0003";
const ID = `x:${"A".repeat(43)}`;
const NAME = `x:${"B".repeat(43)}`;
const CT = "AQ";

describe("records in the OpenAPI schemas", () => {
  it("accepts every mutation of the policy table, plaintext and sealed", () => {
    const mutations: SyncMutation[] = [
      {
        mutationId: 1,
        target: { record: ["saves", "slot1"] },
        op: "set",
        value: { chapter: "one" },
        baseVersion: "*",
      },
      {
        mutationId: 2,
        target: { record: ["saves", ID] },
        op: "set",
        ct: CT,
        baseVersion: 3,
      },
      {
        mutationId: 3,
        target: { record: ["profile", "p1"] },
        op: "setField",
        field: "name",
        value: "Ada",
        editedHlc: HLC,
      },
      {
        mutationId: 4,
        target: { record: ["profile", ID] },
        op: "setField",
        field: NAME,
        ct: CT,
        editedHlc: HLC,
      },
      {
        mutationId: 5,
        target: { record: ["profile", ID] },
        op: "removeField",
        field: NAME,
        editedHlc: HLC,
      },
      {
        mutationId: 6,
        target: { record: ["tags", "t1"] },
        op: "add",
        element: { colour: "red" },
      },
      {
        mutationId: 7,
        target: { record: ["tags", ID] },
        op: "add",
        element: NAME,
        ct: CT,
      },
      {
        mutationId: 8,
        target: { record: ["tags", ID] },
        op: "remove",
        element: NAME,
        observedSeq: 12,
      },
      {
        mutationId: 9,
        target: { record: ["saves", ID] },
        op: "delete",
        baseVersion: 4,
      },
    ];
    for (const m of mutations)
      expect(validateAgainst("SyncMutation", m), JSON.stringify(m)).toEqual([]);
    expect(
      validateAgainst("PushRequest", {
        clientId: "c_AAAAAAAAAAAAAAAAAAAAAA",
        cursor: 0,
        mutations,
      }),
    ).toEqual([]);
  });

  it("holds each record change shape to exactly one schema branch", () => {
    const changes: (SyncChange | SyncSealedChange)[] = [
      { record: ["saves", "slot1"], value: { chapter: "one" }, version: 2 },
      { record: ["profile", "p1"], value: { name: "Ada" }, version: 3 },
      { record: ["tags", "t1"], value: ["red", "blue"], version: 4 },
      { record: ["saves", ID], ct: CT, version: 2, editedHlc: HLC },
      {
        record: ["profile", ID],
        fields: [{ field: NAME, ct: CT, editedHlc: HLC }],
        version: 3,
        editedHlc: HLC,
      },
      {
        record: ["tags", ID],
        elements: [{ element: NAME, ct: CT }],
        version: 4,
      },
    ];
    for (const c of changes)
      expect(validateAgainst("SyncChange", c), JSON.stringify(c)).toEqual([]);
  });

  it("refuses a sealed record that mixes shapes", () => {
    // A sealed merge record has fields and no ct; a union record has elements and no ct.
    const mixed = [
      {
        record: ["profile", ID],
        ct: CT,
        fields: [{ field: NAME, ct: CT, editedHlc: HLC }],
        version: 3,
        editedHlc: HLC,
      },
      { record: ["tags", ID], elements: [{ element: NAME }], version: 4 },
      { record: ["tags", ID], elements: [], value: [], version: 4 },
    ];
    for (const c of mixed)
      expect(validateAgainst("SyncChange", c), JSON.stringify(c)).not.toEqual(
        [],
      );
  });

  it("refuses a mutation or change the schema can see is malformed", () => {
    // The test validator checks types, enums, patterns, required members and oneOf; it does not
    // check `minimum` or `minItems`, so those bounds are not asserted here.
    const badMutations = [
      // An operation outside the vocabulary.
      { mutationId: 1, target: { record: ["tags", ID] }, op: "append" },
      // observedSeq is an integer.
      {
        mutationId: 2,
        target: { record: ["tags", ID] },
        op: "remove",
        element: NAME,
        observedSeq: "12",
      },
      // baseVersion is a non-negative integer or "*".
      {
        mutationId: 3,
        target: { record: ["saves", ID] },
        op: "delete",
        baseVersion: "latest",
      },
    ];
    for (const m of badMutations)
      expect(validateAgainst("SyncMutation", m), JSON.stringify(m)).not.toEqual(
        [],
      );
    const badChanges = [
      // A sealed field without its clock.
      {
        record: ["profile", ID],
        fields: [{ field: NAME, ct: CT }],
        version: 3,
        editedHlc: HLC,
      },
      // A sealed merge record without the newest clock.
      {
        record: ["profile", ID],
        fields: [{ field: NAME, ct: CT, editedHlc: HLC }],
        version: 3,
      },
      // A member outside the shape.
      {
        record: ["tags", ID],
        elements: [{ element: NAME, ct: CT, editedHlc: HLC }],
        version: 4,
      },
    ];
    for (const c of badChanges)
      expect(validateAgainst("SyncChange", c), JSON.stringify(c)).not.toEqual(
        [],
      );
  });

  it("does not make the schema the blinding gate", () => {
    // The server, not the schema, answers `encryption_mismatch` for a sealed entry whose name is
    // not blinded (§13.3 check 3): both of these are schema-valid and must stay so.
    const plainName = {
      record: ["profile", ID],
      fields: [{ field: "name", ct: CT, editedHlc: HLC }],
      version: 3,
      editedHlc: HLC,
    };
    expect(validateAgainst("SyncChange", plainName)).toEqual([]);
    const plainElement = {
      record: ["tags", ID],
      elements: [{ element: "red", ct: CT }],
      version: 4,
    };
    expect(validateAgainst("SyncChange", plainElement)).toEqual([]);
  });

  it("carries a sealed merge record's conflict copy as fields", () => {
    const result: MutationResult = {
      mutationId: 3,
      status: "conflict",
      server: {
        fields: [{ field: NAME, ct: CT, editedHlc: HLC }],
        version: 7,
        editedHlc: HLC,
      },
    };
    expect(validateAgainst("MutationResult", result)).toEqual([]);
    const serverMode: MutationResult = {
      mutationId: 3,
      status: "conflict",
      server: { value: { name: "Ada" }, version: 7, editedHlc: HLC },
    };
    expect(validateAgainst("MutationResult", serverMode)).toEqual([]);
  });

  it("keeps a record tombstone as it was", () => {
    const t: SyncTombstone = { record: ["saves", ID], editedHlc: HLC };
    expect(validateAgainst("SyncTombstone", t)).toEqual([]);
  });

  it("rejects with the collection scope", () => {
    expect(
      validateAgainst("MutationResult", {
        mutationId: 1,
        status: "rejected",
        code: "quota_exceeded",
        scope: "collection",
      }),
    ).toEqual([]);
  });
});
