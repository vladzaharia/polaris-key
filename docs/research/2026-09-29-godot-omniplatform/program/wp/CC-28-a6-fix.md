# CC-28 Connect pass fixes from the C3a/C5 reviews: A6-FIX-NP (Node, Python), A6-FIX-SK (Swift, Kotlin), A6-FIX-G (Godot)

| Field       | Value                           |
| ----------- | ------------------------------- |
| Phase       | CC: Cloud Connect               |
| Size        | 0.3–0.6 engineer-weeks          |
| Depends on  | [CC-15](CC-15-nearby-mode-v.md) |
| Unblocks    | none                            |
| Role        | `pkey-sdk-porter`               |
| Plan mode   | no                              |
| Gates       | all-sdks, security-review       |
| Human input | none                            |
| Repo        | vladzaharia/polaris-key         |

## Goal

mDNS address lapse, send-queue reserve, inbound byte bounds, and leaving Connect at deactivation plus closing sessions a stored roster drops. NP and SK merged in A6; G (wp/A6-FIX-G, on wp/CC-14.15) rides Connect pass 2.

## Plan

Lead follow-up log, 2026-10-31 (A6-FIX-NP/SK/G entries).

## Acceptance criteria

- [ ] see plan
