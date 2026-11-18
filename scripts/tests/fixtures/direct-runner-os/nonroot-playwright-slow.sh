#!/usr/bin/env bash
set -euo pipefail
# Warm real required-package and Firefox state before the timed negative case.
# The production script must still perform install-deps on a warm installation.
E2E_BROWSER=firefox bash /fixture/scripts/setup-direct-runner-os.sh
# This locked Firefox-only dependency is outside the initial required arrays.
# Force a genuine .deb acquisition inside install-deps after its signed update.
test "$(dpkg-query -W -f='${Status}' libavcodec62)" = 'install ok installed'
dpkg --remove --force-depends libavcodec62
rm -f /var/cache/apt/archives/libavcodec62*.deb
python3 -u /fixture/scripts/tests/fixtures/direct-runner-os/phase-source-proxy.py > /tmp/phase-source-events.log 2>&1 &
proxy_pid=$!
trap 'kill "$proxy_pid" 2>/dev/null || true' EXIT
python3 - <<'PY'
import socket, time
for _ in range(100):
    try:
        socket.create_connection(('127.0.0.1', 18082), timeout=.1).close()
        break
    except OSError:
        time.sleep(.05)
else:
    raise RuntimeError('signed source proxy did not start')
PY
# Only the disposable container changes sources. The proxy forwards the real
# Ubuntu InRelease/indices unchanged; apt retains its normal signature checks.
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
echo 'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://127.0.0.1:18082/ubuntu resolute main universe' > /etc/apt/sources.list
timeout --kill-after=2 120 apt-get -o APT::Update::Error-Mode=any update
python3 - <<'PY'
import json, os, pathlib, subprocess, time
log = pathlib.Path('/tmp/nonroot-setup.log')
events = pathlib.Path('/tmp/phase-source-events.log')
log.write_text('')
started = time.monotonic()
command = "set -o pipefail; runuser -u runner -- env E2E_BROWSER=firefox E2E_OS_BUDGET_SECONDS=30 bash -c 'test \"$(id -u)\" -ne 0; exec bash /fixture/scripts/setup-direct-runner-os.sh' 2>&1 | tee /tmp/nonroot-setup.log"
# If an external watchdog has to stop this pipeline, it is a failed oracle.
result = subprocess.run(['bash', '-c', command], timeout=45)
elapsed = (time.monotonic() - started) * 1000
assert result.returncode in (124, 137), result.returncode
assert elapsed < 33000, elapsed
assert 'stage=playwright-install-deps (firefox, ' in log.read_text()
assert 'stage=ready' not in log.read_text()
assert 'PLAYWRIGHT_SOURCE_REQUEST' in events.read_text()
time.sleep(3)
active = []
for process in pathlib.Path('/proc').iterdir():
    if process.name.isdigit():
        try:
            name = (process / 'comm').read_text().strip()
            state = (process / 'stat').read_text().split(') ', 1)[1].split()[0]
            if state != 'Z' and name in {'apt-get', 'dpkg', 'http', 'https'}:
                active.append((process.name, name, state))
        except FileNotFoundError:
            pass
assert not active, active
records = [json.loads(line) for line in events.read_text().splitlines() if line.startswith('{')]
assert any(row['event'] == 'PLAYWRIGHT_SOURCE_CLIENT_CLOSED' for row in records), records
assert all(row['event'] != 'PLAYWRIGHT_SOURCE_STILL_CONNECTED' for row in records)
print('NONROOT_PIPELINE_OUTCOME ' + json.dumps({'elapsedMs': elapsed, 'exit': result.returncode, 'activeAcquisition': active}))
PY
