#!/usr/bin/env bash
# Validates the firewall helper installed by ops/vps-setup.sh.
# Requires iptables and a Linux kernel (skipped on other platforms).
# Three checks:
#   1. happy path lands RETURN then DROP for the WAN interface, no leftover guard.
#   2. guard insert fails on the Nth call → non-zero exit, chain unchanged.
#   3. permanent DROP insert fails on the Nth call → non-zero exit, the WAN
#      interface still has a DROP (the guard or the original).
set -eu

HELPER=/usr/local/sbin/docker-user-lockdown.sh
[ -x "${HELPER}" ] || { echo "skip: ${HELPER} not installed"; exit 0; }
command -v iptables >/dev/null 2>&1 || { echo "skip: iptables not available"; exit 0; }
[ "$(uname -s)" = "Linux" ] || { echo "skip: linux-only test"; exit 0; }

SCRATCH="SCRATCH-$$"
WAN="eth0"

# Stub iptables via PATH override. The stub logs every call; setting
# FAIL_ON_CALL=N makes the Nth call exit non-zero. Calls that mention the
# scratch chain are passed through to real iptables so the test exercises
# actual rule state; calls for any other chain are no-ops.
STUB_DIR=$(mktemp -d)
LOG=$(mktemp)
: > "${LOG}"

cat > "${STUB_DIR}/iptables" <<EOF
#!/bin/sh
# PATH points at this stub dir so a bare "iptables" would resolve back here
# and infinitely self-exec. Walk the system PATH (sans our stub dir) to find
# the real binary. /usr/sbin/iptables is the canonical location on Ubuntu
# 24.04; fall back to whatever PATH says if it's missing.
REAL_IPTABLES=/usr/sbin/iptables
[ -x "\$REAL_IPTABLES" ] || REAL_IPTABLES=\$(PATH=/usr/sbin:/sbin:/bin:/usr/bin command -v iptables)
echo "\$*" >> "${LOG}"
COUNT=\$(wc -l < "${LOG}")
if [ "\${FAIL_ON_CALL:-0}" = "\$COUNT" ]; then
  echo "iptables stub: failing on call \$COUNT: \$*" >&2
  exit 1
fi
case "\$*" in
  *${SCRATCH}*) exec "\$REAL_IPTABLES" "\$@" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "${STUB_DIR}/iptables"
# ip6tables stub: fall through to the real binary so delete-while loops
# return non-zero and exit (real ip6tables doesn't have the SCRATCH chain,
# so every operation against it fails, which is the same observable behavior
# the helper would get in production on a host without ip6tables).
cat > "${STUB_DIR}/ip6tables" <<'EOF'
#!/bin/sh
REAL_IP6TABLES=/usr/sbin/ip6tables
[ -x "$REAL_IP6TABLES" ] || REAL_IP6TABLES=$(PATH=/usr/sbin:/sbin:/bin:/usr/bin command -v ip6tables)
exec "$REAL_IP6TABLES" "$@"
EOF
chmod +x "${STUB_DIR}/ip6tables"

cleanup() {
  rm -rf "${STUB_DIR}" "${LOG}" 2>/dev/null || true
  iptables -F "${SCRATCH}" 2>/dev/null || true
  iptables -X "${SCRATCH}" 2>/dev/null || true
}
trap cleanup EXIT

# Reset scratch chain with a stale order: DROP then RETURN.
reset_chain() {
  iptables -N "${SCRATCH}" 2>/dev/null || iptables -F "${SCRATCH}"
  iptables -F "${SCRATCH}"
  iptables -A "${SCRATCH}" -i "${WAN}" -j DROP
  iptables -A "${SCRATCH}" -i "${WAN}" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
}

run_helper() {
  CHAIN="${SCRATCH}" PATH="${STUB_DIR}:${PATH}" "${HELPER}"
}

echo "=== Test 1: happy path ==="
reset_chain
: > "${LOG}"
run_helper || { echo "FAIL: happy path exited non-zero"; exit 1; }
chain=$(iptables -S "${SCRATCH}" | grep -v '^-N')
first=$(printf '%s\n' "${chain}"  | sed -n '1p')
second=$(printf '%s\n' "${chain}" | sed -n '2p')
echo "  first:  ${first}"
echo "  second: ${second}"
echo "${first}"  | grep -q 'ctstate RELATED,ESTABLISHED.*RETURN' || { echo "FAIL: line 1 should be RETURN for ESTABLISHED"; exit 1; }
echo "${second}" | grep -q -- '-j DROP' || { echo "FAIL: line 2 should be DROP"; exit 1; }
guarded=$(printf '%s\n' "${chain}" | grep -c docker-user-lockdown-guard || true)
[ "${guarded}" = "0" ] || { echo "FAIL: ${guarded} guard rule(s) left behind"; exit 1; }

echo "=== Test 2: guard insert fails on call 2; helper exits non-zero, chain unchanged ==="
reset_chain
before=$(iptables -S "${SCRATCH}" | md5sum)
: > "${LOG}"
set +e
FAIL_ON_CALL=2 run_helper
rc=$?
set -e
[ "${rc}" -ne 0 ] || { echo "FAIL: expected non-zero exit on guard insert failure (rc=${rc})"; exit 1; }
after=$(iptables -S "${SCRATCH}" | md5sum)
[ "${before}" = "${after}" ] || { echo "FAIL: chain was modified despite guard insert failure"; exit 1; }

echo "=== Test 3: permanent DROP insert fails on call 8; chain keeps a DROP for ${WAN} ==="
# The helper makes these iptables calls per invocation (call numbers verified
# via the bash -x trace):
#   1  -w -n -L (chain exists check)
#   2  -w -I ... -j DROP -m comment (guard insert)
#   3  -w -D ... -j RETURN (delete RETURN; succeeds, while retries)
#   4  -w -D ... -j RETURN (delete RETURN; fails, while exits)
#   5  -w -D ... -j DROP (delete DROP; succeeds, while retries)
#   6  -w -D ... -j DROP (delete DROP; fails, while exits)
#   7  -w -I ... -j RETURN (permanent RETURN insert)
#   8  -w -I ... -j DROP (permanent DROP insert)
#   9  -w -C ... -j RETURN (verify RETURN)
#  10  -w -C ... -j DROP (verify DROP)
#  11  -w -D ... -m comment (remove guard; succeeds, while retries)
#  12  -w -D ... -m comment (remove guard; fails, while exits)
reset_chain
: > "${LOG}"
set +e
FAIL_ON_CALL=8 run_helper
rc=$?
set -e
[ "${rc}" -ne 0 ] || { echo "FAIL: expected non-zero exit on DROP insert failure (rc=${rc})"; exit 1; }
state=$(iptables -S "${SCRATCH}")
echo "  state: ${state}"
printf '%s\n' "${state}" | grep -q -- "-i ${WAN}.*DROP" || { echo "FAIL: no DROP for ${WAN} after failed insertion"; exit 1; }

echo "PASS"