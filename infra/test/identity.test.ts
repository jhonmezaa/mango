import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessGroupRegistry } from "../lib/config/groups.js";
import {
  Installation,
  installationSchema,
  isPublicMailDomain,
  loadInstallation,
} from "../lib/config/schema.js";
import { Edge, spaAuthConfigSchema } from "../lib/constructs/edge.js";
import {
  EMAIL_OPERATIONS,
  EMAIL_RATE_LIMIT,
  IP_RATE_LIMIT,
  SECRET_OPERATIONS,
  SECRET_RATE_LIMIT,
  SESSION_HOURS,
} from "../lib/constructs/identity.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

const base = loadInstallation(
  resolve(import.meta.dirname, "../config/example.json"),
);
const lab: Installation = {
  ...base,
  installationType: "lab",
  mfa: "off",
  retainData: false,
  auth: { ...base.auth, cognitoPlan: "essentials" },
};

/** As in `cdk.json`: the partition is a literal, so ARNs in the template are plain strings. */
const PARTITION_LITERALS = { "@aws-cdk/core:enablePartitionLiterals": true };

function synth(cfg: Installation, context?: Record<string, unknown>): Template {
  const app = new App({ context });
  const stack = new CoreStack(app, "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  });
  return Template.fromStack(stack);
}

type Statement = {
  Action: string | string[];
  Resource: unknown;
  Effect: string;
};

function statementsOf(template: Template, roleName: string): Statement[] {
  const roles = template.findResources("AWS::IAM::Role", {
    Properties: { RoleName: roleName },
  });
  const [logicalId] = Object.keys(roles);
  const policies = Object.values(
    template.findResources("AWS::IAM::Policy"),
  ).filter((p) =>
    (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === logicalId),
  );
  return policies.flatMap(
    (p) => p.Properties.PolicyDocument.Statement as Statement[],
  );
}

describe("installation schema (D20)", () => {
  const parse = (patch: Record<string, unknown>) =>
    installationSchema.safeParse({ ...base, ...patch });

  it("forbids the lab exceptions in customer installations", () => {
    expect(parse({ mfa: "off" }).success).toBe(false);
    expect(parse({ retainData: false }).success).toBe(false);
    expect(
      parse({ auth: { ...base.auth, cognitoPlan: "essentials" } }).success,
    ).toBe(false);
    expect(installationSchema.safeParse(lab).success).toBe(true);
  });

  it.each([
    [[]],
    [["Empresa.com"]],
    [["*.empresa.com"]],
    [["empres\u0430.com"]],
    [["empresa.com", "empresa.com"]],
    [["empresa"]],
  ])("rejects sign-up domains %j", (signUpDomains) => {
    expect(parse({ auth: { ...base.auth, signUpDomains } }).success).toBe(
      false,
    );
  });

  it("accepts an optional https AI use policy URL", () => {
    expect(parse({}).success).toBe(true);
    const aiPolicyUrl = "https://intranet.example.com/politica-ia";
    expect(parse({ auth: { ...base.auth, aiPolicyUrl } }).success).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "http://intranet.example.com/ia",
    "https://user:pass@intranet.example.com/ia",
    "/politica-ia",
    "",
  ])("rejects aiPolicyUrl %j (it ends up in an href)", (aiPolicyUrl) => {
    expect(parse({ auth: { ...base.auth, aiPolicyUrl } }).success).toBe(false);
  });

  it("defaults to scoring high-risk sign-ins and one year of sign-in activity (D31)", () => {
    const { highRiskAction, authEventsRetentionDays, ...auth } = base.auth;
    const parsed = installationSchema.parse({ ...base, auth });
    expect(parsed.auth.highRiskAction).toBe("NO_ACTION");
    expect(parsed.auth.authEventsRetentionDays).toBe(365);
    expect([highRiskAction, authEventsRetentionDays]).toEqual(["NO_ACTION", 365]);
  });

  it("accepts BLOCK on high risk only with Cognito Plus", () => {
    expect(parse({ auth: { ...base.auth, highRiskAction: "BLOCK" } }).success).toBe(true);
    expect(
      installationSchema.safeParse({ ...lab, auth: { ...lab.auth, highRiskAction: "BLOCK" } })
        .success,
    ).toBe(false);
  });

  it.each(["MFA_IF_CONFIGURED", "MFA_REQUIRED", "block", ""])(
    "rejects high-risk action %j",
    (highRiskAction) => {
      expect(parse({ auth: { ...base.auth, highRiskAction } }).success).toBe(false);
    },
  );

  it.each([0, 1, 30, 366, 9999, 365.5, "365"])(
    "rejects sign-in activity retention %j",
    (authEventsRetentionDays) => {
      expect(parse({ auth: { ...base.auth, authEventsRetentionDays } }).success).toBe(false);
    },
  );

  it("forbids public mail domains in customer installations but allows them in the lab", () => {
    const gmail = { ...base.auth, signUpDomains: ["gmail.com"] };
    expect(parse({ auth: gmail }).success).toBe(false);
    // Country variants and disposable inboxes: the list of `mango_core.mail_domains`.
    for (const domain of [
      "outlook.es",
      "yahoo.co.uk",
      "live.com.mx",
      "mail.yahoo.es",
      "mailinator.com",
    ]) {
      expect(isPublicMailDomain(domain), domain).toBe(true);
      const auth = { ...base.auth, signUpDomains: [domain] };
      expect(parse({ auth }).success, domain).toBe(false);
    }
    for (const domain of ["example.com", "outlook.example.com", "notgmail.com"]) {
      expect(isPublicMailDomain(domain), domain).toBe(false);
    }
    expect(
      installationSchema.safeParse({
        ...lab,
        auth: { ...lab.auth, signUpDomains: ["gmail.com"] },
      }).success,
    ).toBe(true);
  });
});

describe("groups (Marketplace A1, D26)", () => {
  const parse = (patch: Record<string, unknown>) =>
    installationSchema.safeParse({ ...base, ...patch });
  const user = (groups: string[]) => [{ email: "a@example.com", groups }];
  const groupNames = (template: Template) =>
    Object.values(template.findResources("AWS::Cognito::UserPoolGroup"))
      .map((g) => g.Properties.GroupName as string)
      .sort();

  it("creates the system, area and access groups in Cognito", () => {
    expect(groupNames(synth(base))).toEqual([
      "bu-lead",
      "bu-sandbox",
      "bu-security",
      "finops-central",
      "mango-admin",
      "mango-agent-creator",
      "people",
    ]);
  });

  it("always creates the agent creators group, even with no user in it", () => {
    const template = synth({ ...base, accessGroups: {}, users: [] });
    expect(groupNames(template)).toContain("mango-agent-creator");
    expect(groupNames(template)).not.toContain("people");
  });

  it("puts a user in groups without any FinOps role", () => {
    const template = synth(base);
    const attachments = Object.values(
      template.findResources("AWS::Cognito::UserPoolUserToGroupAttachment"),
    )
      .filter((a) => a.Properties.Username === "agent-builder@example.com")
      .map((a) => a.Properties.GroupName as string)
      .sort();
    expect(attachments).toEqual(["mango-agent-creator", "people"]);
  });

  it("defaults to no extra access groups", () => {
    const { accessGroups: _unused, ...withoutGroups } = base;
    const parsed = installationSchema.parse({
      ...withoutGroups,
      users: base.users.filter((u) => !u.groups.includes("people")),
    });
    expect(parsed.accessGroups).toEqual({});
    expect(accessGroupRegistry(parsed).map((g) => g.id)).toEqual([
      "bu-lead",
      "bu-sandbox",
      "bu-security",
      "finops-central",
    ]);
  });

  it("types every registry entry: central, area with its area, or general", () => {
    const cfg = installationSchema.parse({
      ...base,
      accessGroups: {
        platform: { type: "central" },
        "security-analysts": { type: "area", area: "security", description: "Analistas" },
      },
      users: [],
    });
    expect(accessGroupRegistry(cfg)).toEqual([
      { id: "bu-lead", type: "general", description: "Líderes de área" },
      { id: "bu-sandbox", type: "area", area: "sandbox", description: "Líderes de sandbox" },
      { id: "bu-security", type: "area", area: "security", description: "Líderes de security" },
      { id: "finops-central", type: "central", description: "FinOps central" },
      { id: "platform", type: "central", description: "" },
      { id: "security-analysts", type: "area", area: "security", description: "Analistas" },
    ]);
  });

  it.each([
    [{ HR: { type: "general" } }],
    [{ h: { type: "general" } }],
    [{ "bu-finance": { type: "area", area: "security" } }],
    [{ "mango-admin": { type: "central" } }],
    [{ "mango-reviewers": { type: "general" } }],
    [{ "finops-central": { type: "general" } }],
    [{ hr: { type: "owner" } }],
    [{ hr: { type: "area" } }],
    [{ hr: { type: "general", area: "security" } }],
    [{ hr: { type: "area", area: "finance" } }],
    [{ hr: { type: "general", description: "x".repeat(201) } }],
    [{ hr: { type: "general", description: "line\nbreak" } }],
    [{ hr: { type: "general", description: "nb\u00a0sp" } }],
    [Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`g-${i}`, { type: "general" }]))],
  ])("rejects access groups %j", (accessGroups) => {
    expect(parse({ accessGroups, users: [] }).success).toBe(false);
  });

  it.each([
    [["mango-agent-creator"], true],
    [["people", "mango-agent-creator"], true],
    [["bu-lead", "bu-security"], true],
    [["mango-admin"], true],
    [["mango-agent-creators"], false],
    [["finops"], false],
    [["hr"], false],
    [["Admins"], false],
    [[], false],
  ])("user groups %j valid: %s", (groups, valid) => {
    expect(parse({ users: user(groups) }).success).toBe(valid);
  });
});

describe("customer user pool", () => {
  const template = synth(base);

  it("uses Plus with threat protection enforced and explicit risk actions", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolTier: "PLUS",
      UserPoolAddOns: { AdvancedSecurityMode: "ENFORCED" },
      MfaConfiguration: "ON",
      EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      AutoVerifiedAttributes: ["email"],
      UsernameAttributes: ["email"],
      DeletionProtection: "ACTIVE",
    });
    template.hasResourceProperties(
      "AWS::Cognito::UserPoolRiskConfigurationAttachment",
      {
        ClientId: "ALL",
        CompromisedCredentialsRiskConfiguration: {
          Actions: { EventAction: "BLOCK" },
          // SIGN_IN is a no-op with USER_SRP_AUTH (D29).
          EventFilter: ["SIGN_UP", "PASSWORD_CHANGE"],
        },
      },
    );
  });

  it("scores risky sign-ins without MFA actions that MFA required makes void (D29)", () => {
    const [attachment] = Object.values(
      template.findResources(
        "AWS::Cognito::UserPoolRiskConfigurationAttachment",
      ),
    );
    const actions =
      attachment?.Properties.AccountTakeoverRiskConfiguration.Actions ?? {};
    const eventActions = Object.values(
      actions as Record<string, { EventAction: string; Notify: boolean }>,
    );
    expect(eventActions).toHaveLength(3);
    for (const action of eventActions) {
      expect(action).toEqual({ EventAction: "NO_ACTION", Notify: false });
    }
  });

  it("blocks high-risk sign-ins only when the installation asks for it (D31)", () => {
    const blocking = synth({ ...base, auth: { ...base.auth, highRiskAction: "BLOCK" } });
    blocking.hasResourceProperties("AWS::Cognito::UserPoolRiskConfigurationAttachment", {
      AccountTakeoverRiskConfiguration: {
        Actions: {
          LowAction: { EventAction: "NO_ACTION", Notify: false },
          MediumAction: { EventAction: "NO_ACTION", Notify: false },
          HighAction: { EventAction: "BLOCK", Notify: false },
        },
      },
    });
  });

  it("keeps the attribute schema of the D14 pool (no replacement on update)", () => {
    const [pool] = Object.values(
      template.findResources("AWS::Cognito::UserPool"),
    );
    expect(pool?.Properties.Schema).toEqual([
      { Mutable: false, Name: "email", Required: true },
    ]);
  });

  it("allows only SRP and refresh on the web client, hides user existence", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      PreventUserExistenceErrors: "ENABLED",
      EnableTokenRevocation: true,
      GenerateSecret: false,
      WriteAttributes: ["email", "name"],
      SupportedIdentityProviders: ["COGNITO"],
    });
    const text = JSON.stringify(template.toJSON());
    expect(text).not.toContain("USER_PASSWORD_AUTH");
    expect(text).not.toContain("ALLOW_USER_AUTH");
    expect(text).not.toContain("ALLOW_CUSTOM_AUTH");
  });

  it("lets mango-api renew sessions with the signed operation, which cannot sign in with a password (D72)", () => {
    const renewal = statementsOf(template, "Mango-poc-ApiTask").filter((s) =>
      JSON.stringify(s.Action).includes("cognito-idp:AdminInitiateAuth"),
    );
    // One statement, on the user pool of this installation and nothing else.
    expect(renewal).toHaveLength(1);
    expect(renewal[0]).toMatchObject({
      Effect: "Allow",
      Resource: { "Fn::GetAtt": [expect.stringMatching(/UserPool/), "Arn"] },
    });
    // No other role of the stack may start an auth flow from the server.
    const holders = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) =>
      /cognito-idp:Admin(InitiateAuth|RespondToAuthChallenge)|cognito-idp:\*/.test(
        JSON.stringify(p.Properties.PolicyDocument),
      ),
    );
    expect(holders).toHaveLength(1);
    expect(JSON.stringify(holders)).not.toContain("AdminRespondToAuthChallenge");
    // `AdminInitiateAuth` signs in with a password on a client that allows one of these flows:
    // with any of them, the permission above would let mango-api sign in as anybody whose
    // password it had, without SRP. The clients of the pool allow SRP and refresh only.
    // Do not add a flow here without a recorded decision that revisits D72.
    const clients = Object.values(template.findResources("AWS::Cognito::UserPoolClient"));
    expect(clients).toHaveLength(1);
    for (const client of clients) {
      const flows = client.Properties.ExplicitAuthFlows as string[];
      expect(flows, "an empty list means the defaults of Cognito, not «none»").toBeDefined();
      for (const forbidden of [
        "ALLOW_ADMIN_USER_PASSWORD_AUTH",
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_USER_AUTH",
        "ADMIN_NO_SRP_AUTH",
        "USER_PASSWORD_AUTH",
      ])
        expect(flows, `${forbidden} would turn AdminInitiateAuth into a password sign-in`).not.toContain(forbidden);
      expect([...flows].sort()).toEqual(["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]);
    }
  });

  it("validates sign-up domains server-side with a pre sign-up trigger", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "Mango-poc-PreSignUp",
      Handler: "mango_pre_sign_up.handler.lambda_handler",
      Environment: { Variables: { SIGN_UP_DOMAINS: "example.com" } },
      KmsKeyArn: Match.anyValue(),
    });
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: {
        PreSignUp: Match.anyValue(),
        PreTokenGenerationConfig: {
          LambdaVersion: "V2_0",
          LambdaArn: Match.anyValue(),
        },
      },
    });
  });

  it("puts a regional WAF with rate limits in front of the Cognito API", () => {
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      Name: "Mango-poc-cognito",
      Scope: "REGIONAL",
    });
    const [acl] = Object.values(
      template.findResources("AWS::WAFv2::WebACL", {
        Properties: { Scope: "REGIONAL" },
      }),
    );
    const rules = acl?.Properties.Rules as {
      Name: string;
      Statement: {
        RateBasedStatement?: {
          Limit: number;
          AggregateKeyType: string;
          EvaluationWindowSec: number;
          ScopeDownStatement?: { OrStatement: { Statements: unknown[] } };
        };
      };
    }[];
    expect(rules.map((r) => r.Name)).toEqual([
      "AWSManagedRulesAmazonIpReputationList",
      "AWSManagedRulesKnownBadInputsRuleSet",
      "EmailOperationsPerIp",
      "SecretOperationsPerIp",
      "RateLimitPerIp",
    ]);
    const scoped = (name: string) =>
      JSON.stringify(
        rules.find((r) => r.Name === name)?.Statement.RateBasedStatement
          ?.ScopeDownStatement,
      );
    for (const op of EMAIL_OPERATIONS)
      expect(scoped("EmailOperationsPerIp")).toContain(
        `service.${op.toLowerCase()}"`,
      );
    for (const op of SECRET_OPERATIONS)
      expect(scoped("SecretOperationsPerIp")).toContain(
        `service.${op.toLowerCase()}"`,
      );
    // D72: per IP address every 5 minutes. The email limit is the daily quota of the default
    // sender of Cognito and does not go up with the others.
    expect(
      Object.fromEntries(
        rules
          .filter((r) => r.Statement.RateBasedStatement)
          .map((r) => [r.Name, r.Statement.RateBasedStatement?.Limit]),
      ),
    ).toEqual({
      EmailOperationsPerIp: 50,
      SecretOperationsPerIp: 1500,
      RateLimitPerIp: 5000,
    });
    expect([EMAIL_RATE_LIMIT, SECRET_RATE_LIMIT, IP_RATE_LIMIT]).toEqual([50, 1500, 5000]);
    for (const rule of rules.filter((r) => r.Statement.RateBasedStatement))
      expect(rule.Statement.RateBasedStatement).toMatchObject({
        AggregateKeyType: "IP",
        EvaluationWindowSec: 300,
      });
    // The only rule without a filter is the total.
    expect(scoped("RateLimitPerIp")).toBeUndefined();
    template.hasResourceProperties("AWS::WAFv2::WebACLAssociation", {
      ResourceArn: {
        "Fn::GetAtt": [Match.stringLikeRegexp("UserPool"), "Arn"],
      },
    });
  });

  it("lets mango-api reset MFA, manage groups and people only on its own user pool", () => {
    const statements = statementsOf(template, "Mango-poc-ApiTask").filter((s) =>
      JSON.stringify(s.Action).includes("cognito-idp:"),
    );
    // Exactly what mango-api uses: MFA reset (D20), the group registry (D26), sharing agents
    // with people (D33), Settings > People (D60, which includes preferring a TOTP the
    // person already verified) and renewing web sessions (D72). Nothing deletes a user, sets
    // a password, changes an attribute or touches the pool's configuration.
    expect(
      [...new Set(statements.flatMap((s) => s.Action))].sort(),
    ).toEqual([
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminDeleteSoftwareToken",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminInitiateAuth",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:AdminSetUserMFAPreference",
      "cognito-idp:AdminUserGlobalSignOut",
      "cognito-idp:CreateGroup",
      "cognito-idp:DeleteGroup",
      "cognito-idp:ListUsers",
      "cognito-idp:ListUsersInGroup",
    ]);
    for (const statement of statements) {
      expect(statement.Effect).toBe("Allow");
      expect(statement.Resource).toEqual({
        "Fn::GetAtt": [expect.stringMatching(/UserPool/), "Arn"],
      });
    }
  });

  it("lets the pre-token trigger read the group registry and nothing else (D35)", () => {
    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: "Mango-poc-PreTokenGeneration" },
    });
    const [fn] = Object.values(functions);
    expect(fn?.Properties.Environment.Variables).toEqual({
      SETTINGS_TABLE: { Ref: expect.stringMatching(/GovernanceSettings/) },
    });
    expect(fn?.Properties.KmsKeyArn).toBeDefined();
    const roleId = (fn?.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    const statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === roleId))
      .flatMap(
        (p) => p.Properties.PolicyDocument.Statement as (Statement & { Condition?: unknown; Sid?: string })[],
      );
    const data = statements.filter((s) => JSON.stringify(s.Action).includes("dynamodb:"));
    expect(data).toHaveLength(1);
    expect(data[0]?.Action).toBe("dynamodb:Query");
    expect(data[0]?.Resource).toEqual({
      "Fn::GetAtt": [expect.stringMatching(/GovernanceSettings/), "Arn"],
    });
    expect(data[0]?.Condition).toEqual({
      "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["GROUPS"] },
    });
    const kms = statements.filter((s) => JSON.stringify(s.Action).includes("kms:"));
    expect(kms).toHaveLength(1);
    expect(kms[0]?.Action).toBe("kms:Decrypt");
    expect(kms[0]?.Condition).toEqual({
      StringEquals: { "kms:ViaService": "dynamodb.us-east-1.amazonaws.com" },
    });
    // No write, no Cognito and no other table.
    const others = statements
      .flatMap((s) => s.Action)
      .filter((a) => !/^(dynamodb:Query|kms:Decrypt|logs:|xray:)/.test(a));
    expect(others).toEqual([]);
  });

  it("passes the user pool id to mango-api", () => {
    const [task] = Object.values(
      template.findResources("AWS::ECS::TaskDefinition"),
    );
    const env = (task?.Properties.ContainerDefinitions[0].Environment ??
      []) as { Name: string }[];
    expect(env.map((e) => e.Name)).toContain("COGNITO_USER_POOL_ID");
  });
});

describe("sign-in activity export (D31)", () => {
  const template = synth(base, PARTITION_LITERALS);
  const logGroupName = "/aws/vendedlogs/Mango-poc-cognito-auth-events";
  const logGroupArn = `arn:aws:logs:us-east-1:${base.mangoAccountId}:log-group:${logGroupName}`;

  it("keeps the events in a namespaced, encrypted and retained log group", () => {
    template.hasResource("AWS::Logs::LogGroup", {
      Properties: {
        LogGroupName: logGroupName,
        RetentionInDays: 365,
        KmsKeyId: { "Fn::GetAtt": [Match.stringLikeRegexp("^LogsKey"), "Arn"] },
      },
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("uses the configured retention", () => {
    const longer = synth({ ...base, auth: { ...base.auth, authEventsRetentionDays: 731 } });
    longer.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: logGroupName,
      RetentionInDays: 731,
    });
  });

  it("exports only userAuthEvents, after threat protection and the delivery policy exist", () => {
    template.resourceCountIs("AWS::Cognito::LogDeliveryConfiguration", 1);
    template.hasResource("AWS::Cognito::LogDeliveryConfiguration", {
      Properties: {
        UserPoolId: { Ref: Match.stringLikeRegexp("UserPool") },
        LogConfigurations: [
          {
            EventSource: "userAuthEvents",
            LogLevel: "INFO",
            CloudWatchLogsConfiguration: { LogGroupArn: logGroupArn },
          },
        ],
      },
      DependsOn: [
        Match.stringLikeRegexp("^IdentityAuthEvents[0-9A-F]{8}$"),
        Match.stringLikeRegexp("AuthEventsDeliveryPolicy"),
        Match.stringLikeRegexp("RiskConfiguration"),
      ],
    });
  });

  it("lets only log delivery from this account write to that log group", () => {
    const policies = template.findResources("AWS::Logs::ResourcePolicy", {
      Properties: { PolicyName: "Mango-poc-CognitoAuthEventsDelivery" },
    });
    const [policy] = Object.values(policies);
    expect(JSON.parse(policy?.Properties.PolicyDocument as string)).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "CognitoAuthEventsDelivery",
          Effect: "Allow",
          Principal: { Service: "delivery.logs.amazonaws.com" },
          Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
          Resource: `${logGroupArn}:log-stream:*`,
          Condition: {
            StringEquals: { "aws:SourceAccount": base.mangoAccountId },
            ArnLike: {
              "aws:SourceArn": `arn:aws:logs:us-east-1:${base.mangoAccountId}:*`,
            },
          },
        },
      ],
    });
  });

  it("does not forward the events anywhere else", () => {
    template.resourceCountIs("AWS::Logs::SubscriptionFilter", 0);
    template.resourceCountIs("AWS::Logs::MetricFilter", 0);
  });

  it("is deleted with a Plus lab that does not retain data", () => {
    const plusLab = synth({ ...lab, auth: { ...lab.auth, cognitoPlan: "plus" } });
    plusLab.resourceCountIs("AWS::Cognito::LogDeliveryConfiguration", 1);
    plusLab.hasResource("AWS::Logs::LogGroup", {
      Properties: { LogGroupName: logGroupName },
      DeletionPolicy: "Delete",
    });
  });
});

describe("lab user pool (D14/D20 exceptions)", () => {
  const template = synth(lab);

  it("uses Essentials and no MFA, but keeps the regional WAF", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolTier: "ESSENTIALS",
      MfaConfiguration: "OFF",
    });
    template.resourceCountIs(
      "AWS::Cognito::UserPoolRiskConfigurationAttachment",
      0,
    );
    template.resourceCountIs("AWS::WAFv2::WebACLAssociation", 1);
  });

  it("does not export sign-in activity: Essentials has no threat protection (D31)", () => {
    template.resourceCountIs("AWS::Cognito::LogDeliveryConfiguration", 0);
    expect(
      template.findResources("AWS::Logs::LogGroup", {
        Properties: { LogGroupName: Match.stringLikeRegexp("cognito-auth-events") },
      }),
    ).toEqual({});
    expect(
      template.findResources("AWS::Logs::ResourcePolicy", {
        Properties: { PolicyName: Match.stringLikeRegexp("CognitoAuthEvents") },
      }),
    ).toEqual({});
  });
});

describe("SPA config.json auth policy (Ajustes › Autenticación)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function publishedAuth(cfg: Installation): unknown {
    const deploy = vi.spyOn(Edge.prototype, "deploySpa").mockImplementation(() => undefined);
    synth(cfg);
    expect(deploy).toHaveBeenCalledTimes(1);
    return deploy.mock.calls[0]?.[0].auth;
  }

  it("publishes the customer installation policy", () => {
    expect(publishedAuth(base)).toEqual({
      installationType: "customer",
      mfa: "required",
      sessionHours: SESSION_HOURS,
    });
  });

  it("publishes the lab policy", () => {
    expect(publishedAuth(lab)).toEqual({
      installationType: "lab",
      mfa: "off",
      sessionHours: SESSION_HOURS,
    });
  });

  it("matches the refresh token validity of the web client", () => {
    synth(base).hasResourceProperties("AWS::Cognito::UserPoolClient", {
      RefreshTokenValidity: SESSION_HOURS * 60,
      TokenValidityUnits: Match.objectLike({ RefreshToken: "minutes" }),
    });
  });

  it.each([
    { installationType: "customer", mfa: "optional", sessionHours: 12 },
    { installationType: "lab", mfa: "off", sessionHours: 0 },
    { installationType: "lab", mfa: "off", sessionHours: 25 },
    { installationType: "lab", mfa: "off", sessionHours: 12, secret: "x" },
  ])("rejects %j", (auth) => {
    expect(spaAuthConfigSchema.safeParse(auth).success).toBe(false);
  });
});
