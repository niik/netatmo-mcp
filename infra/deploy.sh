#!/usr/bin/env bash
# Provision (idempotently) and deploy the Netatmo MCP server to Azure Functions
# (Flex Consumption, Node 26). Secrets live in Key Vault; the app reads them
# through Key Vault references with its managed identity.
#
#   npm run deploy            # provision if needed, then deploy code
#   npm run deploy -- --code  # deploy code only (what GitHub Actions runs)
#
# Settings come from infra/config.env (copy infra/config.env.example) and/or
# environment variables; see infra/lib.sh. --code only needs SUBSCRIPTION,
# RESOURCE_GROUP and FUNCTION_APP (or AZURE_SUBSCRIPTION_ID,
# AZURE_RESOURCE_GROUP, AZURE_FUNCTION_APP).
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/lib.sh
if [ "${1:-}" = "--code" ]; then
  require_config SUBSCRIPTION RESOURCE_GROUP FUNCTION_APP
else
  require_config SUBSCRIPTION LOCATION RESOURCE_GROUP STORAGE_ACCOUNT FUNCTION_APP KEY_VAULT
fi
SUB=(--subscription "$SUBSCRIPTION")

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

provision() {
  log "Resource group $RESOURCE_GROUP ($LOCATION)"
  az group create "${SUB[@]}" -n "$RESOURCE_GROUP" -l "$LOCATION" -o none

  log "Storage account $STORAGE_ACCOUNT"
  az storage account show "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$STORAGE_ACCOUNT" -o none 2>/dev/null ||
    az storage account create "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$STORAGE_ACCOUNT" -l "$LOCATION" \
      --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false -o none

  log "Key Vault $KEY_VAULT (RBAC)"
  az keyvault show "${SUB[@]}" -n "$KEY_VAULT" -o none 2>/dev/null ||
    az keyvault create "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$KEY_VAULT" -l "$LOCATION" \
      --enable-rbac-authorization true --retention-days 7 --enable-purge-protection true -o none

  log "Function app $FUNCTION_APP (Flex Consumption, Node 26)"
  az functionapp show "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" -o none 2>/dev/null ||
    az functionapp create "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" \
      --storage-account "$STORAGE_ACCOUNT" --flexconsumption-location "$LOCATION" \
      --runtime node --runtime-version 26 --instance-memory 512 -o none
  # A low instance cap bounds the cost of a traffic spike (Flex Consumption bills per execution).
  az functionapp scale config set "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" \
    --maximum-instance-count "$MAX_INSTANCES" -o none || true

  log "Managed identity + Key Vault access"
  local app_principal me vault_id
  app_principal=$(az functionapp identity assign "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" --query principalId -o tsv)
  vault_id=$(az keyvault show "${SUB[@]}" -n "$KEY_VAULT" --query id -o tsv)
  # Your object id in the subscription's tenant, taken from an ARM token (works for guest/MSA accounts).
  me=$(az account get-access-token "${SUB[@]}" --query accessToken -o tsv | cut -d. -f2 |
    python3 -c 'import base64,json,sys; s=sys.stdin.read().strip(); s+="="*(-len(s)%4); print(json.loads(base64.urlsafe_b64decode(s))["oid"])')
  # The app only reads secrets; you can manage them.
  az role assignment create "${SUB[@]}" --assignee-object-id "$app_principal" --assignee-principal-type ServicePrincipal \
    --role "Key Vault Secrets User" --scope "$vault_id" -o none 2>/dev/null || true
  az role assignment create "${SUB[@]}" --assignee-object-id "$me" --assignee-principal-type User \
    --role "Key Vault Secrets Officer" --scope "$vault_id" -o none 2>/dev/null || true

  log "Token encryption key (created once, never printed)"
  local tries=0
  until az keyvault secret show "${SUB[@]}" --vault-name "$KEY_VAULT" -n "$TOKEN_KEY_SECRET" -o none 2>/dev/null; do
    tmp=$(mktemp); chmod 600 "$tmp"
    openssl rand -base64 32 | tr -d '\n' >"$tmp"
    if az keyvault secret set "${SUB[@]}" --vault-name "$KEY_VAULT" -n "$TOKEN_KEY_SECRET" --file "$tmp" -o none 2>/dev/null; then
      rm -f "$tmp"; break
    fi
    rm -f "$tmp"
    tries=$((tries + 1)); [ $tries -ge 12 ] && { echo "Could not write to Key Vault (RBAC not propagated?)"; exit 1; }
    echo "  waiting for Key Vault role assignment to propagate..."; sleep 15
  done

  log "HTTPS only, TLS 1.2+, no FTP or basic-auth publishing"
  az functionapp update "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" --set httpsOnly=true -o none
  az functionapp config set "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" \
    --min-tls-version 1.2 --ftps-state Disabled -o none
  for policy in ftp scm; do
    az resource update "${SUB[@]}" -g "$RESOURCE_GROUP" --namespace Microsoft.Web --resource-type basicPublishingCredentialsPolicies \
      --parent "sites/$FUNCTION_APP" -n "$policy" --set properties.allow=false -o none
  done

  log "Monthly budget alert: $BUDGET_AMOUNT (billing currency) on $RESOURCE_GROUP"
  # Emails the subscription's Owners at 80% actual and 100% forecast spend. It alerts only; nothing is stopped.
  local start body
  start=$(date -u +%Y-%m-01)
  body=$(printf '{"properties":{"category":"Cost","amount":%s,"timeGrain":"Monthly","timePeriod":{"startDate":"%sT00:00:00Z"},"notifications":{"actual80":{"enabled":true,"operator":"GreaterThan","threshold":80,"thresholdType":"Actual","contactEmails":[],"contactRoles":["Owner"]},"forecast100":{"enabled":true,"operator":"GreaterThan","threshold":100,"thresholdType":"Forecasted","contactEmails":[],"contactRoles":["Owner"]}}}}' "$BUDGET_AMOUNT" "$start")
  az rest "${SUB[@]}" --method put -o none --body "$body" \
    --url "https://management.azure.com/subscriptions/$SUBSCRIPTION/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Consumption/budgets/netatmo-mcp-monthly?api-version=2023-05-01" ||
    echo "  (couldn't create the budget; some subscription types don't support budgets)"

  log "App settings"
  az functionapp config appsettings set "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" -o none --settings \
    "PUBLIC_BASE_URL=https://$(site_host Standard)" \
    "TOKEN_KEY=@Microsoft.KeyVault(VaultName=$KEY_VAULT;SecretName=$TOKEN_KEY_SECRET)" \
    "NETATMO_CLIENT_SECRET=@Microsoft.KeyVault(VaultName=$KEY_VAULT;SecretName=$NETATMO_SECRET_SECRET)"

  if ! az keyvault secret show "${SUB[@]}" --vault-name "$KEY_VAULT" -n "$NETATMO_SECRET_SECRET" -o none 2>/dev/null; then
    echo
    echo "Next: create a Netatmo app and store its credentials with:  bash infra/set-netatmo-app.sh"
  fi
}

deploy_code() {
  log "Building deployment package"
  local build; build=$(mktemp -d)
  mkdir -p "$build/src/functions"
  cp package.json package-lock.json host.json "$build/"
  cp src/*.js "$build/src/"
  cp src/functions/*.js "$build/src/functions/"
  (cd "$build" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent && zip -qr ../netatmo-mcp.zip .)
  log "Deploying to $FUNCTION_APP"
  # Flex Consumption "one deploy" with an Entra token (basic-auth publishing stays disabled).
  local host token status
  host=$(site_host Repository)
  token=$(az account get-access-token "${SUB[@]}" --query accessToken -o tsv)
  status=$(curl -sS -o /dev/stderr -w '%{http_code}' -X POST \
    -H @<(printf 'Authorization: Bearer %s\n' "$token") -H "Content-Type: application/zip" \
    --data-binary @"$build/../netatmo-mcp.zip" "https://$host/api/publish?RemoteBuild=false")
  echo; [ "$status" -lt 300 ] || { echo "Deploy failed: HTTP $status"; exit 1; }
  rm -rf "$build" "$build/../netatmo-mcp.zip"
  log "Done: https://$(site_host Standard)/mcp"
}

[ "${1:-}" = "--code" ] || provision
deploy_code
