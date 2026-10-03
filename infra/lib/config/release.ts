import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Aws, CfnCondition, CfnParameter, CfnRule, Fn, Stack, Token } from "aws-cdk-lib";
import { z } from "zod";
import { managementAccountIdParameter, namespaceParameter, organizationIdParameter } from "../params.js";
import { AGENTCORE_VPC_ZONE_IDS, Installation } from "./schema.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const modelId = z.string().regex(/^(us|global)\.anthropic\.[a-z0-9.:-]+$/);
const price = z.number().nonnegative();

/**
 * Values every installation of a release starts with (`release-defaults.json`, rule 7): the
 * default models, their prices and the default budgets. They only seed the Settings table;
 * afterwards an administrator changes them in the app (D17, D58).
 */
const releaseDefaultsSchema = z
  .object({
    models: z.object({ agent: modelId, auxiliary: modelId }).strict(),
    modelPrices: z.record(
      modelId,
      z.object({ input: price, output: price, cacheRead: price, cacheWrite: price }).strict(),
    ),
    budgets: z
      .object({
        userMonthlyUsd: z.number().positive().max(10_000),
        agentMonthlyUsd: z.number().positive().max(100_000),
      })
      .strict(),
  })
  .strict()
  .refine((d) => Object.hasOwn(d.modelPrices, d.models.agent) && Object.hasOwn(d.modelPrices, d.models.auxiliary), {
    message: "every default model needs a price",
  });

export type ReleaseDefaults = z.infer<typeof releaseDefaultsSchema>;

export function loadReleaseDefaults(): ReleaseDefaults {
  return releaseDefaultsSchema.parse(JSON.parse(readFileSync(resolve(REPO_ROOT, "release-defaults.json"), "utf8")));
}

type ZoneId = (typeof AGENTCORE_VPC_ZONE_IDS)[number];

const EMAIL = "[^@\\s,]+@[^@\\s,]+\\.[^@\\s,]+";
const DOMAIN = "([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}";
const OU = "ou-[0-9a-z]{4,32}-[0-9a-z]{8,32}";

/** What the release decides besides {@link Installation}: resources that exist or not by parameter. */
export interface CoreParameters {
  readonly installation: Installation;
  /** True when the stack turns CloudWatch Transaction Search on (it is an account-wide setting). */
  readonly ownsTransactionSearch: CfnCondition;
  /** Second administrator, when one was named: dual approvals need two from the first day. */
  readonly hasSecondAdmin: CfnCondition;
  readonly secondAdminEmail: string;
  /** Object Lock mode of the audit bucket (`GOVERNANCE` or `COMPLIANCE`). */
  readonly auditLockMode: string;
  /** What config.json of the SPA takes from parameters, as deploy-time text. */
  readonly spa: { readonly signUpDomains: string; readonly aiPolicyUrlMember: string };
}

/**
 * The installation as the release template sees it (D58): the few values that differ between
 * customers are stack parameters, the rest are values of the release. It has the shape of
 * {@link Installation}, with deploy-time values in place of the customer's.
 */
export function coreParameters(stack: Stack): CoreParameters {
  const defaults = loadReleaseDefaults();
  const text = (id: string, props: ConstructorParameters<typeof CfnParameter>[2]) => new CfnParameter(stack, id, props);

  // --- Asked of every installation ---------------------------------------------------------
  const namespace = namespaceParameter(stack);
  const organizationId = organizationIdParameter(stack);
  const managementAccountId = managementAccountIdParameter(stack);
  const firstAdmin = text("FirstAdminEmail", {
    type: "String",
    description:
      "Email of the first administrator. Cognito sends it a temporary password; it has to register MFA on its first sign-in.",
    allowedPattern: `^${EMAIL}$`,
    constraintDescription: "must be an email address",
  });
  const alertsEmail = text("AlertsEmail", {
    type: "String",
    description: "Mailbox subscribed to the alarms of the installation. It receives a confirmation link.",
    allowedPattern: `^${EMAIL}$`,
    constraintDescription: "must be an email address",
  });
  const signUpDomains = text("SignUpDomains", {
    type: "String",
    description:
      "Company email domains allowed to register, separated by commas (lowercase; list subdomains explicitly). " +
      "Public mail providers are refused.",
    allowedPattern: `^${DOMAIN}(,${DOMAIN}){0,19}$`,
    constraintDescription: "must be lowercase domains separated by commas, without spaces",
  });

  // --- With a default ------------------------------------------------------------------------
  const secondAdmin = text("SecondAdminEmail", {
    type: "String",
    default: "",
    description: "Optional second administrator: changes with dual approval need two.",
    allowedPattern: `^$|^${EMAIL}$`,
    constraintDescription: "must be an email address or empty",
  });
  const zoneIds = text("AvailabilityZoneIds", {
    type: "CommaDelimitedList",
    default: "use1-az1,use1-az2",
    description:
      "Two Availability Zone ids (not names) for the network. Zones where CloudFront VPC origins and AgentCore " +
      "Runtime are available.",
    // CloudFormation checks the pattern against each element of the list.
    allowedPattern: `^(${AGENTCORE_VPC_ZONE_IDS.join("|")})$`,
    constraintDescription: `must be two of ${AGENTCORE_VPC_ZONE_IDS.join(", ")}, separated by a comma`,
  });
  const aiPolicyUrl = text("AiPolicyUrl", {
    type: "String",
    default: "",
    description: "Optional https URL of the company's AI use policy; sign-up asks to accept it.",
    // No quotes, backslashes or control characters: the URL is written into config.json as is.
    allowedPattern: "^$|^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%!$&()*+,;=:/?#-]*)?$",
    maxLength: 2048,
    constraintDescription: "must be an https URL without credentials, or empty",
  });
  const highRisk = text("HighRiskSignInAction", {
    type: "String",
    default: "NO_ACTION",
    allowedValues: ["NO_ACTION", "BLOCK"],
    description: "Response to a high-risk sign-in. BLOCK only once the installation meets the criteria of D31.",
  });
  const auditDays = text("AuditRetentionDays", {
    type: "Number",
    default: 365,
    minValue: 1,
    maxValue: 3650,
    description: "Days every audit record is locked against deletion (S3 Object Lock).",
  });
  const auditMode = text("AuditLockMode", {
    type: "String",
    default: "GOVERNANCE",
    allowedValues: ["GOVERNANCE", "COMPLIANCE"],
    description: "COMPLIANCE cannot be shortened or removed by anyone, the account root included, until it expires.",
  });
  const transactionSearch = text("TransactionSearch", {
    type: "String",
    default: "stack",
    allowedValues: ["stack", "external"],
    description:
      "CloudWatch Transaction Search is an account-wide setting AgentCore traces need. 'stack' turns it on here; " +
      "'external' when the account already manages it.",
  });
  const memberTargets = text("MemberAccessTargets", {
    type: "String",
    default: "",
    description:
      "The Targets given to the OrgAccess stack (root id, or OU ids separated by commas), so that administrators " +
      "can check the member accounts. Empty without OrgAccess.",
    allowedPattern: `^$|^r-[0-9a-z]{4,32}$|^${OU}(,${OU}){0,49}$`,
    constraintDescription: "must be one root id, OU ids separated by commas, or empty",
  });
  const memberExcluded = text("MemberAccessExcludedAccountIds", {
    type: "String",
    default: "",
    description: "The ExcludedAccountIds given to the OrgAccess stack. Empty without OrgAccess.",
    allowedPattern: "^$|^[0-9]{12}(,[0-9]{12}){0,49}$",
    constraintDescription: "must be 12-digit account ids separated by commas, or empty",
  });

  new CfnRule(stack, "ManagementAccountIsAnother", {
    assertions: [
      {
        assert: Fn.conditionNot(Fn.conditionEquals(managementAccountId, stack.account)),
        assertDescription:
          "Mango is installed in its own account, not in the organization management account (ManagementAccountId).",
      },
    ],
  });
  new CfnRule(stack, "SupportedRegion", {
    assertions: [
      {
        assert: Fn.conditionEquals(Aws.REGION, stack.region),
        assertDescription: "This template was built for another Region.",
      },
    ],
  });

  const installation: Installation = {
    namespace,
    // Customer installations only (D58): MFA required, Cognito Plus, data retained.
    installationType: "customer",
    mfa: "required",
    retainData: true,
    region: "us-east-1",
    mangoAccountId: stack.account,
    managementAccountId,
    organizationId,
    // Deploy-time values; the parameter's pattern only admits the supported zone ids.
    availabilityZoneIds: [Fn.select(0, zoneIds.valueAsList), Fn.select(1, zoneIds.valueAsList)] as ZoneId[],
    // Areas, groups and people are configured in the app after installing (D17, D26).
    businessUnits: {},
    accessGroups: {},
    users: [{ email: firstAdmin.valueAsString, groups: ["finops-central", "mango-admin"] }],
    auth: {
      // One element holding the whole list: every use joins it with commas.
      signUpDomains: [signUpDomains.valueAsString],
      cognitoPlan: "plus",
      highRiskAction: highRisk.valueAsString as "NO_ACTION" | "BLOCK",
      // One year, fixed by the release (D31): cfn-guard requires a literal retention on every
      // log group, so it is not a parameter.
      authEventsRetentionDays: 365,
      aiPolicyUrl: aiPolicyUrl.valueAsString,
    },
    models: defaults.models,
    modelPrices: defaults.modelPrices,
    budgets: defaults.budgets,
    audit: { retentionDays: Token.asNumber(auditDays.valueAsNumber), mode: "GOVERNANCE" },
    packs: { network: { cidr: "10.210.0.0/22", availabilityZoneIds: ["use1-az1", "use1-az2"] } },
    gateway: { mcpSessions: true },
    orgAccess: {
      targets: [memberTargets.valueAsString],
      excludedAccountIds: [memberExcluded.valueAsString],
    },
    observability: { transactionSearch: "stack" },
    alerts: { emails: [alertsEmail.valueAsString] },
  };

  return {
    installation,
    ownsTransactionSearch: new CfnCondition(stack, "OwnsTransactionSearch", {
      expression: Fn.conditionEquals(transactionSearch.valueAsString, "stack"),
    }),
    hasSecondAdmin: new CfnCondition(stack, "HasSecondAdmin", {
      expression: Fn.conditionNot(Fn.conditionEquals(secondAdmin.valueAsString, "")),
    }),
    secondAdminEmail: secondAdmin.valueAsString,
    auditLockMode: auditMode.valueAsString,
    spa: {
      signUpDomains: signUpDomains.valueAsString,
      aiPolicyUrlMember: Fn.conditionIf(
        new CfnCondition(stack, "HasAiPolicyUrl", {
          expression: Fn.conditionNot(Fn.conditionEquals(aiPolicyUrl.valueAsString, "")),
        }).logicalId,
        `,"aiPolicyUrl":"${aiPolicyUrl.valueAsString}"`,
        "",
      ).toString(),
    },
  };
}
