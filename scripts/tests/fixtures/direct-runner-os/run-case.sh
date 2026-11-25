#!/usr/bin/env bash
set -euo pipefail
cp -r /source/scripts /fixture/scripts
# Workspace mounts can be private to their owner; the container's runner must
# be able to read the copied production scripts without writing them.
chmod -R a+rX /fixture/scripts
chmod a+r /fixture/client/package-lock.json
export ROOT_DIR=/fixture
# Preserve the managed container's legitimate egress route across sudo without
# changing production sudo policy. Loopback negative sources remain direct.
python3 - <<'PY'
import json, os, pathlib
proxy = os.environ.get('http_proxy') or os.environ.get('HTTP_PROXY')
if proxy:
    pathlib.Path('/etc/apt/apt.conf.d/80fixture-proxy').write_text(
        'Acquire::http::Proxy ' + json.dumps(proxy) + ';\n'
        'Acquire::http::Proxy::127.0.0.1 "DIRECT";\n')
PY

warm_observed_control() {
  E2E_BROWSER=firefox bash /fixture/scripts/setup-direct-runner-os.sh
  dpkg --remove --force-depends lsof >/dev/null 2>&1 || true
  ! dpkg-query -W -f='${Status}' lsof 2>/dev/null | grep -q 'install ok installed'
  rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* /var/cache/apt/archives/*.deb
}

write_observed_layout() {
  local security_suites=${1:-resolute-security}
  cat > /etc/apt/sources.list.d/ubuntu.sources <<EOF
# Redacted runner image source guidance; comments are preserved.

# A second non-semantic comment paragraph matches the observed source shape.

Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: resolute resolute-updates resolute-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: $security_suites
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
  printf '%s\tpriority:1\n%s\tpriority:2\n%s\tpriority:3\n' \
    http://us-east-2.ec2.archive.ubuntu.com/ubuntu/ \
    https://archive.ubuntu.com/ubuntu/ \
    https://security.ubuntu.com/ubuntu/ > /etc/apt/apt-mirrors.txt
  cat > /etc/apt/apt.conf.d/99observed-layout-paths <<'EOF'
Dir "/";
Dir::Etc "etc/apt";
Dir::Etc::sourcelist "sources.list";
Dir::Etc::sourceparts "sources.list.d";
Dir::Etc::trusted "trusted.gpg";
Dir::Etc::trustedparts "trusted.gpg.d";
EOF
}

start_first_mirror() {
  local block_alternative=${1:-0}
  echo '127.0.0.1 us-east-2.ec2.archive.ubuntu.com' >> /etc/hosts
  echo 'Acquire::http::Proxy::us-east-2.ec2.archive.ubuntu.com "DIRECT";' >> /etc/apt/apt.conf.d/80fixture-proxy
  if [ "$block_alternative" = 1 ]; then
    echo 'Acquire::https::Proxy::archive.ubuntu.com "http://127.0.0.1:18083";' >> /etc/apt/apt.conf.d/80fixture-proxy
  fi
  BLOCK_ALTERNATIVE="$block_alternative" \
    python3 -u /fixture/scripts/tests/fixtures/direct-runner-os/first-mirror-stall.py > /tmp/first-mirror.log 2>&1 &
  proxy_pid=$!
  trap 'cat /tmp/first-mirror.log; kill "$proxy_pid" 2>/dev/null || true' EXIT
  for _ in {1..100}; do grep -q OBSERVED_FIRST_MIRROR_LISTENING /tmp/first-mirror.log && break; sleep .05; done
  grep -q OBSERVED_FIRST_MIRROR_LISTENING /tmp/first-mirror.log
}

case "$1" in
  observed-layout-failover)
    # Warm only the unrelated prerequisites and locked browser. The control
    # below then removes lsof and every cached package byte before exercising
    # the observed source layout through the real setup entry point.
    warm_observed_control
    write_observed_layout
    start_first_mirror
    E2E_BROWSER=firefox bash /fixture/scripts/setup-direct-runner-os.sh 2>&1 | tee /tmp/observed-setup.log
    grep -q 'APT-MIRROR retry-evidence=' /tmp/observed-setup.log
    grep -q 'APT-MIRROR stage=download-retry exit=0' /tmp/observed-setup.log
    grep -q OBSERVED_FIRST_MIRROR_PACKAGE_STALL /tmp/first-mirror.log
    grep -E -q 'https://archive.ubuntu.com/ubuntu.*lsof|lsof.*https://archive.ubuntu.com/ubuntu' /tmp/observed-setup.log
    test "$(dpkg-query -W -f='${Status}' lsof)" = 'install ok installed'
    cd /fixture/client
    node - <<'NODE'
const { firefox } = require('playwright');
(async () => {
  const browser = await firefox.launch({headless: true});
  const page = await browser.newPage();
  await page.setContent('<title>observed failover</title>');
  if (await page.title() !== 'observed failover') throw new Error('browser assertion failed');
  await browser.close();
  console.log('OBSERVED_FAILOVER_FIREFOX_EXECUTED');
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
    ;;
  observed-lookalike-rejected)
    warm_observed_control
    write_observed_layout 'resolute-security resolute'
    E2E_BROWSER=firefox bash /fixture/scripts/setup-direct-runner-os.sh 2>&1 | tee /tmp/lookalike-setup.log
    grep -q 'profile=unsupported reason=unsupported-suite-source-layout' /tmp/lookalike-setup.log
    grep -q 'APT mirror profile unsupported/target absent; using existing setup.' /tmp/lookalike-setup.log
    ! grep -q 'APT-MIRROR stage=download-retry' /tmp/lookalike-setup.log
    grep -q 'Direct-runner setup outcome: stage=ready exit=0' /tmp/lookalike-setup.log
    test "$(dpkg-query -W -f='${Status}' lsof)" = 'install ok installed'
    echo OBSERVED_LOOKALIKE_LEGACY_ONLY
    ;;
  observed-total-failure-no-legacy)
    warm_observed_control
    write_observed_layout
    start_first_mirror 1
    status=0
    E2E_BROWSER=firefox bash /fixture/scripts/setup-direct-runner-os.sh 2>&1 | tee /tmp/total-failure-setup.log || status=$?
    case "$status" in 100|124) ;; *) exit 64 ;; esac
    grep -q 'APT-MIRROR retry-evidence=' /tmp/total-failure-setup.log
    grep -Eq 'APT-MIRROR stage=(retry-update|download-retry) exit=(100|124)' /tmp/total-failure-setup.log
    ! grep -q 'APT-MIRROR stage=install-no-download exit=0' /tmp/total-failure-setup.log
    ! grep -q 'Direct-runner stage: playwright-install-deps' /tmp/total-failure-setup.log
    ! grep -q 'Direct-runner stage: ready' /tmp/total-failure-setup.log
    ! grep -q 'OBSERVED_FAILOVER_FIREFOX_EXECUTED' /tmp/total-failure-setup.log
    ! dpkg-query -W -f='${Status}' lsof 2>/dev/null | grep -q 'install ok installed'
    grep -q OBSERVED_FIRST_MIRROR_PACKAGE_STALL /tmp/first-mirror.log
    grep -q OBSERVED_ALTERNATIVE_BLOCKED /tmp/first-mirror.log
    echo "OBSERVED_TOTAL_FAILURE_VERIFIED exit=$status"
    ;;
  nonroot-success)
    runuser -u runner -- env E2E_BROWSER=firefox bash /fixture/scripts/setup-direct-runner-os.sh
    test "$(stat -c %u /home/runner/.cache/ms-playwright)" = "$(id -u runner)"
    cd /fixture/client
    runuser -u runner -- node - <<'NODE'
const { firefox } = require('playwright');
(async () => {
  if (process.getuid() === 0) throw new Error('nonroot runner required');
  const browser = await firefox.launch({headless: true});
  const page = await browser.newPage();
  await page.setContent('<title>nonroot direct-runner</title>');
  if (await page.title() !== 'nonroot direct-runner') throw new Error('browser assertion failed');
  await browser.close();
  console.log('INDEPENDENT_NONROOT_FIREFOX_EXECUTED');
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
    ;;
  nonroot-playwright-slow)
    bash /fixture/scripts/tests/fixtures/direct-runner-os/nonroot-playwright-slow.sh
    ;;
  success)
    bash /fixture/scripts/setup-direct-runner-os.sh
    # Independent producer/consumer evidence: dpkg state plus a real browser.
    for package in lsof libcairo2-dev; do
      test "$(dpkg-query -W -f='${Status}' "$package")" = 'install ok installed'
    done
    cd /fixture/client
    node - <<'NODE'
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage();
  await page.setContent('<title>direct-runner regression</title>');
  if (await page.title() !== 'direct-runner regression') throw new Error('browser assertion failed');
  await browser.close();
  console.log('INDEPENDENT_BROWSER_EXECUTED');
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
    ;;
  unavailable|slow)
    # Only the disposable container's source configuration changes. No host DNS,
    # network rules, security policy or package database is touched.
    rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
    if [ "$1" = slow ]; then
      python3 -u - <<'PY' &
import socket, threading, time
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(('127.0.0.1', 18080))
server.listen()
print('SLOW_SOURCE_LISTENING', flush=True)
while True:
    connection, _ = server.accept()
    def hang(c):
        if c.recv(1):
            print('SLOW_SOURCE_REQUEST', flush=True)
            time.sleep(300)
        c.close()
    threading.Thread(target=hang, args=(connection,), daemon=True).start()
PY
      # Wait for real socket availability, not a fixed scheduling assumption.
      python3 - <<'PY'
import socket, time
for _ in range(100):
    try:
        socket.create_connection(('127.0.0.1', 18080), timeout=.1).close()
        break
    except OSError:
        time.sleep(.05)
else:
    raise RuntimeError('slow source did not start')
PY
      source_url=http://127.0.0.1:18080
    else
      source_url=http://127.0.0.1:18081
    fi
    echo "Isolated package source=$source_url"
    echo "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $source_url resolute main" > /etc/apt/sources.list
    E2E_OS_BUDGET_SECONDS=15 bash /fixture/scripts/setup-direct-runner-os.sh
    ;;
  missing)
    # A real warm browser cache cannot make an absent package pass verification.
    bash /fixture/scripts/setup-direct-runner-os.sh
    dpkg --remove --force-depends lsof
    test -d /root/.cache/ms-playwright
    echo MISSING_DEPENDENCY_CONTROL
    # This genuine APT success only downloads; it cannot prove installation.
    apt-get -y --download-only install lsof
    echo REAL_DOWNLOAD_ONLY_COMPLETED
    source /fixture/scripts/common-functions.sh
    verify_required_os_packages lsof
    ;;
  *) exit 64 ;;
esac
