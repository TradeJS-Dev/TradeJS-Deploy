#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${DEPLOY_ROOT:-$HOME}"
exec python3 "${script_dir}/capture-runtime-verification.py" "${1:-observe}"
