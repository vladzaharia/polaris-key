/**
 * Catalog-driven editing (docs/design/ADMIN.md §6.6), split out of the old `SchemaForm.tsx`
 * (SCF-7): the validator and entry helpers, the per-entry value control, the management-state
 * control and the managed-key row.
 */
export * from "./entry.js";
export * from "./catalogValidation.js";
export { SchemaField, type SchemaFieldProps } from "./SchemaField.js";
export { ManagementStateControl } from "./ManagementStateControl.js";
export { ManagedField, type ManagedFieldProps } from "./ManagedField.js";
