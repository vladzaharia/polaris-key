export type {
  ConfigKind,
  ManagementState,
  UiHints,
  JsonSchema,
  ConfigEntry,
  ProductCatalog,
} from "./types.js";
export { Catalog, type ValidationResult } from "./catalog.js";
export {
  representabilityIssue,
  catalogKeyIssue,
  describeRepresentabilityIssue,
  hasLoneSurrogate,
  numberInWireRange,
  MAX_VALUE_DEPTH,
  type RepresentabilityIssue,
  type RepresentabilityRule,
} from "./representable.js";
export {
  prepareSchema,
  validatePrepared,
  UnsupportedSchemaError,
  SUPPORTED_FORMATS,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_NODES,
  MAX_VALIDATION_STEPS,
  MAX_UNIQUE_ITEMS,
  type PreparedSchema,
  type ValidationIssue,
} from "./validate.js";
export {
  compileLinearPattern,
  UnsupportedPatternError,
  MAX_PATTERN_SOURCE,
  MAX_PATTERN_PROGRAM,
  MAX_PATTERN_REPEAT,
  MAX_PATTERN_INPUT,
  type LinearPattern,
} from "./regex.js";
