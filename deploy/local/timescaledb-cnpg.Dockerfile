# CNPG-compatible TimescaleDB operand image for LOCAL arm64 (Apple Silicon).
#
# WHY: the production CR uses ghcr.io/imusmanmalik/timescaledb-postgis:16, which ships
# amd64 ONLY — it cannot pull on an arm64 kind node ("no match for platform in manifest").
# This rebuilds the same capability (PostgreSQL 16 + the timescaledb extension) on top of
# CloudNativePG's OFFICIAL multi-arch operand base, so it runs natively on arm64 while
# staying fully CNPG-managed. PostGIS is omitted — the CRMF schema doesn't use it.
#
# Build + load (done by up.sh):
#   docker build --platform linux/arm64 -f timescaledb-cnpg.Dockerfile -t crmf/timescaledb-cnpg:16 .
#   kind load docker-image --name crmf-local crmf/timescaledb-cnpg:16
FROM ghcr.io/cloudnative-pg/postgresql:16
USER root
# The CNPG operand base ships postgresql-16 but strips the Debian main repo, so
# timescaledb's libssl3 dependency is "not installable" without it — add main back,
# then the Timescale apt repo, then the extension.
RUN set -eux; \
    echo "deb http://deb.debian.org/debian bookworm main" \
        > /etc/apt/sources.list.d/debian-main.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gnupg ca-certificates wget; \
    echo "deb https://packagecloud.io/timescale/timescaledb/debian/ bookworm main" \
        > /etc/apt/sources.list.d/timescaledb.list; \
    wget -qO- https://packagecloud.io/timescale/timescaledb/gpgkey \
        | gpg --dearmor -o /etc/apt/trusted.gpg.d/timescaledb.gpg; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        timescaledb-2-postgresql-16 timescaledb-2-loader-postgresql-16; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*
# Back to the unprivileged postgres user the operator runs as.
USER 26
