FROM ubuntu:26.04
# Provision only the independent harness prerequisites. Required application
# libraries are acquired by the real setup implementation in each fresh run.
RUN --mount=type=secret,id=environment-ca \
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates nodejs npm openjdk-21-jre-headless sudo python3 curl \
    && if [ -f /run/secrets/environment-ca ]; then \
      cp /run/secrets/environment-ca /usr/local/share/ca-certificates/environment-proxy-ca.crt; \
      update-ca-certificates; fi \
    && rm -rf /var/lib/apt/lists/*
# Node downloads use the same verified system trust store as APT/curl.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
# Match the hosted runner's nonroot -> passwordless sudo acquisition boundary.
# This account exists only inside the disposable regression container.
RUN useradd --create-home --shell /bin/bash runner \
    && printf 'runner ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/fixture-runner \
    && chmod 440 /etc/sudoers.d/fixture-runner
COPY client/package-lock.json /fixture/client/package-lock.json
RUN version=$(node -p "require('/fixture/client/package-lock.json').packages['node_modules/@playwright/test'].version") \
    && typescript_version=$(node -p "require('/fixture/client/package-lock.json').packages['node_modules/typescript'].version") \
    && npm install --prefix /runtime --no-save "@playwright/test@$version" "typescript@$typescript_version" \
    && ln -s /runtime/node_modules /fixture/client/node_modules
