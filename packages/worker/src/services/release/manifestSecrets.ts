// P0-26: the sealing rules moved to Core's ingest (`core/ingest/manifestSecrets.ts`), where the
// Config contributor and the dry runs both reach them. Re-exported until P0-26b removes the dry
// runs' copies.
export * from "../../core/ingest/manifestSecrets.js";
