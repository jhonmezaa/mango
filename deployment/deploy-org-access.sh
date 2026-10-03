#!/usr/bin/env bash
# Install or update Mango-<ns>-OrgAccess (the StackSet of the member account roles, §4.10)
# without CDK bootstrap: synthesize the template and deploy it with CloudFormation (D8 install
# model). Requires credentials for the account that owns the StackSet in the environment: the
# organization management account, or the delegated administrator named in `orgAccess`.
#
# It changes nothing in Organizations: trusted access for StackSets must already be active.
#
# Until `mise run dist` publishes the release templates (D58), the template is synthesized here.
#
# Usage: deployment/deploy-org-access.sh <namespace> <mango account id> <organization id> <targets> <excluded account ids> [SELF|DELEGATED_ADMIN]
#   targets: the root id alone, or OU ids separated by commas
#   excluded account ids: separated by commas; it must include the Mango account
set -euo pipefail

usage="usage: deploy-org-access.sh <namespace> <mango account id> <organization id> <targets> <excluded account ids> [SELF|DELEGATED_ADMIN]"
namespace="${1:?$usage}"
mango_account="${2:?$usage}"
organization="${3:?$usage}"
targets="${4:?$usage}"
excluded="${5:?$usage}"
call_as="${6:-SELF}"
root="$(cd "$(dirname "$0")/.." && pwd)"
stack="Mango-$namespace-OrgAccess"

if [[ "$(aws cloudformation describe-organizations-access --call-as "$call_as" \
  --query Status --output text)" != "ENABLED" ]]; then
  echo "Trusted access for CloudFormation StackSets is not active in this organization." >&2
  echo "Activate it from the management account and retry." >&2
  exit 1
fi

(cd "$root/infra" && npx cdk synth OrgAccess -c env=example -c skipSpa=true --quiet >/dev/null)

aws cloudformation deploy \
  --stack-name "$stack" \
  --template-file "$root/infra/cdk.out/OrgAccess.template.json" \
  --parameter-overrides "Namespace=$namespace" "MangoAccountId=$mango_account" "OrganizationId=$organization" \
    "Targets=$targets" "ExcludedAccountIds=$excluded" "CallAs=$call_as" \
  --tags "mango:namespace=$namespace" "mango:component=org-access" \
  --no-fail-on-empty-changeset

aws cloudformation describe-stacks --stack-name "$stack" \
  --query 'Stacks[0].{status:StackStatus,outputs:Outputs}' --output json
aws cloudformation list-stack-instances --stack-set-name "Mango-$namespace-Member" \
  --call-as "$call_as" \
  --query 'Summaries[].[Account,Region,Status,StackInstanceStatus.DetailedStatus]' --output text
