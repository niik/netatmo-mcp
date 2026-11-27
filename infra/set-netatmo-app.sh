#!/usr/bin/env bash
# Store the Netatmo app credentials: the client id as an app setting, the
# client secret in Key Vault (typed at a hidden prompt, never echoed or logged).
#
# First create an app at https://dev.netatmo.com/apps (see README.md) with
# this redirect URI:  https://<function app host>/callback   (printed below)
#
#   bash infra/set-netatmo-app.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/lib.sh
require_config SUBSCRIPTION RESOURCE_GROUP FUNCTION_APP KEY_VAULT
SUB=(--subscription "$SUBSCRIPTION")

host=$(site_host Standard)
echo "Redirect URI for the Netatmo app: https://$host/callback"
echo

read -r -p "Netatmo client ID: " client_id
read -r -s -p "Netatmo client secret (hidden): " client_secret; echo
[ -n "$client_id" ] && [ -n "$client_secret" ] || { echo "Both values are required."; exit 1; }

tmp=$(mktemp); chmod 600 "$tmp"; trap 'rm -f "$tmp"' EXIT
printf '%s' "$client_secret" >"$tmp"; unset client_secret
az keyvault secret set "${SUB[@]}" --vault-name "$KEY_VAULT" -n "$NETATMO_SECRET_SECRET" --file "$tmp" -o none
az functionapp config appsettings set "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" -o none \
  --settings "NETATMO_CLIENT_ID=$client_id"
# Restart so the Key Vault reference picks up the new secret now rather than within 24 h.
az functionapp restart "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" -o none
echo "Saved. Connector URL: https://$host/mcp"
