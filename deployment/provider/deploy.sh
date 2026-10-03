#!/usr/bin/env bash
# Install or update the Mango provider account (stack `Mango-provider`, D58): release buckets,
# image repository, signing key and the GitHub roles. It has no assets and needs no CDK
# bootstrap: the template is synthesized here and deployed with CloudFormation.
# Requires credentials for the provider account in the environment. Never run it against a
# customer account.
#
# Usage: deployment/provider/deploy.sh <github subject prefix> <customer org ids, comma separated> [alerts email]
#   MANGO_PROVIDER_LOCAL_PUBLISHER=<role arn>  a role of the account that may publish from a workstation
#   MANGO_PROVIDER_TEMPORARY=1  for a temporary account: nothing is retained when the stack is deleted
set -euo pipefail

subject="${1:?usage: deploy.sh <github subject prefix> <customer org ids> [alerts email]}"
customers="${2:?usage: deploy.sh <github subject prefix> <customer org ids> [alerts email]}"
email="${3:-}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$root/infra/cdk.out.provider"
retain=true
[[ "${MANGO_PROVIDER_TEMPORARY:-}" == "1" ]] && retain=false

(cd "$root/infra" && npx cdk synth --app "npx tsx bin/provider.ts" -o "$out" -c retain="$retain" --quiet >/dev/null)

aws cloudformation deploy \
  --stack-name Mango-provider \
  --template-file "$out/Provider.template.json" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "GitHubSubjectPrefix=$subject" \
    "CustomerOrganizationIds=$customers" \
    "AlertsEmail=$email" \
    "LocalPublisherArn=${MANGO_PROVIDER_LOCAL_PUBLISHER:-}" \
  --tags "mango:component=provider" \
  --no-fail-on-empty-changeset

aws cloudformation describe-stacks --stack-name Mango-provider \
  --query 'Stacks[0].{status:StackStatus,outputs:Outputs}' --output json
