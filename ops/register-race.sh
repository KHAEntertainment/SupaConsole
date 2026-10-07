#!/usr/bin/env bash
# Regression: concurrent first-account registrations must yield exactly one 200.
#
# On an empty database with ALLOW_REGISTRATION unset, N concurrent registrations
# with distinct emails must produce exactly one 200 and N-1 403s ("Registration
# is closed") and leave exactly one user row. Run locally against a fresh SQLite
# DB — not against a shared instance whose DB already has users.
#
# Usage: ops/register-race.sh   (from the repo root; npm ci + prisma generate done)
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
PORT=${PORT:-3399}
N=${N:-8}
WORK=$(mktemp -d)
DB="file:$WORK/race.db"
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "=== fresh database $DB"
DATABASE_URL="$DB" npx prisma db push --skip-generate >/dev/null || { echo "FAIL: prisma db push"; exit 1; }

echo "=== build + start server on 127.0.0.1:$PORT (ALLOW_REGISTRATION unset)"
npm run build >/dev/null 2>&1 || { echo "FAIL: npm run build"; exit 1; }
env -u ALLOW_REGISTRATION DATABASE_URL="$DB" npx next start -H 127.0.0.1 -p "$PORT" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 60); do
  curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/api/auth/register" -X POST \
    -H 'Content-Type: application/json' -d '{}' 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "FAIL: server died"; exit 1; }
  sleep 1
done

echo "=== fire $N concurrent registrations (distinct emails, empty DB)"
pids=()
for i in $(seq 1 "$N"); do
  curl -s -o "$WORK/resp.$i" -w '%{http_code}' -m 60 -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"race-$i-$(date +%s)@test.local\",\"password\":\"race-Pass-1\",\"name\":\"R$i\"}" \
    "http://127.0.0.1:$PORT/api/auth/register" >"$WORK/code.$i" &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done

echo "=== results"
codes=$(for f in "$WORK"/code.*; do cat "$f"; echo; done | sort | uniq -c | sed 's/^ */  /')
echo "$codes"
ok200=$(grep -c '^200$' "$WORK"/code.* | awk -F: '{s+=$2} END {print s+0}')
ok403=$(grep -c '^403$' "$WORK"/code.* | awk -F: '{s+=$2} END {print s+0}')
users=$(DATABASE_URL="$DB" node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.user.count().then(n=>{console.log(n);return p.\$disconnect()})")
echo "  200s: $ok200; 403s: $ok403; users in DB: $users"

if [ "$ok200" = 1 ] && [ "$ok403" = "$((N-1))" ] && [ "$users" = 1 ]; then
  echo "RESULT: PASS (exactly one 200, $((N-1)) 403s, one user row)"
  exit 0
fi
echo "RESULT: FAIL (expected one 200, $((N-1)) 403s, one user row)"
exit 1
