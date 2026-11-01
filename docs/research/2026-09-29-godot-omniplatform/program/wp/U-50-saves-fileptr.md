# U-50 Cross-SDK read-after-write for saves: putAt carries finalize's pointer (SAVES-FILEPTR)

| Field       | Value                          |
| ----------- | ------------------------------ |
| Phase       | U: Cloud Sync (S-17)           |
| Size        | 0.3–0.6 engineer-weeks         |
| Depends on  | [U-48](U-48-saves-bindings.md) |
| Unblocks    | none                           |
| Role        | `pkey-sdk-porter`              |
| Plan mode   | no                             |
| Gates       | all-sdks, corpus-runner        |
| Human input | none                           |
| Repo        | vladzaharia/polaris-key        |

## Goal

On putAt ok the row keeps the old file pointer; carry the finalized pointer in every SDK and add three fileRecordCases. Queued after INTEG-COMBINE-3.

## Plan

LF 2026-10-31 CROSS-SDK READ-AFTER-WRITE (lead directory)

## Acceptance criteria

- [ ] see plan
