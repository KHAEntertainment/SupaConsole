#!/usr/bin/env bash
# End-to-end check of SupaConsole on the test VPS. Usage: e2e.sh setup|deploy|verify|delete
# Secrets (session cookie, generated project keys) stay in /root/e2e (mode 700) and are never printed.
set -uo pipefail
# E2E_BASE / E2E_WORKDIR / E2E_APP_DIR default to the test VPS layout; override
# them to point the same checks at another instance.
BASE=${E2E_BASE:-http://localhost:3000}
W=${E2E_WORKDIR:-/root/e2e}; mkdir -p "$W"; chmod 700 "$W"
APP=${E2E_APP_DIR:-/opt/supaconsole}
# The realtime helper package: E2E_REALTIME_DIR, else a realtime-check/ next to
# this script (running from a checkout), else the installed app's copy (this
# script copied alone to /root, as ops/README.md describes).
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
if [ -n "${E2E_REALTIME_DIR:-}" ]; then RT=$E2E_REALTIME_DIR
elif [ -f "$SCRIPT_DIR/realtime-check/check.mjs" ]; then RT=$SCRIPT_DIR/realtime-check
else RT=$APP/ops/realtime-check
fi
JAR="$W/cookies.txt"
step() { echo; echo "=== [$(date +%H:%M:%S)] $* ==="; }
api() { # api METHOD PATH [JSON] [MAXTIME] -> prints "HTTP <code> <body excerpt>"
  local m=$1 p=$2 d=${3:-} t=${4:-60} out code
  out=$(curl -s -m "$t" -b "$JAR" -c "$JAR" -X "$m" -H 'Content-Type: application/json' ${d:+-d "$d"} -w '\n%{http_code}' "$BASE$p")
  code=${out##*$'\n'}; echo "HTTP $code $(printf '%s' "${out%$'\n'*}" | head -c 300)"
}
code_of() { # code_of "HTTP <code> <body>" -> <code> (for check())
  local o=${1#HTTP }
  printf '%s' "${o%% *}"
}
# log_gate CONTAINER -> PASS/FAIL "gateway access log contains neither API key"
# (Gate 1 finding D: Envoy's access log records request paths). The log is read
# into a private file first so a failed read (e.g. a logging driver that can't
# be read back) or an empty log fails the gate rather than passing as "no
# matches"; only grep's no-match result passes. The keys reach grep through a
# pipe, never argv; matching lines are counted, never printed, and the file
# stays in the mode-700 workdir until it is removed.
log_gate() {
  local gwlog="$W/gateway.log" rc leaks lines
  ( umask 077; : > "$gwlog" )
  docker logs "$1" > "$gwlog" 2>&1; rc=$?
  if [ "$rc" != 0 ]; then
    echo "  FAIL  gateway access log could not be read (docker logs exit $rc)"; fail=$((fail+1))
  else
    lines=$(wc -l < "$gwlog" | tr -d ' ')
    leaks=$(grep -cFf <(printf '%s\n%s\n' "$ANON" "$SVC") "$gwlog"); rc=$?
    if [ "$lines" = 0 ]; then
      echo "  FAIL  gateway access log is empty (nothing to check)"; fail=$((fail+1))
    elif [ "$rc" = 1 ]; then
      echo "  PASS  gateway access log contains neither API key ($lines lines read)"; pass=$((pass+1))
    elif [ "$rc" = 0 ]; then
      echo "  FAIL  gateway access log contains an API key on $leaks line(s)"; fail=$((fail+1))
    else
      echo "  FAIL  gateway access log could not be searched (grep exit $rc)"; fail=$((fail+1))
    fi
  fi
  rm -f "$gwlog"
}

project_id() { jq -r .project.id "$W/project.json"; }
project_slug() { jq -r .project.slug "$W/project.json"; }

case "${1:-}" in
setup)
  step "register + login"
  api POST /api/auth/register '{"email":"e2e@example.com","password":"e2e-Test-pass-1","name":"E2E"}'
  api POST /api/auth/login '{"email":"e2e@example.com","password":"e2e-Test-pass-1"}'
  step "initialize (clone supabase core)"
  s=$SECONDS; api POST /api/projects/initialize '' 1800; echo "took $((SECONDS-s))s"
  git -C "$APP/supabase-core" log --oneline -1 2>&1 | head -1
  step "create project"
  curl -s -m 300 -b "$JAR" -X POST -H 'Content-Type: application/json' -d '{"name":"compat-e2e"}' "$BASE/api/projects" > "$W/project.json"
  jq '{id: .project.id, slug: .project.slug, error: .error}' "$W/project.json"
  # T1 carry-over: a create-project response without .project.id is fatal.
  # The register call above stays non-fatal ("already exists" is an expected 400/403).
  ID=$(project_id)
  if [ -z "$ID" ] || [ "$ID" = "null" ]; then
    echo "FAIL: create project response has no .project.id"
    exit 1
  fi
  ;;
deploy)
  step "deploy project $(project_id)"
  s=$SECONDS; api POST "/api/projects/$(project_id)/deploy" '' 3600; echo "took $((SECONDS-s))s"
  step "containers"
  docker ps -a --format 'table {{.Names}}\t{{.Status}}' | sort
  ;;
verify)
  ID=$(project_id)
  SLUG=$(project_slug)
  curl -s -m 60 -b "$JAR" "$BASE/api/projects/$ID/env" > "$W/vars.json"; chmod 600 "$W/vars.json"
  v() { jq -r --arg k "$1" '.envVars[$k] // empty' "$W/vars.json"; }
  ANON=$(v ANON_KEY); SVC=$(v SERVICE_ROLE_KEY); GW=$(v API_GW_HTTP_PORT); DU=$(v DASHBOARD_USERNAME); DP=$(v DASHBOARD_PASSWORD)
  echo "vars loaded: $(jq '.envVars|length' "$W/vars.json") keys; gateway port $GW; anon ${ANON:+set}; service ${SVC:+set}; dashboard creds ${DP:+set}"
  FORGED="$(cut -d. -f1-2 <<<"$SVC").$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
  G=http://localhost:$GW
  code() { curl -s -o /dev/null -m 30 -w '%{http_code}' "$@"; }
  pass=0; fail=0
  # check LABEL ALLOWED [GOT] -> prints PASS/FAIL, tallies
  # ALLOWED is slash-separated; any of the listed codes is accepted (e.g. "200/307").
  check() {
    local label=$1 allowed=$2 got=${3:-}
    local ok=0 c
    IFS=/ read -r -a codes <<<"$allowed"
    for c in "${codes[@]}"; do [ "$got" = "$c" ] && ok=1 && break; done
    if [ "$ok" = 1 ]; then
      printf '  PASS  %-58s expect %-7s got %s\n' "$label" "$allowed" "$got"
      pass=$((pass+1))
    else
      printf '  FAIL  %-58s expect %-7s got %s\n' "$label" "$allowed" "$got"
      fail=$((fail+1))
    fi
  }

  step "container health"
  docker ps -a --format '{{.Names}}\t{{.Status}}' | sort
  UNHEALTHY=$(docker ps -a --format '{{.Status}}' | grep -ciE 'unhealthy|exited|restarting' || true)
  if [ "$UNHEALTHY" = 0 ]; then
    echo "  PASS  no unhealthy/exited/restarting containers"; pass=$((pass+1))
  else
    echo "  FAIL  $UNHEALTHY unhealthy/exited/restarting container(s)"; fail=$((fail+1))
  fi

  step "gateway + services"
  # REST root with the anon key: upstream is now admin-only (Supabase discussion
  # #42949), so the public REST root returns 403. The compatibility audit records
  # 403; that is the value this gate expects.
  check "REST root, anon key"                       403     "$(code -H "apikey: $ANON" "$G/rest/v1/")"
  check "REST root, no key"                         401     "$(code "$G/rest/v1/")"
  check "Auth health, anon key"                     200     "$(code -H "apikey: $ANON" "$G/auth/v1/health")"
  check "Auth admin/users, service key"             200     "$(code -H "apikey: $SVC" -H "Authorization: Bearer $SVC" "$G/auth/v1/admin/users")"
  check "Auth admin/users, anon key (role check)"   403     "$(code -H "apikey: $ANON" -H "Authorization: Bearer $ANON" "$G/auth/v1/admin/users")"
  check "Auth admin/users, forged signature"        401/403 "$(code -H "apikey: $FORGED" -H "Authorization: Bearer $FORGED" "$G/auth/v1/admin/users")"
  check "Storage buckets, service key"              200     "$(code -H "apikey: $SVC" -H "Authorization: Bearer $SVC" "$G/storage/v1/bucket")"
  check "Studio via gateway, dashboard creds"       200/307 "$(code -u "$DU:$DP" "$G/")"
  check "Studio via gateway, no creds"              401     "$(code "$G/")"

  step "data path: SQL -> PostgREST"
  DB=$(docker ps --filter label=com.docker.compose.project="$SLUG" --filter label=com.docker.compose.service=db --format '{{.Names}}' | head -1)
  docker exec "$DB" psql -U postgres -tAc 'select version()' | cut -c1-60
  docker exec "$DB" psql -U postgres -q -c "create table if not exists public.e2e_ping(id int primary key, note text);
    insert into public.e2e_ping values (1,'hello from supaconsole') on conflict do nothing;
    grant select on public.e2e_ping to anon; notify pgrst, 'reload schema';"
  sleep 3
  DATA=$(curl -s -m 30 -H "apikey: $ANON" "$G/rest/v1/e2e_ping?select=*")
  echo "  anon GET /rest/v1/e2e_ping -> $DATA"
  if printf '%s' "$DATA" | grep -q '"id":1'; then
    echo "  PASS  data path returns the seeded row"; pass=$((pass+1))
  else
    echo "  FAIL  data path did not return the seeded row"; fail=$((fail+1))
  fi

  step "realtime: subscribe (anon) + insert (service key) -> event"
  # Gate 1 finding A: realtime through the gateway broke unnoticed because this
  # gate never exercised it. Pinned client in ops/realtime-check; keys go to it
  # through the environment and are never printed.
  docker exec "$DB" psql -U postgres -q -v ON_ERROR_STOP=1 -c "set client_min_messages = warning; create table if not exists public.e2e_realtime(id bigint generated always as identity primary key, note text);
    grant select on public.e2e_realtime to anon; grant insert on public.e2e_realtime to service_role;
    do \$\$ begin
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'e2e_realtime') then
        alter publication supabase_realtime add table public.e2e_realtime;
      end if;
    end \$\$; notify pgrst, 'reload schema';"
  sleep 2
  if [ ! -f "$RT/check.mjs" ]; then
    echo "  (realtime helper not found at $RT; set E2E_REALTIME_DIR)"
  elif [ ! -d "$RT/node_modules/@supabase/supabase-js" ] || [ ! -d "$RT/node_modules/ws" ]; then
    npm ci --prefix "$RT" --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || echo "  (npm ci in $RT failed)"
  fi
  RT_OUT=$(SUPABASE_URL="$G" SUPABASE_ANON_KEY="$ANON" SUPABASE_SERVICE_ROLE_KEY="$SVC" REALTIME_TIMEOUT_MS=60000 \
    node "$RT/check.mjs" 2>&1 | tail -1); RT_RC=${PIPESTATUS[0]}
  echo "  $RT_OUT"
  if [ "$RT_RC" = 0 ]; then
    echo "  PASS  realtime INSERT event received through the gateway"; pass=$((pass+1))
  else
    echo "  FAIL  realtime INSERT event not received through the gateway"; fail=$((fail+1))
  fi
  # Neither key may appear in the gateway's access log (see log_gate). A
  # websocket's line is written when its stream ends, so give the realtime
  # client's connection a moment to be logged first.
  sleep 3
  GWC=$(docker ps --filter label=com.docker.compose.project="$SLUG" --filter label=com.docker.compose.service=api-gw --format '{{.Names}}' | head -1)
  if [ -z "$GWC" ]; then
    echo "  FAIL  gateway log has no API keys (gateway container not found)"; fail=$((fail+1))
  else
    log_gate "$GWC"
  fi

  step "listening sockets (compose binds 0.0.0.0; DOCKER-USER must block them, so probe from outside too)"
  ss -ltnH | awk '{print $4}' | sort -u | tr '\n' ' '; echo

  step "second-user authorization"
  # A second user must not reach someone else's project: env, deploy and delete
  # all return the same 404 as a missing project, and the project survives.
  # Registration must be explicitly allowed for this test (server-side
  # ALLOW_REGISTRATION=true); the register check fails if it is not.
  JAR2="$W/cookies-user2.txt"; rm -f "$JAR2"
  JAR_MAIN="$JAR"; JAR="$JAR2"
  USER2_EMAIL="e2e-user2-$(date +%s)@example.com"
  USER2_PASS="e2e-Test-pass-2"
  out=$(api POST /api/auth/register "{\"email\":\"$USER2_EMAIL\",\"password\":\"$USER2_PASS\",\"name\":\"E2E User2\"}" 60)
  echo "  register $USER2_EMAIL: $out"
  check "second user register (registration allowed for test)" 200 "$(code_of "$out")"
  out=$(api POST /api/auth/login "{\"email\":\"$USER2_EMAIL\",\"password\":\"$USER2_PASS\"}" 60)
  echo "  login $USER2_EMAIL: $out"
  check "second user login"                                    200 "$(code_of "$out")"
  out=$(api GET "/api/projects/$ID/env" '' 30)
  echo "  GET /env: HTTP $(code_of "$out")"
  check "second user GET /env on owner's project"              404 "$(code_of "$out")"
  out=$(api POST "/api/projects/$ID/env" '{"TEST_VAR":"hack"}' 30)
  echo "  POST /env: $out"
  check "second user POST /env on owner's project"             404 "$(code_of "$out")"
  out=$(api POST "/api/projects/$ID/deploy" '' 600)
  echo "  POST /deploy: $out"
  check "second user POST /deploy on owner's project"          404 "$(code_of "$out")"
  out=$(api DELETE "/api/projects/$ID" '' 600)
  echo "  DELETE /: $out"
  check "second user DELETE on owner's project"                404 "$(code_of "$out")"
  JAR="$JAR_MAIN"
  # The project must still exist: owner reads it back with its env vars intact.
  # (An empty 200 is not existence — a deleted project still answers 200 {}.)
  raw=$(curl -s -m 30 -b "$JAR" -w '\n%{http_code}' "$BASE/api/projects/$ID/env")
  body=${raw%$'\n'*}; sc=${raw##*$'\n'}
  keys=$(printf '%s' "$body" | jq -r '.envVars | length' 2>/dev/null || echo 0)
  if [ "$sc" = 200 ] && [ "${keys:-0}" -gt 0 ] 2>/dev/null; then
    echo "  PASS  project still exists for owner (HTTP $sc, $keys env keys)"; pass=$((pass+1))
  else
    echo "  FAIL  project still exists for owner (HTTP $sc, $keys env keys)"; fail=$((fail+1))
  fi

  step "summary"
  echo "  passed: $pass"
  echo "  failed: $fail"
  if [ "$fail" -gt 0 ]; then
    echo "  RESULT: FAIL"
    exit 1
  fi
  echo "  RESULT: PASS"
  ;;
delete)
  step "delete project $(project_id)"
  api DELETE "/api/projects/$(project_id)" '' 600
  SLUG=$(project_slug)
  CONTAINERS=$(docker ps -aq --filter label=com.docker.compose.project="$SLUG" | wc -l | tr -d ' ')
  DIRS=$(ls -1 "$APP/supabase-projects" 2>/dev/null | grep -F "$SLUG" | wc -l | tr -d ' ')
  VOLUMES=$(docker volume ls -q --filter label=com.docker.compose.project="$SLUG" | wc -l | tr -d ' ')
  NETWORKS=$(docker network ls -q --filter label=com.docker.compose.project="$SLUG" | wc -l | tr -d ' ')
  echo "containers left: $CONTAINERS; project dirs: $DIRS; volumes: $VOLUMES; networks: $NETWORKS"
  if [ "$CONTAINERS" -gt 0 ] || [ "$DIRS" -gt 0 ] || [ "$VOLUMES" -gt 0 ] || [ "$NETWORKS" -gt 0 ]; then
    echo "RESULT: FAIL"
    exit 1
  fi
  echo "RESULT: PASS"
  ;;
*) echo "usage: $0 setup|deploy|verify|delete"; exit 2 ;;
esac
