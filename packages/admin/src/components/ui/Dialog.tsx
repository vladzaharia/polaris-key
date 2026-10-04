/**
 * Re-export (ADMIN.md §7.2 chunk 3): dialogs live in `src/ui/Dialog.tsx`. These are the Radix
 * building blocks under their legacy names, for the views that compose them by hand; new code uses
 * `Dialog` from `src/ui/`. Deleted in chunk 11.
 */
export {
  DialogRoot as Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContentPrimitive as DialogContent,
  DialogHeaderPrimitive as DialogHeader,
  DialogFooterPrimitive as DialogFooter,
  DialogBodyPrimitive as DialogBody,
  DialogActionBarPrimitive as DialogActionBar,
  DialogTitlePrimitive as DialogTitle,
  DialogDescriptionPrimitive as DialogDescription,
} from "../../ui/Dialog.js";
