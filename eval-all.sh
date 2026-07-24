#!/usr/bin/env bash
#
# Sweep a whole suite, one category per process, supplying --config for you.
#
#   ./eval-all.sh --dry-run                                  # plan only, no model calls
#   ./eval-all.sh --promote ./eval/baseline-sdk-single       # full sweep, promote as it goes
#   ./eval-all.sh --from ts_databases                        # resume where a sweep stopped
#   ./eval-all.sh --only db_history,customers --continue
#
# One process per category because `run` writes nothing until its question loop finishes: a single
# invocation over every category is all-or-nothing.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=resolve-config.sh
source ./resolve-config.sh

resolve_config "$@"
exec npx tsx scripts/run-all.ts ${EVAL_CONFIG_ARGS[@]+"${EVAL_CONFIG_ARGS[@]}"} "$@"
