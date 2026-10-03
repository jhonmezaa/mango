#!/usr/bin/env bash
# Install or update Mango-<ns>-Payer in the organization management account without CDK
# bootstrap: synthesize the template and deploy it with CloudFormation (D8 install model).
# Requires credentials for the management account in the environment.
#
# Until `mise run dist` publishes the release templates (D58), the template is synthesized here.
#
# Usage: deployment/deploy-payer.sh <namespace> <mango account id> <organization id>
set -euo pipefail

usage="usage: deploy-payer.sh <namespace> <mango account id> <organization id>"
namespace="${1:?$usage}"
mango_account="${2:?$usage}"
organization="${3:?$usage}"
root="$(cd "$(dirname "$0")/.." && pwd)"
stack="Mango-$namespace-Payer"

(cd "$root/infra" && npx cdk synth Payer -c env=example -c skipSpa=true --quiet >/dev/null)

aws cloudformation deploy \
  --stack-name "$stack" \
  --template-file "$root/infra/cdk.out/Payer.template.json" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "Namespace=$namespace" "MangoAccountId=$mango_account" "OrganizationId=$organization" \
  --tags "mango:namespace=$namespace" "mango:component=payer" \
  --no-fail-on-empty-changeset

aws cloudformation describe-stacks --stack-name "$stack" \
  --query 'Stacks[0].StackStatus' --output text
