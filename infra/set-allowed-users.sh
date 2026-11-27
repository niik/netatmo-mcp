#!/usr/bin/env bash
# Restrict which Netatmo accounts may use this deployment (app setting
# ALLOWED_NETATMO_USERS). Enter the email addresses of the Netatmo accounts,
# comma-separated; leave empty to allow any Netatmo account.
#
#   bash infra/set-allowed-users.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/lib.sh
require_config SUBSCRIPTION RESOURCE_GROUP FUNCTION_APP
SUB=(--subscription "$SUBSCRIPTION")

read -r -p "Allowed Netatmo account emails (comma-separated, empty = anyone): " users
if [ -n "$users" ]; then
  az functionapp config appsettings set "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" -o none \
    --settings "ALLOWED_NETATMO_USERS=$users"
  echo "Only these Netatmo accounts can sign in now. Existing sign-ins of other accounts stop at their next token refresh (within ~3 hours)."
else
  az functionapp config appsettings delete "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" -o none \
    --setting-names ALLOWED_NETATMO_USERS
  echo "Any Netatmo account can sign in now."
fi
