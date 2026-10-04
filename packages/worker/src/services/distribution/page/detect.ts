/**
 * The download page's platform detection (P2b-06) now lives in Core (`core/platformDetect.ts`,
 * PX-W2): the customer portal's downloads (Identity) detect the visitor's platform with the SAME
 * function, and a service may import Core but never Distribution (AGENTS.md rule 6). This module
 * keeps the page's import path.
 */

export {
  PAGE_PLATFORMS,
  PLATFORM_LABELS,
  detectPlatform,
  type DetectedPlatform,
  type PagePlatform,
} from "../../../core/platformDetect.js";
