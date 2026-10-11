#!/usr/bin/env bash
# Validates log_gate from ops/e2e.sh (the "gateway access log contains neither
# API key" check) against a stubbed `docker logs`. No Docker needed.
#   1. docker logs fails (e.g. unreadable logging driver)  -> FAIL, not PASS
#   2. docker logs succeeds but returns nothing            -> FAIL
#   3. clean log                                           -> PASS
#   4. a line carries the anon key                         -> FAIL
#   5. a line carries the service key                      -> FAIL
# and in every case no key value reaches the output.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d); chmod 700 "$W"
trap 'rm -rf "$W"' EXIT

# Pull just the log_gate function out of e2e.sh.
eval "$(sed -n '/^log_gate() {$/,/^}$/p' "$HERE/e2e.sh")"
declare -F log_gate >/dev/null || { echo "FAIL: log_gate not found in e2e.sh"; exit 1; }

ANON="anon.$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
SVC="svc.$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"

# docker stub: STUB_RC is its exit status, STUB_OUT what it prints.
docker() { printf '%s' "${STUB_OUT:-}"; [ -n "${STUB_ERR:-}" ] && printf '%s\n' "$STUB_ERR" >&2; return "${STUB_RC:-0}"; }

failures=0
case_() { # case_ NAME EXPECT(PASS|FAIL)
  local name=$1 want=$2 out
  pass=0; fail=0
  out=$(log_gate gw 2>&1; echo "tally $pass $fail")
  local got=FAIL; [[ "$out" == *"tally 1 0"* ]] && got=PASS
  if [ "$got" != "$want" ]; then
    echo "FAIL  $name: expected $want, got: $out"; failures=$((failures+1))
  elif [[ "$out" == *"$ANON"* || "$out" == *"$SVC"* ]]; then
    echo "FAIL  $name: a key was printed"; failures=$((failures+1))
  elif [ -e "$W/gateway.log" ]; then
    echo "FAIL  $name: captured log left behind"; failures=$((failures+1))
  else
    echo "ok    $name -> $(printf '%s' "$out" | head -1 | sed 's/^ *//')"
  fi
}

STUB_RC=1 STUB_OUT='' STUB_ERR='Error response from daemon: configured logging driver does not support reading' \
  case_ "docker logs fails" FAIL
STUB_RC=0 STUB_OUT='' STUB_ERR='' case_ "empty log" FAIL
STUB_RC=0 STUB_OUT=$'[2026] "GET /auth/v1/health HTTP/1.1" 200\n[2026] "GET /realtime/v1/websocket?vsn=1.0.0 HTTP/1.1" 101\n' STUB_ERR='' \
  case_ "clean log" PASS
STUB_RC=0 STUB_OUT=$'[2026] "GET /realtime/v1/websocket?apikey='"$ANON"$'&vsn=2.0.0 HTTP/1.1" 101\n' STUB_ERR='' \
  case_ "anon key in a URL" FAIL
STUB_RC=0 STUB_OUT=$'ok line\n[2026] "GET /rest/v1/x?apikey='"$SVC"$' HTTP/1.1" 200\n' STUB_ERR='' \
  case_ "service key in a URL" FAIL

if [ "$failures" -gt 0 ]; then echo "RESULT: FAIL ($failures)"; exit 1; fi
echo "RESULT: PASS"
