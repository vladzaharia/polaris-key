/**
 * The page header moved to the shared kit (`ui/PageHeader.tsx`, EXPERIENCE.md §3). This path stays
 * as a re-export so pages written against it keep compiling; new code imports from `ui/`.
 */
export {
  PageHeader,
  type PageAction,
  type PageHeaderProps,
} from "../../ui/PageHeader.js";
