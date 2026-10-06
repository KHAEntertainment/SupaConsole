#!/usr/bin/env bash
# End-to-end check of SupaConsole on the test VPS. Usage: e2e.sh setup|deploy|verify
# Secrets (session cookie, generated project keys) stay in /root/e2e (mode 700) and are never printed.
set -uo pipefail
BASE=http://localhost:3000
W=/root/e2e; mkdir -p "$W"; chmod 700 "$W"
JAR="$W/cookies.txt"
step() { echo; echo "=== [$(date +%H:%M:%S)] $* ==="; }
api() { # api METHOD PATH [JSON] [MAXTIME] -> prints "HTTP <code> <body excerpt>"
  local m=$1 p=$2 d=${3:-} t=${4:-60} out code
  out=$(curl -s -m "$t" -b "$JAR" -c "$JAR" -X "$m" -H 'Content-Type: application/json' ${d:+-d "$d"} -w '\n%{http_code}' "$BASE$p")
  code=${out##*$'\n'}; echo "HTTP $code $(printf '%s' "${out%$'\n'*}" | head -c 300)"
}
project_id() { jq -r .project.id "$W/project.json"; }

case "${1:-}" in
setup)
  step "register + login"
  api POST /api/auth/register '{"email":"e2e@example.com","password":"e2e-Test-pass-1","name":"E2E"}'
  api POST /api/auth/login '{"email":"e2e@example.com","password":"e2e-Test-pass-1"}'
  step "initialize (clone supabase core)"
  s=$SECONDS; api POST /api/projects/initialize '' 1800; echo "took $((SECONDS-s))s"
  git -C /opt/supaconsole/supabase-core log --oneline -1 2>&1 | head -1
  step "create project"
  curl -s -m 300 -b "$JAR" -X POST -H 'Content-Type: application/json' -d '{"name":"compat-e2e"}' "$BASE/api/projects" > "$W/project.json"
  jq '{id: .project.id, slug: .project.slug, error: .error}' "$W/project.json"
  ;;
deploy)
  step "deploy project $(project_id)"
  s=$SECONDS; api POST "/api/projects/$(project_id)/deploy" '' 3600; echo "took $((SECONDS-s))s"
  step "containers"
  docker ps -a --format 'table {{.Names}}\t{{.Status}}' | sort
  ;;
verify)
  ID=$(project_id)
  curl -s -m 60 -b "$JAR" "$BASE/api/projects/$ID/env" > "$W/vars.json"; chmod 600 "$W/vars.json"
  v() { jq -r --arg k "$1" '.envVars[$k] // empty' "$W/vars.json"; }
  ANON=$(v ANON_KEY); SVC=$(v SERVICE_ROLE_KEY); GW=$(v API_GW_HTTP_PORT); DU=$(v DASHBOARD_USERNAME); DP=$(v DASHBOARD_PASSWORD)
  echo "vars loaded: $(jq '.envVars|length' "$W/vars.json") keys; gateway port $GW; anon ${ANON:+set}; service ${SVC:+set}; dashboard creds ${DP:+set}"
  FORGED="$(cut -d. -f1-2 <<<"$SVC").$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
  G=http://localhost:$GW
  code() { curl -s -o /dev/null -m 30 -w '%{http_code}' "$@"; }
  row() { printf '%-58s expect %-7s got %s\n' "$1" "$2" "$3"; }

  step "container health"
  docker ps -a --format '{{.Names}}\t{{.Status}}' | sort
  echo "unhealthy/exited: $(docker ps -a --format '{{.Status}}' | grep -ciE 'unhealthy|exited|restarting')"

  step "gateway + services"
  row "REST root, anon key"                      200     "$(code -H "apikey: $ANON" "$G/rest/v1/")"
  row "REST root, no key"                        401     "$(code "$G/rest/v1/")"
  row "Auth health, anon key"                    200     "$(code -H "apikey: $ANON" "$G/auth/v1/health")"
  row "Auth admin/users, service key"            200     "$(code -H "apikey: $SVC" -H "Authorization: Bearer $SVC" "$G/auth/v1/admin/users")"
  row "Auth admin/users, anon key (role check)"  403     "$(code -H "apikey: $ANON" -H "Authorization: Bearer $ANON" "$G/auth/v1/admin/users")"
  row "Auth admin/users, forged signature"       401/403 "$(code -H "apikey: $FORGED" -H "Authorization: Bearer $FORGED" "$G/auth/v1/admin/users")"
  row "Storage buckets, service key"             200     "$(code -H "apikey: $SVC" -H "Authorization: Bearer $SVC" "$G/storage/v1/bucket")"
  row "Studio via gateway, dashboard creds"      200/307 "$(code -u "$DU:$DP" "$G/")"
  row "Studio via gateway, no creds"             401     "$(code "$G/")"

  step "data path: SQL -> PostgREST"
  DB=$(docker ps --filter label=com.docker.compose.service=db --format '{{.Names}}' | head -1)
  docker exec "$DB" psql -U postgres -tAc 'select version()' | cut -c1-60
  docker exec "$DB" psql -U postgres -q -c "create table if not exists public.e2e_ping(id int primary key, note text);
    insert into public.e2e_ping values (1,'hello from supaconsole') on conflict do nothing;
    grant select on public.e2e_ping to anon; notify pgrst, 'reload schema';"
  sleep 3
  echo "anon GET /rest/v1/e2e_ping -> $(curl -s -m 30 -H "apikey: $ANON" "$G/rest/v1/e2e_ping?select=*")"

  step "listening sockets (compose binds 0.0.0.0; DOCKER-USER must block them, so probe from outside too)"
  ss -ltnH | awk '{print $4}' | sort -u | tr '\n' ' '; echo
  ;;
delete)
  step "delete project $(project_id)"
  api DELETE "/api/projects/$(project_id)" '' 600
  echo "containers left: $(docker ps -aq | wc -l); project dirs: $(ls /opt/supaconsole/supabase-projects 2>/dev/null | wc -l)"
  ;;
*) echo "usage: $0 setup|deploy|verify|delete"; exit 2 ;;
esac
