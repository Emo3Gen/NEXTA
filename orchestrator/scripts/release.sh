#!/usr/bin/env bash
set -euo pipefail

# NEXA release script: tests -> commit -> push
# Usage:
#   ./scripts/release.sh "commit message"
#
# Env:
#   BASE_URL (default http://localhost:8001)
#   CHAT_ENDPOINT (default /api/message)

BASE_URL="${BASE_URL:-http://localhost:8001}"
CHAT_ENDPOINT="${CHAT_ENDPOINT:-/api/message}"

MSG="${1:-release: $(date +%F-%H%M)}"

echo "== NEXA RELEASE =="
echo "BASE_URL=${BASE_URL}"
echo "CHAT_ENDPOINT=${CHAT_ENDPOINT}"
echo "Commit message: ${MSG}"
echo

# 1) Run scenario tests (fails release if red)
echo "== Running scenario tests =="
BASE_URL="${BASE_URL}" CHAT_ENDPOINT="${CHAT_ENDPOINT}" npm run test:scenarios
echo "== Tests passed =="
echo

# 2) Ensure there is something to commit
if git diff --quiet && git diff --cached --quiet; then
  echo "No changes to commit."
  echo "If you still want to deploy, make a no-op commit manually."
  exit 0
fi

# 3) Commit
echo "== Committing =="
git add -A
git commit -m "${MSG}"
echo

# 4) Push current branch
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "== Pushing branch: ${BRANCH} =="
git push origin "${BRANCH}"
echo

echo "✅ Release push complete."
echo "If Render is configured to auto-deploy from this branch, it will deploy now."
