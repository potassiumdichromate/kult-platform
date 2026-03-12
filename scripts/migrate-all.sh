#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# migrate-all.sh
#
# Runs `prisma migrate deploy` for every microservice that owns a Prisma
# schema inside the KULT platform monorepo.
#
# Usage:
#   bash scripts/migrate-all.sh
#   DATABASE_URL=postgres://... bash scripts/migrate-all.sh   # override env
#
# Environment:
#   DATABASE_URL_* variables can be set per-service (see SERVICE_MAP below).
#   If not set, the service inherits DATABASE_URL.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

log()     { echo -e "${CYAN}[migrate]${RESET} $*"; }
success() { echo -e "${GREEN}[migrate] OK${RESET} $*"; }
warn()    { echo -e "${YELLOW}[migrate] WARN${RESET} $*"; }
fail()    { echo -e "${RED}[migrate] FAIL${RESET} $*"; }

# ── Resolve monorepo root ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

log "Platform root: ${PLATFORM_ROOT}"
log "─────────────────────────────────────────────────────────"

# ── Service map: "service-dir:DATABASE_URL_ENV_VAR" ───────────────────────────
# Add or remove services here. Each entry is:
#   <relative path from PLATFORM_ROOT that contains prisma/schema.prisma>:<env var name>
declare -a SERVICES=(
  "services/agent-service:DATABASE_URL_AGENT"
  "services/tournament-service:DATABASE_URL_TOURNAMENT"
  "services/economy-service:DATABASE_URL_ECONOMY"
  "services/settlement-service:DATABASE_URL_SETTLEMENT"
  "services/auth-service:DATABASE_URL_AUTH"
  "services/leaderboard-service:DATABASE_URL_LEADERBOARD"
)

PASS=0
FAIL=0
SKIP=0

# ── Iterate services ──────────────────────────────────────────────────────────
for entry in "${SERVICES[@]}"; do
  SERVICE_DIR="${entry%%:*}"
  DB_ENV_VAR="${entry##*:}"
  FULL_PATH="${PLATFORM_ROOT}/${SERVICE_DIR}"

  echo ""
  log "Service: ${SERVICE_DIR}"

  # Check directory exists
  if [[ ! -d "${FULL_PATH}" ]]; then
    warn "Directory not found, skipping: ${FULL_PATH}"
    ((SKIP++)) || true
    continue
  fi

  # Check prisma schema exists
  if [[ ! -f "${FULL_PATH}/prisma/schema.prisma" ]]; then
    warn "No prisma/schema.prisma found in ${FULL_PATH}, skipping."
    ((SKIP++)) || true
    continue
  fi

  # Resolve DATABASE_URL for this service
  SERVICE_DB_URL="${!DB_ENV_VAR:-${DATABASE_URL:-}}"
  if [[ -z "${SERVICE_DB_URL}" ]]; then
    fail "No database URL found. Set ${DB_ENV_VAR} or DATABASE_URL."
    ((FAIL++)) || true
    continue
  fi

  log "  Running prisma migrate deploy..."

  # Run migration from the service directory so Prisma picks up the correct schema
  if (
    cd "${FULL_PATH}"
    DATABASE_URL="${SERVICE_DB_URL}" npx prisma migrate deploy --schema=./prisma/schema.prisma
  ); then
    success "${SERVICE_DIR} migrations applied."
    ((PASS++)) || true
  else
    fail "${SERVICE_DIR} migration failed!"
    ((FAIL++)) || true
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
log "─────────────────────────────────────────────────────────"
log "Migration summary:"
log "  Passed  : ${PASS}"
log "  Failed  : ${FAIL}"
log "  Skipped : ${SKIP}"

if [[ ${FAIL} -gt 0 ]]; then
  fail "One or more migrations failed. Check output above."
  exit 1
fi

success "All migrations completed successfully."
exit 0
