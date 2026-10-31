#!/usr/bin/env bash
# =============================================================================
# VigaBSS — schedule the host nginx reload that picks up renewed TLS certs
# =============================================================================
# Called by install.sh in host-nginx mode. Older installers edited root's
# crontab with `( crontab -l | grep -v … ; echo … ) | crontab -` under
# `set -euo pipefail`: with no crontab, an empty one, or only the VigaBSS
# line, `grep -v` selected nothing and exited 1, and the installer stopped
# right there with no message (SUP-01). The job now lives in its own
# /etc/cron.d file, and old root-crontab entries are removed only when
# present.
#
# VIGABSS_CRON_DIR overrides /etc/cron.d (tests).
# =============================================================================

set -euo pipefail

CRON_DIR="${VIGABSS_CRON_DIR:-/etc/cron.d}"
CRON_FILE="$CRON_DIR/vigabss-nginx-reload"
CRON_MARKER="# vigabss-nginx-reload"
LEGACY_CRON_MARKER="# fireisp-nginx-reload"

umask 022
tmp="$(mktemp "$CRON_DIR/.vigabss-nginx-reload.XXXXXX")"
printf '%s\n' \
  "# Managed by VigaBSS install.sh: reload nginx so it serves renewed TLS certificates." \
  "0 */6 * * * root /usr/sbin/nginx -s reload >/dev/null 2>&1 || true" > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$CRON_FILE"

if command -v crontab >/dev/null 2>&1; then
  existing="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "$existing" | grep -q -e "$CRON_MARKER" -e "$LEGACY_CRON_MARKER"; then
    printf '%s\n' "$existing" \
      | { grep -v -e "$CRON_MARKER" -e "$LEGACY_CRON_MARKER" || true; } \
      | crontab -
  fi
fi
