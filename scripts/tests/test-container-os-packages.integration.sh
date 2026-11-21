#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
cp "$repo_root/scripts/install-test-container-os-packages.sh" "$fixture/install.sh"
cp "$repo_root/scripts/verify-test-container-os-tools.sh" "$fixture/verify.sh"

readonly fixture_setup_timeout_seconds=180
readonly unavailable_fetch_timeout_seconds=30
readonly unavailable_shutdown_grace_seconds=5
# This watchdog is started inside the already-provisioned fixture, immediately
# before the case. It leaves ten seconds beyond the inner timeout and grace.
readonly unavailable_outer_watchdog_seconds=45
# Docker/BuildKit must reach the case RUN instruction inside this separately
# enforced preparation phase. The case watchdog starts only after that marker,
# composing a 75-second maximum for unavailable setup plus case execution.
readonly negative_case_setup_timeout_seconds=30

cat > "$fixture/Dockerfile.fixture" <<'EOF_DOCKER'
FROM mcr.microsoft.com/playwright:v1.64.1-jammy
COPY install.sh /usr/local/bin/install-test-container-os-packages
COPY verify.sh /usr/local/bin/verify-test-container-os-tools
EOF_DOCKER

cat > "$fixture/Dockerfile" <<'EOF_DOCKER'
FROM outliner-apt-regression:fixture
ARG CASE
RUN printf 'NEGATIVE_CASE_PHASE_%s\n' STARTED; \
    case "$CASE" in \
      unavailable) printf 'APT::Update::Error-Mode "any";\n' >/tmp/apt-fixture.conf; \
        find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) \
          -exec sed -Ei 's#https?://[^ /]+#http://127.0.0.1:18081#g' {} +; \
        set +e; \
        timeout --signal=TERM --kill-after=__OUTER_KILL_AFTER__ __OUTER_TIMEOUT__ \
          sh -c 'set +e; "$@"; status=$?; echo "INSTALLER_EXIT_STATUS=$status"; exit "$status"' sh \
            env APT_CONFIG=/tmp/apt-fixture.conf \
            APT_ACQUISITION_BUDGET_SECONDS=__UNAVAILABLE_FETCH_TIMEOUT__ \
            APT_ACQUISITION_SHUTDOWN_GRACE_SECONDS=__UNAVAILABLE_SHUTDOWN_GRACE__ \
            APT_PRIMARY_HOST=127.0.0.1:18081 APT_FALLBACK_HOST=127.0.0.1:18082 \
            /usr/local/bin/install-test-container-os-packages outliner-fixture-unavailable; \
        status=$?; echo "UNAVAILABLE_WATCHDOG_EXIT_STATUS=$status"; exit "$status" ;; \
      slow) python3 -c 'import socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(("127.0.0.1",18080)); s.listen(); c,_=s.accept(); time.sleep(300)' & \
        sleep 1; \
        find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) \
          -exec sed -i 's/azure.archive.ubuntu.com/127.0.0.1:18080/g' {} +; \
        set +e; APT_ACQUISITION_BUDGET_SECONDS=5 APT_PRIMARY_HOST=127.0.0.1:18080 \
          APT_FALLBACK_HOST=127.0.0.1:18081 \
          /usr/local/bin/install-test-container-os-packages lsof; \
        status=$?; echo "INSTALLER_EXIT_STATUS=$status"; exit "$status" ;; \
      missing) set +e; /usr/local/bin/install-test-container-os-packages outliner-package-that-does-not-exist; \
        status=$?; echo "INSTALLER_EXIT_STATUS=$status"; exit "$status" ;; \
      *) exit 64 ;; \
    esac
EOF_DOCKER
sed -i \
    -e "s/__UNAVAILABLE_FETCH_TIMEOUT__/${unavailable_fetch_timeout_seconds}/g" \
    -e "s/__UNAVAILABLE_SHUTDOWN_GRACE__/${unavailable_shutdown_grace_seconds}/g" \
    -e "s/__OUTER_TIMEOUT__/${unavailable_outer_watchdog_seconds}/g" \
    -e "s/__OUTER_KILL_AFTER__/${unavailable_shutdown_grace_seconds}/g" \
    "$fixture/Dockerfile"

cat > "$fixture/Dockerfile.success" <<'EOF_DOCKER'
FROM mcr.microsoft.com/playwright:v1.64.1-jammy
COPY install.sh /usr/local/bin/install-test-container-os-packages
COPY verify.sh /usr/local/bin/verify-test-container-os-tools
RUN /usr/local/bin/install-test-container-os-packages \
    openjdk-21-jre-headless xvfb lsof netcat-openbsd curl sudo \
    python3-venv python3-pip git-lfs
EOF_DOCKER

docker build --no-cache -f "$fixture/Dockerfile.success" \
    -t outliner-apt-regression:success "$fixture"
docker run --rm outliner-apt-regression:success /usr/local/bin/verify-test-container-os-tools

for missing_package in netcat-openbsd python3-pip; do
    set +e
    docker run --rm outliner-apt-regression:success bash -ceu \
        "dpkg --remove --force-depends '$missing_package' >/dev/null; /usr/local/bin/verify-test-container-os-tools" \
        >"$fixture/verify-missing-${missing_package}.log" 2>&1
    status=$?
    set -e
    if (( status == 0 )); then
        echo "OS-tool verification accepted an image without ${missing_package}." >&2
        exit 1
    fi
done

grep -q 'Required OS package is not installed: netcat-openbsd' "$fixture/verify-missing-netcat-openbsd.log"
grep -q 'Required OS package is not installed: python3-pip' "$fixture/verify-missing-python3-pip.log"

timeout "$fixture_setup_timeout_seconds" docker build --no-cache \
    -f "$fixture/Dockerfile.fixture" -t outliner-apt-regression:fixture "$fixture"

for negative_case in unavailable slow missing; do
    log="$fixture/${negative_case}.log"
    if [[ $negative_case != unavailable ]]; then
        set +e
        timeout 180 docker build --build-arg "CASE=${negative_case}" "$fixture" >"$log" 2>&1
        status=$?
        set -e
        if ! "$repo_root/scripts/tests/verify-container-negative-case.sh" "$negative_case" "$status" "$log"; then
            cat "$log" >&2
            exit 1
        fi
        continue
    fi

    set +e
    "$repo_root/scripts/tests/run-bounded-docker-build.sh" \
        "$negative_case_setup_timeout_seconds" "$unavailable_outer_watchdog_seconds" "$log" \
        docker build --progress=plain --build-arg "CASE=${negative_case}" "$fixture"
    status=$?
    set -e
    if ! "$repo_root/scripts/tests/verify-container-negative-case.sh" "$negative_case" "$status" "$log"; then
        cat "$log" >&2
        exit 1
    fi
done
