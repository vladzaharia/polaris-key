#!/usr/bin/env bash
# Require the CI workflow's "CI OK" check run on an exact commit to have concluded success.
#
# Used by deploy.yml (verify) and publish-sdks.yml (the main-channel gate), so a tag is deployed
# and a build is published only when CI already passed on that SHA. A push run on next is
# narrowed, per lane, to the files touched since that lane's newest green ancestor, and runs the
# pull-request matrices (tools/ci-scope.mjs): its CI OK means the touched lanes passed on it and the
# rest were green at their ancestor, which is the proof a merge to main and an SDK prerelease need.
# A tag needs more (REQUIRE_FULL=1): a run that checked every lane on the full matrices on this
# exact SHA, which is a push to main or a dispatch of ci.yml (`gh workflow run ci.yml --ref main`),
# never a push to next. Such a run has its "Full run" job succeed (ci.yml gives it
# `changes.outputs.full-run`); a narrowed run skips it. Fails CLOSED: any
# conclusion but success, no CI OK check run from the CI workflow, and any API error is a refusal.
#
# What counts as "the CI workflow": a run of .github/workflows/ci.yml (found through that
# workflow's own run list, so no other workflow can stand in), triggered by a push or a dispatch (a
# pull request narrows the lanes to the changed paths, so it proves less), on exactly this SHA. The
# check run must be named "CI OK", come from the github-actions app, and belong to one of those
# runs. A job named "CI OK" in any other workflow is ignored.
#
# While the CI run is queued or in progress the script polls (default 240 x 30 s = 120 minutes).
# A CI run that has not been registered yet (a tag pushed within seconds of the push) gets a short
# grace of GRACE_ATTEMPTS polls; after that "no CI run" is a refusal.
#
# Environment: REPO (owner/name), SHA (full commit), GH_TOKEN (read: checks, actions).
# Optional: MAX_ATTEMPTS (240), INTERVAL (30), GRACE_ATTEMPTS (5), CI_WORKFLOW (ci.yml),
# CHECK_NAME (CI OK), REQUIRE_FULL (1: only a run whose FULL_JOB succeeded counts, see above),
# FULL_JOB (Full run (every lane, full matrices): the name of that ci.yml job).
set -uo pipefail

: "${REPO:?REPO is required}"
: "${SHA:?SHA is required}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-240}"
INTERVAL="${INTERVAL:-30}"
GRACE_ATTEMPTS="${GRACE_ATTEMPTS:-5}"
CI_WORKFLOW="${CI_WORKFLOW:-ci.yml}"
CHECK_NAME="${CHECK_NAME:-CI OK}"
REQUIRE_FULL="${REQUIRE_FULL:-}"
FULL_JOB="${FULL_JOB:-Full run (every lane, full matrices)}"
CI_PATH=".github/workflows/$CI_WORKFLOW"
export SHA CI_PATH CHECK_NAME FULL_JOB

refuse() {
  echo "Refusing: $*" >&2
  exit 1
}

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  # Capture through a variable and test the exit status: `gh` exits non-zero on an API error but
  # writes the error BODY to stdout, so piping it on would turn "the API was unreachable" into a
  # nonsense row.
  if ! RUNS=$(
    gh api --paginate "repos/$REPO/actions/workflows/$CI_WORKFLOW/runs?head_sha=$SHA&per_page=100" \
      --jq '.workflow_runs[]
            | select(.head_sha == $ENV.SHA and .path == $ENV.CI_PATH and (.event == "push" or .event == "workflow_dispatch"))
            | [.id, .status] | @tsv'
  ); then
    refuse "could not list the CI runs for $SHA (an API or permissions failure, not a red build; the job needs 'actions: read')."
  fi
  if ! CHECKS=$(
    gh api --paginate "repos/$REPO/commits/$SHA/check-runs?check_name=$(printf '%s' "$CHECK_NAME" | sed 's/ /%20/g')&filter=all&per_page=100" \
      --jq '.check_runs[]
            | select(.name == $ENV.CHECK_NAME and (.app.slug // "") == "github-actions")
            | [.id, .status, (.conclusion // "none"), (.html_url // "")] | @tsv'
  ); then
    refuse "could not read the '$CHECK_NAME' check run for $SHA (an API or permissions failure, not a red build; the job needs 'checks: read')."
  fi

  RUN_IDS=" "
  OPEN_RUNS=0
  ANY_RUN=0
  while IFS=$'\t' read -r ID STATUS; do
    [ -n "$ID" ] || continue
    ANY_RUN=1
    if [ -n "$REQUIRE_FULL" ]; then
      # Only a run whose Full run job succeeded checked every lane on the full matrices. A job that
      # has not concluded yet is a run still deciding; any other conclusion (skipped: a narrowed
      # run) rules the run out.
      if ! FULL=$(
        gh api --paginate "repos/$REPO/actions/runs/$ID/jobs?filter=latest&per_page=100" \
          --jq '.jobs[] | select(.name == $ENV.FULL_JOB) | (.conclusion // "pending")'
      ); then
        refuse "could not read the jobs of CI run $ID (an API or permissions failure, not a red build; the job needs 'actions: read')."
      fi
      case "$FULL" in
        success) ;;
        pending | "")
          [ "$STATUS" = "completed" ] || OPEN_RUNS=$((OPEN_RUNS + 1))
          continue
          ;;
        *) continue ;;
      esac
    fi
    RUN_IDS="$RUN_IDS$ID "
    [ "$STATUS" = "completed" ] || OPEN_RUNS=$((OPEN_RUNS + 1))
  done <<<"$RUNS"

  if [ "$RUN_IDS" = " " ] && [ "$OPEN_RUNS" -gt 0 ]; then
    echo "A full CI run on $SHA has not reached its Full run job yet (attempt $attempt/$MAX_ATTEMPTS) - retrying in ${INTERVAL}s"
    [ "$attempt" -lt "$MAX_ATTEMPTS" ] && sleep "$INTERVAL"
    continue
  fi
  if [ "$RUN_IDS" = " " ]; then
    if [ "$ANY_RUN" -eq 1 ]; then
      refuse "no CI run on $SHA checked every lane on the full matrices (REQUIRE_FULL). Dispatch one on the tagged ref: gh workflow run ci.yml --ref main, and tag when its CI OK is green."
    fi
    if [ "$attempt" -le "$GRACE_ATTEMPTS" ]; then
      echo "No CI run registered for $SHA yet (attempt $attempt/$GRACE_ATTEMPTS) - retrying in ${INTERVAL}s"
      sleep "$INTERVAL"
      continue
    fi
    refuse "the CI workflow has no push or dispatch run on $SHA. CI must run on the exact commit (a push to main or next, or a dispatch)."
  fi

  # The newest check run named CI OK that belongs to one of those CI runs decides.
  BEST_ID=0 BEST_STATUS="" BEST_CONCLUSION="" BEST_URL=""
  while IFS=$'\t' read -r ID STATUS CONCLUSION URL; do
    [ -n "$ID" ] || continue
    RUN_OF="${URL#*/actions/runs/}"
    RUN_OF="${RUN_OF%%/*}"
    case "$RUN_IDS" in *" $RUN_OF "*) ;; *) continue ;; esac
    if [ "$ID" -gt "$BEST_ID" ]; then
      BEST_ID="$ID" BEST_STATUS="$STATUS" BEST_CONCLUSION="$CONCLUSION" BEST_URL="$URL"
    fi
  done <<<"$CHECKS"

  if [ "$BEST_ID" -eq 0 ]; then
    if [ "$OPEN_RUNS" -gt 0 ]; then
      echo "CI is still running on $SHA, '$CHECK_NAME' not started (attempt $attempt/$MAX_ATTEMPTS) - retrying in ${INTERVAL}s"
    else
      refuse "the CI workflow finished on $SHA without a '$CHECK_NAME' check run."
    fi
  elif [ "$BEST_STATUS" != "completed" ]; then
    echo "'$CHECK_NAME' is $BEST_STATUS on $SHA (attempt $attempt/$MAX_ATTEMPTS) - retrying in ${INTERVAL}s"
  elif [ "$BEST_CONCLUSION" = "success" ]; then
    echo "'$CHECK_NAME' concluded success on $SHA ($BEST_URL)."
    exit 0
  else
    refuse "'$CHECK_NAME' concluded $BEST_CONCLUSION on $SHA ($BEST_URL)."
  fi

  [ "$attempt" -lt "$MAX_ATTEMPTS" ] && sleep "$INTERVAL"
done

refuse "'$CHECK_NAME' on $SHA did not finish within $((MAX_ATTEMPTS * INTERVAL / 60)) minutes."
