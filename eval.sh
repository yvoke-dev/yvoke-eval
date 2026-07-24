#!/usr/bin/env bash
#
# Thin wrapper around the eval CLI that supplies --config for you.
#
#   ./eval.sh run --category getting_started --limit 1     # one live question
#   ./eval.sh run --dry-run                                # plan only, no model calls
#   ./eval.sh compare --run <run-id> --gate
#   ./eval.sh promote <run-id> --baseline ./eval/baseline-sdk-single
#
# The config names a knowledge base, so it is NOT hardcoded here — the harness stays KB-agnostic.
# See resolve-config.sh for where it comes from.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=resolve-config.sh
source ./resolve-config.sh

if [ "$#" -eq 0 ]; then
  echo "usage: ./eval.sh <run|compare|promote> [options]" >&2
  exit 2
fi

resolve_config "$@"
exec npx tsx src/cli.ts ${EVAL_CONFIG_ARGS[@]+"${EVAL_CONFIG_ARGS[@]}"} "$@"
