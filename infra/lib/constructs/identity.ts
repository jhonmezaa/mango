import { CfnCondition, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import { cognitoGroupNames } from "../config/groups.js";
import { Installation } from "../config/schema.js";
import { logsKeyOf } from "../logs.js";
import { acknowledge } from "../nag.js";
import { mangoName } from "../names.js";
import { PythonFunction } from "./python-function.js";

export interface IdentityProps {
  readonly installation: Installation;
  /** SPA origin, e.g. `https://d123.cloudfront.net` (callback and logout URL). */
  readonly appOrigin: string;
  /** Optional second administrator of a release installation (D58). */
  readonly secondAdmin?: { readonly email: string; readonly when: CfnCondition };
}

/** Cognito public API operations, as sent in `X-Amz-Target` by the SPA (TM-L3, TM-L11). */
const TARGET_PREFIX = "AWSCognitoIdentityProviderService.";

/** Web session length (refresh token validity); also shown in Ajustes › Autenticación. */
export const SESSION_HOURS = 12;
/** Operations that send an email: tight limit against bombing and quota exhaustion. */
export const EMAIL_OPERATIONS = ["SignUp", "ResendConfirmationCode", "ForgotPassword"];
/** Operations that check a secret (password, code or TOTP): limit against brute force. */
export const SECRET_OPERATIONS = [
  "InitiateAuth",
  "RespondToAuthChallenge",
  "ConfirmSignUp",
  "ConfirmForgotPassword",
  "AssociateSoftwareToken",
  "VerifySoftwareToken",
];
/** Requests per IP per 5 minutes. Generous for offices behind one NAT address. */
const EMAIL_RATE_LIMIT = 50;
const SECRET_RATE_LIMIT = 300;
const IP_RATE_LIMIT = 1000;

/**
 * Cognito user pool for the own login (D20): SRP sign-in from the SPA, self sign-up restricted
 * to company domains by a pre sign-up trigger, email verification by code, TOTP MFA required
 * in customer installations, roles derived only from groups by the pre token generation V2
 * trigger (TM-I4). A user may belong to Mango groups without a FinOps role. Threat model: `docs/security/threat-models/login-threat-model.md`.
 *
 * Deploying over the pool created for D14 is an in-place update: the username attributes and
 * the attribute schema are unchanged, so the pool and its users are kept.
 */
export class Identity extends Construct {
  readonly userPool: cognito.UserPool;
  readonly webClient: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;
  readonly issuer: string;
  /** Regional WAF web ACL associated with the user pool (when enabled). */
  /**
   * Regional WAF on the user pool, always on (D28, TM-L3): the public Cognito APIs do not go
   * through CloudFront, so this is their only rate limit. About USD 8/month plus requests.
   */
  readonly webAcl: wafv2.CfnWebACL;
  private readonly preToken: lambda.Function;

  constructor(scope: Construct, id: string, props: IdentityProps) {
    super(scope, id);
    const cfg = props.installation;
    const removal = cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const plus = cfg.auth.cognitoPlan === "plus";

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: mangoName(cfg.namespace, "Users"),
      featurePlan: plus ? cognito.FeaturePlan.PLUS : cognito.FeaturePlan.ESSENTIALS,
      // Plus: compromised passwords are blocked at sign-up and password reset; every auth event
      // gets a risk score in the user's activity history (D29, TM-L3).
      standardThreatProtectionMode: plus
        ? cognito.StandardThreatProtectionMode.FULL_FUNCTION
        : undefined,
      // Self sign-up is limited to company domains by the pre sign-up trigger (TM-L4).
      selfSignUpEnabled: true,
      userVerification: { emailStyle: cognito.VerificationEmailStyle.CODE },
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      mfa: cfg.mfa === "required" ? cognito.Mfa.REQUIRED : cognito.Mfa.OFF,
      mfaSecondFactor: cfg.mfa === "required" ? { otp: true, sms: false } : undefined,
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: cfg.retainData,
      removalPolicy: removal,
    });

    if (plus) {
      // Only what applies with SRP sign-in and MFA required (D29). Compromised credentials cannot
      // see the password in USER_SRP_AUTH, so SIGN_IN would be a no-op: the check runs on the
      // plaintext passwords of SignUp and ConfirmForgotPassword/NEW_PASSWORD_REQUIRED. Adaptive
      // authentication cannot add MFA when MFA is already required on every sign-in, and a
      // BLOCK would lock users out without notice (notifications need SES, not configured), so
      // risky sign-ins are scored and logged, not acted on. An installation that meets the exit
      // criteria of D31 may block high-risk sign-ins (`auth.highRiskAction`).
      const riskConfiguration = new cognito.CfnUserPoolRiskConfigurationAttachment(
        this,
        "RiskConfiguration",
        {
          userPoolId: this.userPool.userPoolId,
          clientId: "ALL",
          compromisedCredentialsRiskConfiguration: {
            actions: { eventAction: "BLOCK" },
            eventFilter: ["SIGN_UP", "PASSWORD_CHANGE"],
          },
          accountTakeoverRiskConfiguration: {
            actions: {
              lowAction: { eventAction: "NO_ACTION", notify: false },
              mediumAction: { eventAction: "NO_ACTION", notify: false },
              highAction: { eventAction: cfg.auth.highRiskAction, notify: false },
            },
          },
        },
      );
      this.exportAuthEvents(cfg, removal).addResourceDependency(riskConfiguration);
    } else {
      acknowledge(this.userPool, {
        id: "AwsSolutions-COG8",
        reason:
          "Lab-only: Cognito Essentials (decisions D20, D29). Customer installations use Plus " +
          "with threat protection enforced (enforced by the installation schema).",
      });
    }

    if (cfg.mfa === "off") {
      acknowledge(this.userPool, {
        id: "AwsSolutions-COG2",
        reason:
          "Lab-only: MFA disabled at the user's request (decision log, 2026-09-29). " +
          "Installations for customers use mfa=required.",
      });
    }

    // Customer-managed key for the trigger configuration (the domain allowlist).
    const configKey = new kms.Key(this, "ConfigKey", {
      alias: `alias/${mangoName(cfg.namespace, "identity-config")}`,
      description: "Encrypts Mango identity trigger environment variables",
      enableKeyRotation: true,
      removalPolicy: removal,
    });
    const preSignUp = new PythonFunction(this, "PreSignUp", {
      packageName: "mango-pre-sign-up",
      packagePath: "functions/pre-sign-up",
      retainLogs: cfg.retainData,
      handler: "mango_pre_sign_up.handler.lambda_handler",
      functionName: mangoName(cfg.namespace, "PreSignUp"),
      description: "Allows self sign-up only for company email domains",
      environment: { SIGN_UP_DOMAINS: cfg.auth.signUpDomains.join(",") },
      environmentEncryption: configKey,
      timeout: Duration.seconds(5),
      memorySize: 256,
    });
    this.userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, preSignUp.function);

    const preToken = new PythonFunction(this, "PreToken", {
      packageName: "mango-pre-token",
      packagePath: "functions/pre-token",
      retainLogs: cfg.retainData,
      handler: "mango_pre_token.handler.lambda_handler",
      functionName: mangoName(cfg.namespace, "PreTokenGeneration"),
      description: "Maps Cognito groups to Mango access-token claims",
      // The table of the group registry is set by `readGroupRegistry`.
      environmentEncryption: configKey,
      timeout: Duration.seconds(5),
      memorySize: 256,
    });
    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
      preToken.function,
      cognito.LambdaVersion.V2_0,
    );
    this.preToken = preToken.function;

    // System groups (roles, admins, agent creators), one per business unit and the access
    // groups of the installation. Membership reaches mango-api in `cognito:groups`.
    for (const name of cognitoGroupNames(cfg)) {
      new cognito.CfnUserPoolGroup(this, `Group-${name}`, {
        userPoolId: this.userPool.userPoolId,
        groupName: name,
      });
    }

    cfg.users.forEach((user, index) => this.addUser(`User${index}`, user));
    if (props.secondAdmin) {
      // Same groups as the first administrator; it exists only when one was named.
      const first = cfg.users[0];
      if (!first) throw new Error("a second administrator needs a first one");
      this.addUser("SecondAdmin", { email: props.secondAdmin.email, groups: first.groups }, props.secondAdmin.when);
    }

    this.webClient = this.userPool.addClient("WebClient", {
      userPoolClientName: mangoName(cfg.namespace, "Web"),
      generateSecret: false,
      // SRP plus refresh only: never USER_PASSWORD_AUTH or USER_AUTH (D20, TM-L9).
      authFlows: { userSrp: true },
      // Code + PKCE stays for the SSO redirect to the customer's IdP (D20).
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${props.appOrigin}/`],
        logoutUrls: [`${props.appOrigin}/`],
      },
      // Federated identities are separate users, never linked by email (TM-L7).
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.hours(SESSION_HOURS),
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      // Sign-up may set the email and a display name only; roles come only from groups
      // (TM-I4). Without the self-service scope (pre-token) nothing can be changed later.
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({
        email: true,
        fullname: true,
      }),
    });

    this.domain = this.userPool.addDomain("Domain", {
      cognitoDomain: {
        domainPrefix: `mango-${cfg.namespace}-${Stack.of(this).account}`,
      },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    new cognito.CfnManagedLoginBranding(this, "Branding", {
      userPoolId: this.userPool.userPoolId,
      clientId: this.webClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    this.webAcl = this.protectUserPool(cfg.namespace);

    this.issuer = `https://cognito-idp.${Stack.of(this).region}.amazonaws.com/${this.userPool.userPoolId}`;
  }

  /** A user created by the stack, in its groups. Cognito emails the temporary password. */
  private addUser(id: string, user: Installation["users"][number], when?: CfnCondition): void {
    const created = new cognito.CfnUserPoolUser(this, id, {
      userPoolId: this.userPool.userPoolId,
      username: user.email,
      desiredDeliveryMediums: user.e2e ? undefined : ["EMAIL"],
      messageAction: user.e2e ? "SUPPRESS" : undefined,
      userAttributes: [
        { name: "email", value: user.email },
        { name: "email_verified", value: "true" },
      ],
    });
    if (when) created.cfnOptions.condition = when;
    for (const group of user.groups) {
      const attach = new cognito.CfnUserPoolUserToGroupAttachment(this, `${id}-${group}`, {
        userPoolId: this.userPool.userPoolId,
        username: user.email,
        groupName: group,
      });
      if (when) attach.cfnOptions.condition = when;
      attach.addResourceDependency(created);
      const groupResource = this.node.findChild(`Group-${group}`) as cognito.CfnUserPoolGroup;
      attach.addResourceDependency(groupResource);
    }
  }

  get discoveryUrl(): string {
    return `${this.issuer}/.well-known/openid-configuration`;
  }

  /**
   * Lets the pre-token trigger compute `mango_central` (D35, TM-M13): it reads the registry of
   * access groups, and only that partition of the Settings table (`partition`). Without this
   * call the trigger issues no `mango_central` claim (fail closed).
   */
  readGroupRegistry(settings: dynamodb.ITableV2, dataKey: kms.IKey, partition: string): void {
    this.preToken.addEnvironment("SETTINGS_TABLE", settings.tableName);
    this.preToken.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadGroupRegistry",
        actions: ["dynamodb:Query"],
        resources: [settings.tableArn],
        conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [partition] } },
      }),
    );
    this.preToken.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "DecryptSettingsViaDynamoDB",
        actions: ["kms:Decrypt"],
        resources: [dataKey.keyArn],
        conditions: {
          StringEquals: { "kms:ViaService": `dynamodb.${Stack.of(this).region}.amazonaws.com` },
        },
      }),
    );
  }

  /**
   * Lets `grantee` create and delete groups of this pool when a change of the registry is
   * approved (D26, dual approval in mango-api). Membership is not included: members are
   * assigned in the directory. Cognito scopes these actions to the pool, not to a group name,
   * so mango-api itself refuses the groups Mango depends on (`mango-*` and the role groups).
   */
  grantGroupManagement(grantee: iam.IGrantable): void {
    iam.Grant.addToPrincipal({
      grantee,
      actions: ["cognito-idp:CreateGroup", "cognito-idp:DeleteGroup"],
      resourceArns: [this.userPool.userPoolArn],
    });
  }

  /** Lets `grantee` reset a user's TOTP and revoke their sessions (D20), on this pool only. */
  grantMfaReset(grantee: iam.IGrantable): void {
    iam.Grant.addToPrincipal({
      grantee,
      actions: [
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminDeleteSoftwareToken",
        "cognito-idp:AdminUserGlobalSignOut",
      ],
      resourceArns: [this.userPool.userPoolArn],
    });
  }

  /**
   * Lets `grantee` resolve who an agent is shared with (D33): emails to user identifiers and
   * back, on this pool only. `AdminGetUser` reads one user by email and `ListUsers` finds one
   * by `sub`; neither changes anything. Only agent creators and administrators reach these
   * calls, with rate limits and audit in mango-api (exception agreed on 2026-10-02).
   */
  grantDirectoryLookup(grantee: iam.IGrantable): void {
    iam.Grant.addToPrincipal({
      grantee,
      actions: ["cognito-idp:AdminGetUser", "cognito-idp:ListUsers"],
      resourceArns: [this.userPool.userPoolArn],
    });
  }

  /**
   * Exports the threat protection user activity log (`userAuthEvents`, Plus only) to a log
   * group owned by the installation (D31): Cognito keeps that history for two years with no
   * control over it. The events hold PII (email, IP address, device, city) and no tokens or
   * passwords: the log group has its own retention and is never forwarded to operational logs.
   */
  private exportAuthEvents(
    cfg: Installation,
    removal: RemovalPolicy,
  ): cognito.CfnLogDeliveryConfiguration {
    const stack = Stack.of(this);
    const logGroupName = `/aws/vendedlogs/${mangoName(cfg.namespace, "cognito-auth-events")}`;
    // Without the trailing `:*` of `logGroupArn`, as SetLogDeliveryConfiguration expects.
    const logGroupArn = `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:${logGroupName}`;
    const logGroup = new logs.LogGroup(this, "AuthEvents", {
      logGroupName,
      retention: cfg.auth.authEventsRetentionDays,
      encryptionKey: logsKeyOf(this),
      removalPolicy: removal,
    });

    // Cognito delivers through CloudWatch vended logs. Declared here, scoped to this log group
    // and this account, so the deploying principal does not need `logs:PutResourcePolicy`.
    const deliveryPolicy = new logs.CfnResourcePolicy(this, "AuthEventsDeliveryPolicy", {
      policyName: mangoName(cfg.namespace, "CognitoAuthEventsDelivery"),
      policyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "CognitoAuthEventsDelivery",
            Effect: "Allow",
            Principal: { Service: "delivery.logs.amazonaws.com" },
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: `${logGroupArn}:log-stream:*`,
            Condition: {
              StringEquals: { "aws:SourceAccount": stack.account },
              ArnLike: {
                "aws:SourceArn": `arn:${stack.partition}:logs:${stack.region}:${stack.account}:*`,
              },
            },
          },
        ],
      }),
    });

    // `userAuthEvents` only has the INFO level. `userNotification` (email and SMS delivery
    // errors) is left out until the installation sends email through its own SES identity (D31).
    const delivery = new cognito.CfnLogDeliveryConfiguration(this, "AuthEventsDelivery", {
      userPoolId: this.userPool.userPoolId,
      logConfigurations: [
        {
          eventSource: "userAuthEvents",
          logLevel: "INFO",
          cloudWatchLogsConfiguration: { logGroupArn },
        },
      ],
    });
    delivery.addResourceDependency(logGroup.node.defaultChild as logs.CfnLogGroup);
    delivery.addResourceDependency(deliveryPolicy);
    return delivery;
  }

  /**
   * Regional web ACL on the user pool (TM-L3, TM-L10, TM-L11). Browsers call the Cognito API
   * directly, so the CloudFront WAF never sees sign-in, sign-up or recovery requests.
   */
  private protectUserPool(namespace: string): wafv2.CfnWebACL {
    const name = mangoName(namespace, "cognito");
    const visibility = (metricName: string) => ({
      cloudWatchMetricsEnabled: true,
      metricName,
      sampledRequestsEnabled: true,
    });
    const targetIs = (operations: string[]) => ({
      orStatement: {
        statements: operations.map((op) => ({
          byteMatchStatement: {
            fieldToMatch: { singleHeader: { Name: "x-amz-target" } },
            positionalConstraint: "EXACTLY",
            // Lowercased and trimmed on both sides: a case variant cannot skip the limit.
            searchString: `${TARGET_PREFIX}${op}`.toLowerCase(),
            textTransformations: [
              { priority: 0, type: "LOWERCASE" },
              { priority: 1, type: "COMPRESS_WHITE_SPACE" },
            ],
          },
        })),
      },
    });
    const rateRule = (ruleName: string, priority: number, limit: number, operations?: string[]) => ({
      name: ruleName,
      priority,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit,
          aggregateKeyType: "IP",
          evaluationWindowSec: 300,
          ...(operations ? { scopeDownStatement: targetIs(operations) } : {}),
        },
      },
      visibilityConfig: visibility(ruleName),
    });
    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      name,
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: visibility(name),
      rules: [
        ...["AWSManagedRulesAmazonIpReputationList", "AWSManagedRulesKnownBadInputsRuleSet"].map(
          (ruleGroup, i) => ({
            name: ruleGroup,
            priority: i,
            overrideAction: { none: {} },
            statement: { managedRuleGroupStatement: { vendorName: "AWS", name: ruleGroup } },
            visibilityConfig: visibility(ruleGroup),
          }),
        ),
        rateRule("EmailOperationsPerIp", 10, EMAIL_RATE_LIMIT, EMAIL_OPERATIONS),
        rateRule("SecretOperationsPerIp", 11, SECRET_RATE_LIMIT, SECRET_OPERATIONS),
        rateRule("RateLimitPerIp", 12, IP_RATE_LIMIT),
      ],
    });
    new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: this.userPool.userPoolArn,
      webAclArn: webAcl.attrArn,
    });
    return webAcl;
  }
}
