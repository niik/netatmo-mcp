#!/usr/bin/env bash
# One-time (idempotent) setup so GitHub Actions can deploy on push to main:
#   - a user-assigned managed identity, trusted via OIDC only for jobs in the
#     repo's "production" environment, which only main can deploy to (no
#     client secret anywhere; a managed identity rather than an app
#     registration since the account can't register apps)
#   - a custom role on the function app only that can read it and publish
#     code, nothing else (no app settings, scaling or Key Vault access)
#   - repo variables AZURE_CLIENT_ID / AZURE_TENANT_ID (for azure/login), and
#     repo SECRETS AZURE_SUBSCRIPTION_ID / AZURE_RESOURCE_GROUP /
#     AZURE_FUNCTION_APP (what to deploy to). Secrets, so GitHub masks them in
#     the (public) Actions logs and the server's address isn't published.
#   - repo hardening: main can't be force-pushed or deleted; only GitHub's own
#     actions and azure/login may run, pinned to commit SHAs; workflow runs
#     from outside contributors need approval.
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
ROLE="Netatmo MCP Code Deployer"
SUB=(--subscription "$SUBSCRIPTION")
echo "GitHub repo: $GITHUB_REPO"

echo "==> Environment 'production' (deployments from main only)"
gh api -X PUT "repos/$GITHUB_REPO/environments/production" --silent \
  --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
gh api "repos/$GITHUB_REPO/environments/production/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx main ||
  gh api -X POST "repos/$GITHUB_REPO/environments/production/deployment-branch-policies" -f name=main -f type=branch --silent

echo "==> Managed identity $IDENTITY"
az identity show "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$IDENTITY" -o none 2>/dev/null ||
  az identity create "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$IDENTITY" -l "$LOCATION" -o none
app_id=$(az identity show "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$IDENTITY" --query clientId -o tsv)
sp_id=$(az identity show "${SUB[@]}" -g "$RESOURCE_GROUP" -n "$IDENTITY" --query principalId -o tsv)

echo "==> Federated credential for $GITHUB_REPO (environment production)"
# GitHub's OIDC subject includes the owner and repo ids: repo:owner@id/name@id:environment:...
subject=$(gh api "repos/$GITHUB_REPO" --jq '"repo:\(.owner.login)@\(.owner.id)/\(.name)@\(.id):environment:production"')
fic=("${SUB[@]}" -g "$RESOURCE_GROUP" --identity-name "$IDENTITY" -n github-production -o none
  --issuer https://token.actions.githubusercontent.com --subject "$subject" --audiences api://AzureADTokenExchange)
az identity federated-credential show "${SUB[@]}" -g "$RESOURCE_GROUP" \
  --identity-name "$IDENTITY" -n github-production -o none 2>/dev/null &&
  az identity federated-credential update "${fic[@]}" ||
  az identity federated-credential create "${fic[@]}"
echo "  subject: $subject"
# Older versions trusted any job on main; remove that credential.
az identity federated-credential delete "${SUB[@]}" -g "$RESOURCE_GROUP" --identity-name "$IDENTITY" -n github-main --yes -o none 2>/dev/null || true

echo "==> Role '$ROLE' on $FUNCTION_APP"
rg_id=$(az group show "${SUB[@]}" -n "$RESOURCE_GROUP" --query id -o tsv)
scope="$rg_id/providers/Microsoft.Web/sites/$FUNCTION_APP"
if [ -z "$(az role definition list "${SUB[@]}" --custom-role-only true --name "$ROLE" --scope "$rg_id" --query '[0].name' -o tsv)" ]; then
  def=$(printf '{"Name":"%s","IsCustom":true,"Description":"Read the function app and publish code to it. Nothing else.","Actions":["Microsoft.Web/sites/read","Microsoft.Web/sites/publish/Action"],"NotActions":[],"DataActions":[],"NotDataActions":[],"AssignableScopes":["%s"]}' "$ROLE" "$rg_id")
  az role definition create "${SUB[@]}" --role-definition "$def" -o none
fi
for i in 1 2 3 4 5 6 7 8; do
  az role assignment create "${SUB[@]}" --assignee-object-id "$sp_id" --assignee-principal-type ServicePrincipal \
    --role "$ROLE" --scope "$scope" -o none 2>/dev/null && break
  [ "$i" = 8 ] && { echo "Could not assign '$ROLE'"; exit 1; }
  echo "  waiting for the identity/role to propagate..."; sleep 10
done
# Older versions granted Website Contributor; remove it.
az role assignment delete "${SUB[@]}" --assignee "$sp_id" --role "Website Contributor" --scope "$scope" -o none 2>/dev/null || true

echo "==> GitHub repo variables and secrets"
tenant=$(az account show "${SUB[@]}" --query tenantId -o tsv)
gh variable set AZURE_CLIENT_ID --repo "$GITHUB_REPO" --body "$app_id"
gh variable set AZURE_TENANT_ID --repo "$GITHUB_REPO" --body "$tenant"
gh secret set AZURE_SUBSCRIPTION_ID --repo "$GITHUB_REPO" --body "$SUBSCRIPTION"
gh secret set AZURE_RESOURCE_GROUP --repo "$GITHUB_REPO" --body "$RESOURCE_GROUP"
gh secret set AZURE_FUNCTION_APP --repo "$GITHUB_REPO" --body "$FUNCTION_APP"
# Older versions stored these as (unmasked) variables; remove them.
for v in AZURE_SUBSCRIPTION_ID AZURE_RESOURCE_GROUP AZURE_FUNCTION_APP; do
  gh variable delete "$v" --repo "$GITHUB_REPO" 2>/dev/null || true
done

echo "==> Repo hardening"
gh api "repos/$GITHUB_REPO/rulesets" --jq '.[].name' | grep -qx "Protect main" ||
  gh api -X POST "repos/$GITHUB_REPO/rulesets" --silent --input - <<'JSON'
{"name":"Protect main","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"}],"bypass_actors":[]}
JSON
gh api -X PUT "repos/$GITHUB_REPO/actions/permissions" --silent \
  --input - <<<'{"enabled":true,"allowed_actions":"selected","sha_pinning_required":true}'
gh api -X PUT "repos/$GITHUB_REPO/actions/permissions/selected-actions" --silent \
  --input - <<<'{"github_owned_allowed":true,"verified_allowed":false,"patterns_allowed":["azure/login@*"]}'
gh api -X PUT "repos/$GITHUB_REPO/actions/permissions/fork-pr-contributor-approval" --silent -f approval_policy=all_external_contributors
echo "Done."
