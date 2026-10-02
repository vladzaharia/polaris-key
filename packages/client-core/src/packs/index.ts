// @polaris-key/client-core/packs — packs on the wire (plans/P4-01.md §2.3–§2.8), the functions
// P4-21 lands: the pack-id and object-ref rules, the `content` claims, the files index, its path
// rules and `treeDigest`, the variant key and the content stamp; and P4-04's `packSetId`,
// `windowLogMax` and `frameWindow` (§2.7 rule 3, §2.9). Pure; nothing here does I/O.
// `releaseRecordClaims` (`../record.ts`) applies the pack and app claims at step 14.

export {
  contentClaims,
  isPackId,
  objectRef,
  type ContentClaimsOptions,
} from "./claims.js";
export {
  checkPaths,
  parseFilesIndex,
  treeDigest,
  type CheckPathsResult,
  type FilesErrorCode,
  type FilesIndexRef,
  type ParseFilesIndexOptions,
  type ParseFilesIndexResult,
  type ZstdDecode,
} from "./files.js";
export { packSetId, type PackSetEntry } from "./set.js";
export { parseContentStamp, type ParseContentStampResult } from "./stamp.js";
export { variantKey } from "./variant.js";
export { frameWindow, windowAllowed, windowLogMax } from "./window.js";
