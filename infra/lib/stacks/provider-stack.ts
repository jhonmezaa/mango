import { Aws, CfnCondition, CfnOutput, CfnParameter, CfnResource, Duration, Fn, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { suppressCheckov, CHECKOV_EXCEPTIONS } from "../checkov.js";
import { GUARD_EXCEPTIONS, suppressGuard } from "../guard.js";
import { acknowledge } from "../nag.js";

/** Everything of the provider account is named with this prefix, so it can be told apart and removed whole. */
export const PROVIDER_PREFIX = "Mango-provider";
const LOWER_PREFIX = "mango-provider";
/** Key prefix of every published object: `mango/<version>/…` (D8, D58). */
export const RELEASE_KEY_PREFIX = "mango/";
/** GitHub environments the two roles trust; each job names its own. */
export const PACK_SIGNING_ENVIRONMENT = "pack-signing";
export const RELEASE_ENVIRONMENT = "release";
const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
/** The only signature the key makes: ECDSA over a SHA-256 digest (`mango_packs.signing`). */
const SIGNING_ALGORITHM = "ECDSA_SHA_256";

export interface ProviderStackProps extends StackProps {
  /**
   * Keep the key, the buckets and the image repository when the stack is deleted, and lock
   * published objects (Object Lock, GOVERNANCE). False only for a temporary provider account
   * that has to be removed whole.
   */
  readonly retain: boolean;
}

/**
 * `Mango-provider`: what the provider of Mango keeps in its **own** AWS account, outside every
 * customer organization (D58). Nothing here is installed in a customer account.
 *
 * - Release store: a global bucket for templates and a regional bucket for assets. Customers
 *   read by organization id; only the release publisher writes, and never over a published key.
 * - Image repository of mango-api, pulled by digest by the customer organizations.
 * - Signing key (KMS, ECC P-256): signs pack statements and release manifests (D36).
 * - GitHub OIDC provider and one role per job: pack signing and release publishing.
 * - Alerts on any use or change outside those two paths.
 *
 * No assets and no bootstrap: it is deployed with `aws cloudformation deploy`.
 * Threat model: `docs/security/threat-models/customer-distribution-threat-model.md`.
 */
export class ProviderStack extends Stack {
  constructor(scope: Construct, id: string, props: ProviderStackProps) {
    super(scope, id, props);
    const removal = props.retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const subjectPrefix = new CfnParameter(this, "GitHubSubjectPrefix", {
      type: "String",
      description:
        "Start of the OIDC subject of the repository, with immutable ids: repo:<owner>@<owner id>/<repo>@<repo id> " +
        "(gh api repos/<owner>/<repo>/actions/oidc/customization/sub).",
      allowedPattern: "^repo:[A-Za-z0-9_.-]+@[0-9]+/[A-Za-z0-9_.-]+@[0-9]+$",
    });
    const customers = new CfnParameter(this, "CustomerOrganizationIds", {
      type: "CommaDelimitedList",
      description: "AWS Organizations ids of the customers that may read releases and pull the image.",
      // CloudFormation checks the pattern against each element of the list.
      allowedPattern: "^o-[a-z0-9]{10,32}$",
    });
    const alertsEmail = new CfnParameter(this, "AlertsEmail", {
      type: "String",
      default: "",
      description: "Optional mailbox subscribed to the alerts topic (it must confirm).",
      allowedPattern: "^$|^[^@\\s,]+@[^@\\s,]+\\.[^@\\s,]+$",
    });
    const localPublisher = new CfnParameter(this, "LocalPublisherArn", {
      type: "String",
      default: "",
      description:
        "Optional IAM role of this account that may also assume the release publisher, to publish from a " +
        "workstation (lab releases). Leave empty where only the GitHub workflow publishes.",
      allowedPattern: "^$|^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$",
    });
    const fromCustomers = { StringEquals: { "aws:PrincipalOrgID": customers.valueAsList } };

    // --- GitHub OIDC: one role per job, each tied to its environment ------------------------
    // One provider per account and issuer: an account that already has it cannot create this
    // stack (documented in deployment/provider/README.md).
    const oidc = new iam.CfnOIDCProvider(this, "GitHubOidc", {
      url: `https://${GITHUB_OIDC_HOST}`,
      clientIdList: ["sts.amazonaws.com"],
    });
    const githubJob = (environment: string) =>
      new iam.FederatedPrincipal(
        oidc.attrArn,
        {
          StringEquals: {
            [`${GITHUB_OIDC_HOST}:aud`]: "sts.amazonaws.com",
            // Exact subject, never a pattern: this repository (by id) and this environment.
            [`${GITHUB_OIDC_HOST}:sub`]: Fn.join("", [subjectPrefix.valueAsString, `:environment:${environment}`]),
          },
        },
        "sts:AssumeRoleWithWebIdentity",
      );
    const packSigner = new iam.Role(this, "PackSigning", {
      roleName: `${PROVIDER_PREFIX}-pack-signing`,
      description: "GitHub Actions job that signs MCP pack statements; it can only sign",
      assumedBy: githubJob(PACK_SIGNING_ENVIRONMENT),
      maxSessionDuration: Duration.hours(1),
    });
    const publisher = new iam.Role(this, "ReleasePublisher", {
      roleName: `${PROVIDER_PREFIX}-release-publisher`,
      description: "GitHub Actions job that signs the release manifest and publishes the release",
      assumedBy: githubJob(RELEASE_ENVIRONMENT),
      maxSessionDuration: Duration.hours(1),
    });
    // A named role of this account, by condition (as every Mango trust): only where the
    // parameter is set. The pack signing role never gets a second way in.
    const hasLocalPublisher = new CfnCondition(this, "HasLocalPublisher", {
      expression: Fn.conditionNot(Fn.conditionEquals(localPublisher.valueAsString, "")),
    });
    (publisher.node.defaultChild as iam.CfnRole).addPropertyOverride(
      "AssumeRolePolicyDocument.Statement.1",
      Fn.conditionIf(
        hasLocalPublisher.logicalId,
        {
          Effect: "Allow",
          Action: "sts:AssumeRole",
          Principal: { AWS: Fn.join("", ["arn:", Aws.PARTITION, ":iam::", Aws.ACCOUNT_ID, ":root"]) },
          Condition: { ArnEquals: { "aws:PrincipalArn": localPublisher.valueAsString } },
        },
        Aws.NO_VALUE,
      ),
    );
    const signers = [packSigner.roleArn, publisher.roleArn];

    // --- Signing key -------------------------------------------------------------------------
    // The key policy is the whole authorization: the account administers the key but cannot
    // sign with it nor delegate it, and the two roles can do nothing but sign digests.
    const signingKey = new kms.Key(this, "SigningKey", {
      alias: `alias/${LOWER_PREFIX}-signing`,
      description: "Signs Mango MCP pack statements and release manifests",
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy: removal,
      pendingWindow: Duration.days(7),
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: "AccountAdministersTheKey",
            principals: [new iam.AccountRootPrincipal()],
            actions: [
              "kms:CancelKeyDeletion",
              "kms:CreateAlias",
              "kms:DeleteAlias",
              "kms:Describe*",
              "kms:DisableKey",
              "kms:EnableKey",
              "kms:Get*",
              "kms:List*",
              "kms:PutKeyPolicy",
              "kms:ScheduleKeyDeletion",
              "kms:TagResource",
              "kms:UntagResource",
              "kms:UpdateAlias",
              "kms:UpdateKeyDescription",
              "kms:Verify",
            ],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            sid: "SigningJobsSignDigests",
            principals: [new iam.ArnPrincipal(packSigner.roleArn), new iam.ArnPrincipal(publisher.roleArn)],
            actions: ["kms:Sign"],
            resources: ["*"],
            conditions: {
              StringEquals: { "kms:SigningAlgorithm": SIGNING_ALGORITHM, "kms:MessageType": "DIGEST" },
            },
          }),
          new iam.PolicyStatement({
            sid: "SigningJobsReadThePublicKey",
            principals: [new iam.ArnPrincipal(packSigner.roleArn), new iam.ArnPrincipal(publisher.roleArn)],
            actions: ["kms:GetPublicKey"],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            sid: "NobodyElseSignsOrDelegates",
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ["kms:Sign", "kms:CreateGrant"],
            resources: ["*"],
            conditions: { ArnNotEquals: { "aws:PrincipalArn": signers } },
          }),
        ],
      }),
    });

    // --- Release store -----------------------------------------------------------------------
    const accessLogs = new s3.Bucket(this, "AccessLogs", {
      bucketName: `${LOWER_PREFIX}-access-logs-${Aws.ACCOUNT_ID}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: Duration.days(90) }],
      removalPolicy: removal,
    });
    const logsResource = accessLogs.node.defaultChild as CfnResource;
    suppressGuard(logsResource, GUARD_EXCEPTIONS.logBucketLogging, GUARD_EXCEPTIONS.logBucketVersioning);
    suppressCheckov(logsResource, CHECKOV_EXCEPTIONS.logBucketLogging, CHECKOV_EXCEPTIONS.logBucketVersioning);

    const releaseBucket = (id: string, bucketName: string, logPrefix: string) => {
      const bucket = new s3.Bucket(this, id, {
        bucketName,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        encryption: s3.BucketEncryption.S3_MANAGED,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        versioned: true,
        // A published version cannot be removed while it is locked. Object Lock cannot be
        // turned off later, so a temporary account goes without it.
        ...(props.retain
          ? { objectLockEnabled: true, objectLockDefaultRetention: s3.ObjectLockRetention.governance(Duration.days(365)) }
          : {}),
        serverAccessLogsBucket: accessLogs,
        serverAccessLogsPrefix: logPrefix,
        removalPolicy: removal,
      });
      const objects = bucket.arnForObjects(`${RELEASE_KEY_PREFIX}*`);
      // Customers read by organization: every reader of a release (who calls CreateStack, the
      // role Lambda copies code with, the BucketDeployment handler) is a principal of the
      // customer's organization. No listing.
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "CustomerOrganizationsReadReleases",
          principals: [new iam.AnyPrincipal()],
          actions: ["s3:GetObject"],
          resources: [objects],
          conditions: fromCustomers,
        }),
      );
      // Published keys are immutable (TM-D3): only the publisher writes, and only a key that
      // does not exist yet. Parts of a multipart upload carry no precondition; the request
      // that creates the object does.
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "OnlyThePublisherWrites",
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ["s3:PutObject"],
          resources: [bucket.arnForObjects("*")],
          conditions: { ArnNotEquals: { "aws:PrincipalArn": publisher.roleArn } },
        }),
      );
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "NeverOverwriteAPublishedKey",
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ["s3:PutObject"],
          resources: [bucket.arnForObjects("*")],
          conditions: {
            Null: { "s3:if-none-match": "true" },
            Bool: { "s3:ObjectCreationOperation": "true" },
          },
        }),
      );
      if (props.retain) {
        // Nobody removes or hides a published object. Taking this statement out is a bucket
        // policy change, which raises an alert.
        bucket.addToResourcePolicy(
          new iam.PolicyStatement({
            sid: "NeverDeleteAPublishedObject",
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
            resources: [objects],
          }),
        );
      }
      publisher.addToPolicy(
        new iam.PolicyStatement({ sid: `Publish${id}`, actions: ["s3:PutObject"], resources: [objects] }),
      );
      acknowledge(publisher, {
        id: `AwsSolutions-IAM5[Resource::<${this.getLogicalId(bucket.node.defaultChild as CfnResource)}.Arn>/${RELEASE_KEY_PREFIX}*]`,
        reason: "Release keys are named by version and content hash: the mango/ prefix of the release bucket is the scope.",
      });
      return bucket;
    };
    const base = `${LOWER_PREFIX}-releases-${Aws.ACCOUNT_ID}`;
    const templates = releaseBucket("Templates", base, "templates/");
    // Lambda only loads code from a bucket of its own Region: assets are regional (ISB pattern).
    const assets = releaseBucket("Assets", `${base}-${Aws.REGION}`, "assets/");

    // --- Image of mango-api ------------------------------------------------------------------
    const repository = new ecr.Repository(this, "ApiImage", {
      repositoryName: `${LOWER_PREFIX}/api`,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.KMS,
      removalPolicy: removal,
      emptyOnDelete: !props.retain,
    });
    repository.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "CustomerOrganizationsPull",
        principals: [new iam.AnyPrincipal()],
        actions: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        conditions: fromCustomers,
      }),
    );
    acknowledge(repository, {
      id: "AwsSolutions-ECR1",
      reason:
        "Customers pull by organization (D58): IAM has no organization principal, so the statement names every " +
        "principal and the aws:PrincipalOrgID condition restricts it to the customer organizations. Pull only.",
    });
    publisher.addToPolicy(
      new iam.PolicyStatement({
        sid: "PushTheImage",
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ],
        resources: [repository.repositoryArn],
      }),
    );
    publisher.addToPolicy(
      new iam.PolicyStatement({ sid: "RegistryLogin", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }),
    );
    acknowledge(publisher, {
      id: "AwsSolutions-IAM5[Resource::*]",
      reason: "ecr:GetAuthorizationToken has no resource scope.",
    });

    // --- Alerts ------------------------------------------------------------------------------
    const eventBridge = new iam.ServicePrincipal("events.amazonaws.com");
    const alertsKey = new kms.Key(this, "AlertsKey", {
      alias: `alias/${LOWER_PREFIX}-alerts`,
      description: "Encrypts the Mango provider alerts topic",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
    });
    alertsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "EventBridgeToAlertsTopic",
        principals: [eventBridge],
        actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    );
    const topic = new sns.Topic(this, "Alerts", {
      topicName: `${PROVIDER_PREFIX}-alerts`,
      displayName: "Mango provider alerts",
      masterKey: alertsKey,
      enforceSSL: true,
    });
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "RulesOfThisAccount",
        principals: [eventBridge],
        actions: ["sns:Publish"],
        resources: [topic.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:${Aws.PARTITION}:events:${this.region}:${this.account}:rule/${PROVIDER_PREFIX}-*` },
        },
      }),
    );
    const hasEmail = new CfnCondition(this, "HasAlertsEmail", {
      expression: Fn.conditionNot(Fn.conditionEquals(alertsEmail.valueAsString, "")),
    });
    const subscription = new sns.CfnSubscription(this, "AlertsEmailSubscription", {
      topicArn: topic.topicArn,
      protocol: "email",
      endpoint: alertsEmail.valueAsString,
    });
    subscription.cfnOptions.condition = hasEmail;

    // Rules read management events from CloudTrail: the account needs a trail that records them.
    const alert = (id: string, description: string, eventPattern: events.EventPattern) =>
      new events.Rule(this, id, {
        ruleName: `${PROVIDER_PREFIX}-${id.replace(/[A-Z]/g, (c, i: number) => (i ? "-" : "") + c.toLowerCase())}`,
        description,
        eventPattern,
        targets: [new targets.SnsTopic(topic)],
      });
    const viaCloudTrail = ["AWS API Call via CloudTrail"];
    alert("SigningMisuse", "A principal other than the two signing jobs asked the signing key for a signature (denied ones included)", {
      source: ["aws.kms"],
      detailType: viaCloudTrail,
      detail: {
        eventName: ["Sign"],
        resources: { ARN: [signingKey.keyArn] },
        // Another role, or a principal that is not a role session at all (user, root).
        $or: [
          { userIdentity: { sessionContext: { sessionIssuer: { arn: [{ "anything-but": signers }] } } } },
          { userIdentity: { type: [{ "anything-but": ["AssumedRole"] }] } },
        ],
      },
    });
    alert("SigningKeyChange", "The policy, the grants or the state of the signing key changed", {
      source: ["aws.kms"],
      detailType: viaCloudTrail,
      detail: {
        eventName: ["PutKeyPolicy", "CreateGrant", "DisableKey", "ScheduleKeyDeletion"],
        resources: { ARN: [signingKey.keyArn] },
      },
    });
    alert("RoleChange", "The trust or the permissions of a GitHub job role changed", {
      source: ["aws.iam"],
      detailType: viaCloudTrail,
      detail: {
        eventName: [
          "AttachRolePolicy",
          "DeleteRole",
          "DeleteRolePolicy",
          "DetachRolePolicy",
          "PutRolePermissionsBoundary",
          "PutRolePolicy",
          "UpdateAssumeRolePolicy",
        ],
        requestParameters: { roleName: [packSigner.roleName, publisher.roleName] },
      },
    });
    alert("ReleaseStoreChange", "Who can read or write the release buckets changed, or a published version was removed", {
      source: ["aws.s3"],
      detailType: viaCloudTrail,
      detail: {
        eventName: [
          "DeleteBucket",
          "DeleteBucketPolicy",
          "PutBucketObjectLockConfiguration",
          "PutBucketPolicy",
          "PutBucketPublicAccessBlock",
          "PutBucketVersioning",
        ],
        requestParameters: { bucketName: [templates.bucketName, assets.bucketName] },
      },
    });
    alert("ImageRepositoryChange", "Who can pull the mango-api image changed, or an image was removed", {
      source: ["aws.ecr"],
      detailType: viaCloudTrail,
      detail: {
        eventName: ["BatchDeleteImage", "DeleteRepository", "DeleteRepositoryPolicy", "PutImageTagMutability", "SetRepositoryPolicy"],
        requestParameters: { repositoryName: [repository.repositoryName] },
      },
    });

    new CfnOutput(this, "SigningKeyArn", { value: signingKey.keyArn });
    new CfnOutput(this, "PackSigningRoleArn", { value: packSigner.roleArn });
    new CfnOutput(this, "ReleasePublisherRoleArn", { value: publisher.roleArn });
    new CfnOutput(this, "TemplatesBucket", { value: templates.bucketName });
    new CfnOutput(this, "AssetsBucket", { value: assets.bucketName });
    new CfnOutput(this, "ApiImageRepositoryUri", { value: repository.repositoryUri });
    new CfnOutput(this, "AlertsTopicArn", { value: topic.topicArn });
  }
}
