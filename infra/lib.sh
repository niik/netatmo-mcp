# Shared by the scripts in infra/ (sourced, not run). Loads the deployment
# settings: infra/config.env if it exists, with environment variables taking
# precedence. The AZURE_* names are accepted as aliases so GitHub Actions can
# pass its repo variables straight through.
#
#   source infra/lib.sh
#   require_config SUBSCRIPTION RESOURCE_GROUP FUNCTION_APP

CONFIG_VARS="SUBSCRIPTION LOCATION RESOURCE_GROUP STORAGE_ACCOUNT FUNCTION_APP KEY_VAULT TOKEN_KEY_SECRET NETATMO_SECRET_SECRET"

SUBSCRIPTION=${SUBSCRIPTION:-${AZURE_SUBSCRIPTION_ID:-}}
RESOURCE_GROUP=${RESOURCE_GROUP:-${AZURE_RESOURCE_GROUP:-}}
FUNCTION_APP=${FUNCTION_APP:-${AZURE_FUNCTION_APP:-}}

# Remember what the environment set, read the file, then re-apply the environment.
for _v in $CONFIG_VARS; do printf -v "_env_$_v" '%s' "${!_v:-}"; done
if [ -f infra/config.env ]; then
  # shellcheck source=/dev/null
  source infra/config.env
fi
for _v in $CONFIG_VARS; do
  _e="_env_$_v"
  if [ -n "${!_e}" ]; then printf -v "$_v" '%s' "${!_e}"; else printf -v "$_v" '%s' "${!_v:-}"; fi
done
unset _v _e

TOKEN_KEY_SECRET=${TOKEN_KEY_SECRET:-token-key}
NETATMO_SECRET_SECRET=${NETATMO_SECRET_SECRET:-netatmo-client-secret}

# Fail early, with a hint, if a setting is missing or still a placeholder.
require_config() {
  local v missing=()
  for v in "$@"; do
    case "${!v:-}" in
      "" | *changeme* | 00000000-0000-0000-0000-000000000000) missing+=("$v") ;;
    esac
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "Missing or placeholder setting(s): ${missing[*]}" >&2
    echo "Copy infra/config.env.example to infra/config.env and fill it in, or set them in the environment." >&2
    exit 1
  fi
}

# Default hostname of the function app (az functionapp show returns empty
# fields for Flex apps with some CLI versions, so use REST).
SITE_URL="https://management.azure.com/subscriptions/${SUBSCRIPTION}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Web/sites/${FUNCTION_APP}?api-version=2024-04-01"
site_host() { az rest --method get --url "$SITE_URL" --query "properties.hostNameSslStates[?hostType=='$1'].name | [0]" -o tsv; }
