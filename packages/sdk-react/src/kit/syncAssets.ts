// What only the Cloud Sync screens need (U-42.2): their layouts and their stylesheet. Its own file in
// the build (scripts/bundle-contract.mjs) so the web gate's entry carries neither: syncParts.tsx
// imports it, and adopts the sheet with the first screen drawn.
export {
  copyForm,
  lightDomSyncCss,
  recoveryGroups,
  spokenForm,
  SYNC_LAYOUTS,
} from "@polaris-key/elements/sync";
