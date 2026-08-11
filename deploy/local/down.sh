#!/usr/bin/env bash
# Tear down the local kind cluster (and everything in it). Safe to re-run.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
kind delete cluster --name crmf-local
echo "✔ kind cluster 'crmf-local' deleted."
