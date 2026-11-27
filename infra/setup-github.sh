#!/usr/bin/env bash
# One-time (idempotent) setup so GitHub Actions can deploy on push to main:
#   - a user-assigned managed identity, trusted via OIDC for pushes to main
#     in $GITHUB_REPO (no client secret anywhere; a managed identity rather
#     than an app registration since the account can't register apps)
#   - "Website Contributor" on the function app only (enough to deploy code;
#     no access to Key Vault)
#   - repo variables AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_SUBSCRIPTION_ID
#     (for azure/login) and AZURE_RESOURCE_GROUP / AZURE_FUNCTION_APP (what to
#     deploy to), so the workflow doesn't need infra/config.env
#
# Safe to re-run, e.g. to add variables introduced by a newer version.
#
#   bash infra/setup-github.sh                      # repo of the current checkout (gh repo view)
#   GITHUB_REPO=owner/name bash infra/setup-github.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/lib.sh
require_config SUBSCRIPTION LOCATION RESOURCE_GROUP FUNCTION_APP
GITHUB_REPO=${GITHUB_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
[ -n "$GITHUB_REPO" ] || { echo "Set GITHUB_REPO=owner/name"; exit 1; }
IDENTITY=id-netatmo-mcp-github
echo "GitHub repo: $GITHUB_REPO"

echo "==> Managed identity $IDENTITY"
az identity show --subscription "$SUBSCRIPTION" -g "$RESOURCE_GROUP" -n "$IDENTITY" -o none 2>/dev/null ||
  az identity create --subscription "$SUBSCRIPTION" -g "$RESOURCE_GROUP" -n "$IDENTITY" -l "$LOCATION" -o none
app_id=$(az identity show --subscription "$SUBSCRIPTION" -g "$RESOURCE_GROUP" -n "$IDENTITY" --query clientId -o tsv)
sp_id=$(az identity show --subscription "$SUBSCRIPTION" -g "$RESOURCE_GROUP" -n "$IDENTITY" --query principalId -o tsv)

echo "==> Federated credential for $GITHUB_REPO (main)"
# GitHub's OIDC subject includes the owner and repo ids: repo:owner@id/name@id:ref:...
subject=$(gh api "repos/$GITHUB_REPO" --jq '"repo:\(.owner.login)@\(.owner.id)/\(.name)@\(.id):ref:refs/heads/main"')
fic=(--subscription "$SUBSCRIPTION" -g "$RESOURCE_GROUP" --identity-name "$IDENTITY" -n github-main -o none
  --issuer https://token.actions.githubusercontent.com --subject "$subject" --audiences api://AzureADTokenExchange)
az identity federated-credential show --subscription "$SUBSCRIPTION" -g "$RESOURCE_GROUP" \
  --identity-name "$IDENTITY" -n github-main -o none 2>/dev/null &&
  az identity federated-credential update "${fic[@]}" ||
  az identity federated-credential create "${fic[@]}"
echo "  subject: $subject"

echo "==> Website Contributor on $FUNCTION_APP"
scope="/subscriptions/$SUBSCRIPTION/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Web/sites/$FUNCTION_APP"
for i in 1 2 3 4 5 6; do
  az role assignment create --subscription "$SUBSCRIPTION" --assignee-object-id "$sp_id" --assignee-principal-type ServicePrincipal \
    --role "Website Contributor" --scope "$scope" -o none 2>/dev/null && break
  echo "  waiting for the identity to propagate..."; sleep 10
done

echo "==> GitHub repo variables"
tenant=$(az account show --subscription "$SUBSCRIPTION" --query tenantId -o tsv)
gh variable set AZURE_CLIENT_ID --repo "$GITHUB_REPO" --body "$app_id"
gh variable set AZURE_TENANT_ID --repo "$GITHUB_REPO" --body "$tenant"
gh variable set AZURE_SUBSCRIPTION_ID --repo "$GITHUB_REPO" --body "$SUBSCRIPTION"
gh variable set AZURE_RESOURCE_GROUP --repo "$GITHUB_REPO" --body "$RESOURCE_GROUP"
gh variable set AZURE_FUNCTION_APP --repo "$GITHUB_REPO" --body "$FUNCTION_APP"
echo "Done."
