#!/usr/bin/env bash
# Delete what an uninstalled Mango installation retains on purpose (D58): its data.
#
# Deleting the stacks keeps the DynamoDB tables, the user directory, the audit trail and the
# other buckets, the log groups and the KMS keys. This script removes them, so that the
# account is clean or the same namespace can be installed again. It is a separate and
# deliberate act: nothing here can be undone.
#
# Without --confirm it only lists what it would delete. It refuses to run while the Core
# stack of the namespace exists. Requires credentials for the Mango account.
#
# Usage: deployment/purge-retained.sh <namespace> [--confirm]
set -euo pipefail

ns="${1:?usage: purge-retained.sh <namespace> [--confirm]}"
confirm="${2:-}"
[[ "$ns" =~ ^[a-z0-9]{3,8}$ ]] || { echo "namespace must be 3 to 8 lowercase letters or digits" >&2; exit 2; }
[[ -z "$confirm" || "$confirm" == "--confirm" ]] || { echo "unknown option: $confirm" >&2; exit 2; }
export AWS_PAGER=""

if aws cloudformation describe-stacks --stack-name "Mango-$ns-Core" >/dev/null 2>&1; then
  echo "Mango-$ns-Core still exists: delete the stacks first (docs/runbooks/install.md)." >&2
  exit 1
fi

act() { # act <description> <command...>: print, and run only with --confirm
  echo "  $1"
  shift
  if [[ "$confirm" == "--confirm" ]]; then "$@"; fi
}

account="$(aws sts get-caller-identity --query Account --output text)"
echo "Retained resources of namespace '$ns' in account $account${confirm:+ — DELETING}"

echo "DynamoDB tables"
for table in $(aws dynamodb list-tables --query "TableNames[?starts_with(@, 'Mango-$ns-')]" --output text); do
  if [[ "$confirm" == "--confirm" ]]; then
    aws dynamodb update-table --table-name "$table" --no-deletion-protection-enabled >/dev/null
  fi
  act "$table" aws dynamodb delete-table --table-name "$table" --query TableDescription.TableStatus --output text
done

echo "Cognito user pool"
for pool in $(aws cognito-idp list-user-pools --max-results 60 \
  --query "UserPools[?Name=='Mango-$ns-Users'].Id" --output text); do
  if [[ "$confirm" == "--confirm" ]]; then
    domain="$(aws cognito-idp describe-user-pool --user-pool-id "$pool" --query UserPool.Domain --output text)"
    if [[ -n "$domain" && "$domain" != "None" ]]; then
      aws cognito-idp delete-user-pool-domain --user-pool-id "$pool" --domain "$domain"
    fi
    aws cognito-idp update-user-pool --user-pool-id "$pool" --deletion-protection INACTIVE \
      --auto-verified-attributes email
  fi
  act "$pool" aws cognito-idp delete-user-pool --user-pool-id "$pool"
done

echo "S3 buckets (every version; the audit bucket is under Object Lock)"
empty_bucket() {
  local bucket="$1" batch
  while :; do
    batch="$(aws s3api list-object-versions --bucket "$bucket" --max-items 500 \
      --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}' --output json)"
    [[ "$(jq '.Objects | length' <<<"$batch")" -gt 0 ]] || break
    # GOVERNANCE retention can be bypassed by an administrator; COMPLIANCE cannot, by anyone.
    if ! aws s3api delete-objects --bucket "$bucket" --bypass-governance-retention \
      --delete "$batch" --query 'Errors[0].Code' --output text | grep -q None; then
      echo "    $bucket: objects still locked (COMPLIANCE retention); it stays until they expire" >&2
      return 1
    fi
  done
}
for bucket in $(aws s3api list-buckets --query "Buckets[?starts_with(Name, 'mango-$ns-core-') || starts_with(Name, 'mango-$ns-packnetwork-')].Name" --output text); do
  echo "  $bucket"
  if [[ "$confirm" == "--confirm" ]]; then
    if empty_bucket "$bucket"; then aws s3api delete-bucket --bucket "$bucket"; fi
  fi
done

echo "CloudWatch log groups"
for prefix in "/aws/lambda/Mango-$ns-" "/mango/$ns/" "/aws/vendedlogs/Mango-$ns-" "Mango-$ns-Core-" \
  "Mango-$ns-PackNetwork-" "/aws/ecs/containerinsights/Mango-$ns-api/" "/aws/vendedlogs/states/Mango-$ns-"; do
  for group in $(aws logs describe-log-groups --log-group-name-prefix "$prefix" \
    --query 'logGroups[].logGroupName' --output text); do
    act "$group" aws logs delete-log-group --log-group-name "$group"
  done
done

echo "KMS keys (scheduled for deletion in 7 days, the minimum)"
for alias in $(aws kms list-aliases --query "Aliases[?starts_with(AliasName, 'alias/Mango-$ns-')].AliasName" --output text); do
  key="$(aws kms describe-key --key-id "$alias" --query KeyMetadata.KeyId --output text)"
  if [[ "$confirm" == "--confirm" ]]; then aws kms delete-alias --alias-name "$alias"; fi
  act "$alias ($key)" aws kms schedule-key-deletion --key-id "$key" --pending-window-in-days 7 \
    --query DeletionDate --output text
done

echo "ECS task definitions"
for definition in $(aws ecs list-task-definitions --family-prefix "Mango-$ns-api" --status ACTIVE \
  --query taskDefinitionArns --output text); do
  act "${definition##*/}" aws ecs deregister-task-definition --task-definition "$definition" \
    --query taskDefinition.status --output text
done

if [[ "$confirm" != "--confirm" ]]; then
  echo "Nothing was deleted. Run again with --confirm to delete everything listed above."
fi
