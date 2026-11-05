#!/usr/bin/env bash
# Require the CI workflow's "CI OK" check run on an exact commit to have concluded success.
#
# Used by deploy.yml (verify) and publish-sdks.yml (the main-channel gate), so a tag is deployed
# and a build is published only when the full CI already passed on that SHA. Fails CLOSED: any
# conclusion but success, no CI OK check run from the CI workflow, and any API error is a refusal.
#
# What counts as "the CI workflow": a run of .github/workflows/ci.yml (found through that
# workflow's own run list, so no other workflow can stand in), triggered by a push (a pull
# request narrows the lanes to the changed paths, so it proves less), on exactly this SHA. The
# check run must be named "CI OK", come from the github-actions app, and belong to one of those
# runs. A job named "CI OK" in any other workflow is ignored.
#
# While the CI run is queued or in progress the script polls (default 240 x 30 s = 120 minutes).
# A CI run that has not been registered yet (a tag pushed within seconds of the push) gets a short
# grace of GRACE_ATTEMPTS polls; after that "no CI run" is a refusal.
#
# Environment: REPO (owner/name), SHA (full commit), GH_TOKEN (read: checks, actions).
# Optional: MAX_ATTEMPTS (240), INTERVAL (30), GRACE_ATTEMPTS (5), CI_WORKFLOW (ci.yml),
# CHECK_NAME (CI OK).
set -uo pipefail

: "${REPO:?REPO is required}"
: "${SHA:?SHA is required}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-240}"
INTERVAL="${INTERVAL:-30}"
GRACE_ATTEMPTS="${GRACE_ATTEMPTS:-5}"
CI_WORKFLOW="${CI_WORKFLOW:-ci.yml}"
CHECK_NAME="${CHECK_NAME:-CI OK}"
CI_PATH=".github/workflows/$CI_WORKFLOW"
export SHA CI_PATH CHECK_NAME

refuse() {
  echo "Refusing: $*" >&2
  exit 1
}

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  # Capture through a variable and test the exit status: `gh` exits non-zero on an API error but
  # writes the error BODY to stdout, so piping it on would turn "the API was unreachable" into a
  # nonsense row.
  if ! RUNS=$(
    gh api --paginate "repos/$REPO/actions/workflows/$CI_WORKFLOW/runs?head_sha=$SHA&event=push&per_page=100" \
      --jq '.workflow_runs[]
            | select(.head_sha == $ENV.SHA and .path == $ENV.CI_PATH and .event == "push")
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
  while IFS=$'\t' read -r ID STATUS; do
    [ -n "$ID" ] || continue
    RUN_IDS="$RUN_IDS$ID "
    [ "$STATUS" = "completed" ] || OPEN_RUNS=$((OPEN_RUNS + 1))
  done <<<"$RUNS"

  if [ "$RUN_IDS" = " " ]; then
    if [ "$attempt" -le "$GRACE_ATTEMPTS" ]; then
      echo "No CI run registered for $SHA yet (attempt $attempt/$GRACE_ATTEMPTS) - retrying in ${INTERVAL}s"
      sleep "$INTERVAL"
      continue
    fi
    refuse "the CI workflow has no push run on $SHA. The full CI must run on the exact commit (a push to main or next)."
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
