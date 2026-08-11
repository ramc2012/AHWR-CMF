#!/bin/sh
# Audit #2 — tamper-evident audit trail (compose path).
#
# init.sql creates the least-privilege role crmf_app and grants it DML on the operational
# tables + INSERT-only on audit_log, but leaves it WITHOUT a login password. This script
# gives crmf_app a password so the backend can connect AS crmf_app instead of the schema
# owner. Because crmf_app is NOT the owner, it cannot DROP/ALTER the append-only audit_log
# trigger or TRUNCATE the table — so the audit trail is genuinely non-rewritable.
#
# It reuses the superuser password (POSTGRES_PASSWORD): the security benefit here is the
# PRIVILEGE separation, not a distinct secret. (The production Kubernetes path uses a
# separate Vault-sourced secret via CNPG managed.roles instead — see
# deploy/k8s/platform/timescaledb/00-cluster.yaml.)
#
# Mounted into /docker-entrypoint-initdb.d as "zz-app-role-password.sh" so it runs AFTER
# init.sql (lexical order). Like all initdb scripts it runs ONCE, on a FRESH data volume.
set -e
# Inline the password with single-quotes doubled (injection-safe; the value comes from the
# trusted POSTGRES_PASSWORD env). NOTE: psql does NOT interpolate :'var' in -c mode, so we
# escape and inline rather than use a psql variable.
esc=$(printf '%s' "$POSTGRES_PASSWORD" | sed "s/'/''/g")
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -c "ALTER ROLE crmf_app LOGIN PASSWORD '$esc';"
echo "[init] crmf_app login password set; backend connects as the least-privilege app role (audit #2)."
