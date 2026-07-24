#!/usr/bin/env bash
#
# Works out which eval content repository to run against. Sourced by eval.sh and eval-all.sh.
#
# Call `resolve_config "$@"`; it sets the array EVAL_CONFIG_ARGS to either `--config <path>` or
# nothing (when the caller already passed --config), and exits on a bad or missing selection.
#
# Deliberately NOT hardcoded to a knowledge base: the harness holds no eval content and must not name
# one. Resolution order:
#
#   1. an explicit --config on the command line  (these scripts then add nothing)
#   2. $YVOKE_EVAL_CONFIG
#   3. the .eval-config file in this directory   (gitignored; one line, a path)

_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EVAL_CONFIG="${YVOKE_EVAL_CONFIG:-}"
EVAL_CONFIG_SOURCE='$YVOKE_EVAL_CONFIG'
if [ -z "$EVAL_CONFIG" ] && [ -f "$_repo_root/.eval-config" ]; then
  # First non-blank, non-comment line.
  EVAL_CONFIG="$(grep -vE '^[[:space:]]*(#|$)' "$_repo_root/.eval-config" | head -n1 | tr -d '[:space:]')"
  EVAL_CONFIG_SOURCE='.eval-config'
fi

# Must run in the caller's shell, not a subshell — `exit` inside $(...) would only end the subshell
# and the wrapped command would then run with no config at all.
resolve_config() {
  EVAL_CONFIG_ARGS=()

  for arg in "$@"; do
    case "$arg" in
      --config|--config=*) return 0 ;;
    esac
  done

  if [ -z "$EVAL_CONFIG" ]; then
    cat >&2 <<'EOF'
No eval config selected.

Eval content — suites, graders and baselines — lives in its own repository, one per knowledge base.
This harness contains none, so it needs to be told which one to run against. Pick one:

  echo ../yvoke-eval-oim/yvoke-eval.yaml > .eval-config       # persistent, gitignored
  export YVOKE_EVAL_CONFIG=../yvoke-eval-oim/yvoke-eval.yaml  # this shell only
  ./eval-all.sh --config ../yvoke-eval-oim/yvoke-eval.yaml    # one invocation
EOF
    exit 2
  fi

  if [ ! -f "$EVAL_CONFIG" ] && [ ! -f "$_repo_root/$EVAL_CONFIG" ]; then
    echo "Eval config not found: $EVAL_CONFIG (from $EVAL_CONFIG_SOURCE)" >&2
    exit 2
  fi

  EVAL_CONFIG_ARGS=(--config "$EVAL_CONFIG")
}

# bash 3.2 (macOS) errors on "${arr[@]}" when the array is empty and `set -u` is on.
config_args() {
  printf '%s\n' ${EVAL_CONFIG_ARGS[@]+"${EVAL_CONFIG_ARGS[@]}"}
}
