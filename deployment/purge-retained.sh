#!/usr/bin/env bash
# Delete what an uninstalled Mango installation retains on purpose (D58): its data.
#
# Deleting the stacks keeps the DynamoDB tables, the user directory, the audit trail and the
# other buckets, the log groups and the KMS keys. This script removes them, so that the
# account is clean or the same namespace can be installed again. It is a separate and
# deliberate act: nothing here can be undone.
#
# Without --confirm it only lists what it would delete, and what it leaves alone. It refuses
# to run, with or without --confirm, while the Core or the PackNetwork stack of the namespace
# exists, and when it cannot tell. With --confirm it ends with an error, naming what is left,
# when something it listed could not be deleted. Requires credentials for the Mango account.
#
# Usage: deployment/purge-retained.sh <namespace> [--confirm]
set -euo pipefail

ns="${1:?usage: purge-retained.sh <namespace> [--confirm]}"
confirm="${2:-}"
[[ "$ns" =~ ^[a-z0-9]{3,8}$ ]] || { echo "namespace must be 3 to 8 lowercase letters or digits" >&2; exit 2; }
[[ -z "$confirm" || "$confirm" == "--confirm" ]] || { echo "unknown option: $confirm" >&2; exit 2; }
export AWS_PAGER=""

# Nothing is listed or deleted until CloudFormation says, in so many words, that both stacks of
# this account are gone. A query that fails for any other reason (permissions, throttling,
# expired credentials, network) proves nothing: taking it for "gone" would purge the data, and
# schedule the keys, of an installation that is still running.
for stack in "Mango-$ns-Core" "Mango-$ns-PackNetwork"; do
  if answer="$(aws cloudformation describe-stacks --stack-name "$stack" \
    --query 'Stacks[0].StackStatus' --output text 2>&1)"; then
    echo "$stack still exists ($answer): delete the stacks first (docs/runbooks/install.md)." >&2
    exit 1
  fi
  if ! grep -q "Stack with id $stack does not exist" <<<"$answer"; then
    echo "Could not check that $stack is gone, so nothing was listed or deleted:" >&2
    echo "$answer" >&2
    exit 1
  fi
done

# Everything else is looked up in the region of that check, but S3 lists the buckets of every
# region: one that lives in another region may belong to stacks nobody looked for.
region="$(aws configure list | awk '$1 == "region" { gsub(":", ""); print $2 }')"
if ! [[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]]; then
  echo "No region is configured, so the region the stacks were looked up in is unknown." >&2
  exit 1
fi

act() { # act <description> <command...>: print, and run only with --confirm
  echo "  $1"
  shift
  if [[ "$confirm" == "--confirm" ]]; then "$@"; fi
}

account="$(aws sts get-caller-identity --query Account --output text)"
echo "Retained resources of namespace '$ns' in account $account, region $region${confirm:+ — DELETING}"
left=()      # listed, and still in the account after trying to delete it
untouched=() # found, and not this script's to delete

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

echo "S3 buckets (every version)"
object_lock() { # prints yes or no; fails, with the error of S3, when it cannot tell
  local out
  if out="$(aws s3api get-object-lock-configuration --bucket "$1" \
    --query ObjectLockConfiguration.ObjectLockEnabled --output text 2>&1)"; then
    if [[ "$out" == "Enabled" ]]; then echo yes; else echo no; fi
  elif grep -q ObjectLockConfigurationNotFoundError <<<"$out"; then
    echo no
  else
    echo "    $1: its Object Lock configuration could not be read" >&2
    echo "$out" >&2
    return 1
  fi
}
bucket_region() { # prints the region of the bucket; fails, with the error of S3, when it cannot tell
  local location
  location="$(aws s3api get-bucket-location --bucket "$1" --query LocationConstraint --output text)" || return 1
  case "$location" in
    None) echo us-east-1 ;; # how S3 names its first region, and Ireland in old buckets
    EU) echo eu-west-1 ;;
    *) echo "$location" ;;
  esac
}
empty_bucket() { # empty_bucket <bucket> <yes|no: it has Object Lock>
  local bucket="$1" lock="$2" batch errors
  while :; do
    batch="$(aws s3api list-object-versions --bucket "$bucket" --max-items 500 \
      --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}' --output json)" || return 1
    [[ "$(jq '.Objects | length' <<<"$batch")" -gt 0 ]] || break
    # S3 rejects the bypass on a bucket without Object Lock, so only a locked one gets it.
    # GOVERNANCE retention can be bypassed by an administrator; COMPLIANCE cannot, by anyone.
    if [[ "$lock" == "yes" ]]; then
      errors="$(aws s3api delete-objects --bucket "$bucket" --bypass-governance-retention --delete "$batch" \
        --query 'Errors[].{Key: Key, Code: Code, Message: Message}' --output json)" || return 1
    else
      errors="$(aws s3api delete-objects --bucket "$bucket" --delete "$batch" \
        --query 'Errors[].{Key: Key, Code: Code, Message: Message}' --output json)" || return 1
    fi
    if [[ "$(jq 'length' <<<"$errors")" -gt 0 ]]; then
      echo "    $bucket: $(jq 'length' <<<"$errors") objects could not be deleted; the first ones:" >&2
      jq -r '.[:3][] | "      \(.Key): \(.Code): \(.Message)"' <<<"$errors" >&2
      if [[ "$lock" == "yes" ]]; then
        echo "    If this is their retention: under COMPLIANCE they stay until it ends." >&2
      fi
      return 1
    fi
  done
}
for bucket in $(aws s3api list-buckets --query "Buckets[?starts_with(Name, 'mango-$ns-core-') || starts_with(Name, 'mango-$ns-packnetwork-')].Name" --output text); do
  if ! location="$(bucket_region "$bucket")"; then
    echo "  $bucket (region: could not be read)"
    if [[ "$confirm" == "--confirm" ]]; then left+=("bucket $bucket"); fi
    continue
  fi
  if [[ "$location" != "$region" ]]; then
    untouched+=("bucket $bucket: in $location, and the stacks were only looked up in $region")
    continue
  fi
  if ! lock="$(object_lock "$bucket")"; then
    echo "  $bucket (Object Lock: could not be read)"
    if [[ "$confirm" == "--confirm" ]]; then left+=("bucket $bucket"); fi
    continue
  fi
  if [[ "$lock" == "yes" ]]; then echo "  $bucket (Object Lock)"; else echo "  $bucket"; fi
  if [[ "$confirm" == "--confirm" ]]; then
    if ! empty_bucket "$bucket" "$lock" || ! aws s3api delete-bucket --bucket "$bucket"; then
      left+=("bucket $bucket")
    fi
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

# The stacks delete their aliases, so a retained key is found by the tag every resource of an
# installation carries. A key of another namespace, or without the tag, is never touched.
echo "KMS aliases"
for alias in $(aws kms list-aliases --query "Aliases[?starts_with(AliasName, 'alias/Mango-$ns-')].AliasName" --output text); do
  act "$alias" aws kms delete-alias --alias-name "$alias"
done

echo "KMS keys (tagged mango:namespace=$ns; scheduled for deletion in 7 days, the minimum)"
unreadable=0
tag() { jq -r --arg key "$1" '[(. // [])[] | select(.TagKey == $key) | .TagValue][0] // ""' <<<"$tags"; }
kms_read() { # kms_read <command...>: 1 when these credentials may not read the key; any other error, 2
  local error
  "$@" 2>/dev/null && return 0
  error="$("$@" 2>&1 >/dev/null)" || true
  if grep -q AccessDenied <<<"$error"; then return 1; fi
  echo "$error" >&2
  return 2
}
for key in $(aws kms list-keys --query 'Keys[].KeyId' --output text); do
  # A key that may not be read is not ours to judge. Any other error stops the purge: skipping
  # the key would leave it in the account without a word.
  meta="$(kms_read aws kms describe-key --key-id "$key" --output json \
    --query 'KeyMetadata.{manager: KeyManager, state: KeyState, description: Description, deletion: DeletionDate}')" || {
    [[ $? -eq 1 ]] || exit 1
    unreadable=$((unreadable + 1))
    continue
  }
  [[ "$(jq -r .manager <<<"$meta")" == "CUSTOMER" ]] || continue
  tags="$(kms_read aws kms list-resource-tags --key-id "$key" --query Tags --output json)" || {
    [[ $? -eq 1 ]] || exit 1
    unreadable=$((unreadable + 1))
    continue
  }
  [[ "$(tag mango:namespace)" == "$ns" ]] || continue
  component="$(tag mango:component)"
  description="$(jq -r '.description // ""' <<<"$meta")"
  label="$key (${component:-no mango:component tag}${description:+; $description})"
  case "$(jq -r .state <<<"$meta")" in
    Enabled | Disabled)
      echo "  $label"
      if [[ "$confirm" == "--confirm" ]]; then
        aws kms schedule-key-deletion --key-id "$key" --pending-window-in-days 7 \
          --query DeletionDate --output text || left+=("KMS key $label")
      fi
      ;;
    PendingDeletion)
      untouched+=("KMS key $label: already pending deletion, on $(jq -r .deletion <<<"$meta")")
      ;;
    *)
      untouched+=("KMS key $label: in state $(jq -r .state <<<"$meta")")
      ;;
  esac
done
if [[ "$unreadable" -gt 0 ]]; then
  echo "  $unreadable keys of the account could not be read with these credentials: not considered" >&2
fi

echo "ECS task definitions"
for definition in $(aws ecs list-task-definitions --family-prefix "Mango-$ns-api" --status ACTIVE \
  --query taskDefinitionArns --output text); do
  act "${definition##*/}" aws ecs deregister-task-definition --task-definition "$definition" \
    --query taskDefinition.status --output text
done

# Shared with the rest of the account, or already on its way out: said, and left alone.
for group in $(aws logs describe-log-groups --log-group-name-prefix aws/spans \
  --query "logGroups[?logGroupName=='aws/spans'].logGroupName" --output text); do
  untouched+=("log group $group: created by CloudWatch Transaction Search for the whole account, not by Mango")
done
inactive="$(aws ecs list-task-definitions --family-prefix "Mango-$ns-api" --status INACTIVE \
  --query taskDefinitionArns --output json |
  jq --arg family ":task-definition/Mango-$ns-api:" '[(. // [])[] | select(contains($family))] | length')"
if [[ "$inactive" -gt 0 ]]; then
  untouched+=("$inactive inactive revisions of task definition Mango-$ns-api: no cost")
fi
if [[ "${#untouched[@]}" -gt 0 ]]; then
  echo "Not touched by this script"
  printf '  %s\n' "${untouched[@]}"
fi

if [[ "$confirm" != "--confirm" ]]; then
  echo "Nothing was deleted. Run again with --confirm to delete everything listed above."
elif [[ "${#left[@]}" -gt 0 ]]; then
  echo "Could not be deleted, and still in the account:" >&2
  printf '  %s\n' "${left[@]}" >&2
  exit 1
fi
