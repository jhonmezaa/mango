import { readFileSync } from "node:fs";
import { z } from "zod";

const accountId = z
  .string()
  .regex(/^\d{12}$/, "must be a 12-digit AWS account id");
const ouId = z
  .string()
  .regex(/^ou-[0-9a-z]{4,32}-[0-9a-z]{8,32}$/, "must be an OU id");
/** Organization root id: the whole organization as a StackSet target. */
const rootId = z.string().regex(/^r-[0-9a-z]{4,32}$/, "must be a root id");
const businessUnitName = z.string().regex(/^[a-z0-9-]{2,32}$/);
/** Lowercase ASCII DNS name (punycode for IDNs); compared by exact equality (TM-L4). */
const emailDomain = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "must be a lowercase domain",
  );
const SYSTEM_GROUPS = [
  "finops-central",
  "bu-lead",
  "mango-admin",
  "mango-agent-creator",
];
const BU_GROUP = /^bu-[a-z0-9-]{2,32}$/;
/** Same rule as `mango_core.groups` and the design: lowercase, digits and hyphens. */
const accessGroupId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,31}$/)
  .refine(
    (id) => !id.startsWith("bu-") && !id.startsWith("mango-") && !SYSTEM_GROUPS.includes(id),
    "reserved group name",
  );
/** A system group, `bu-<area>` or a key of `accessGroups` (checked against the whole config). */
const groupName = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);

/**
 * Installation parameters (D8, rule 8). Environment-specific values live in
 * `infra/config/<env>.json`, which is git-ignored; `infra/config/example.json` documents
 * the shape.
 */
/**
 * Public mail providers: open sign-up from these would admit anyone (D28). The list is the one
 * the pre sign-up trigger and the invitations use (`mango_core.mail_domains`), read from its
 * data file so there is no copy to keep equal.
 */
const publicMail = z
  .object({
    families: z.array(z.string()),
    secondLevels: z.array(z.string()),
    domains: z.array(z.string()),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/py/mango-core/src/mango_core/public_mail_domains.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
const PUBLIC_MAIL_FAMILIES = new Set(publicMail.families);
const PUBLIC_MAIL_SECOND_LEVELS = new Set(publicMail.secondLevels);
const PUBLIC_MAIL_DOMAINS = new Set(publicMail.domains);

/** Same rule as `is_public_mail_domain` in `mango_core.mail_domains`. */
export function isPublicMailDomain(domain: string): boolean {
  const labels = domain.trim().toLowerCase().replace(/\.$/, "").split(".");
  for (let start = 0; start < labels.length - 1; start += 1) {
    const suffix = labels.slice(start);
    if (PUBLIC_MAIL_DOMAINS.has(suffix.join("."))) return true;
    if (!PUBLIC_MAIL_FAMILIES.has(suffix[0] ?? "")) continue;
    if (suffix.length === 2) return true;
    if (
      suffix.length === 3 &&
      PUBLIC_MAIL_SECOND_LEVELS.has(suffix[1] ?? "") &&
      suffix[2]?.length === 2
    ) {
      return true;
    }
  }
  return false;
}

/**
 * CloudWatch Logs retention periods (days) accepted for the exported Cognito sign-in activity:
 * at least 90 days, so an incident can still be investigated; never unlimited (it holds PII).
 */
export const AUTH_EVENTS_RETENTION_DAYS = [
  90, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
];

/**
 * Availability Zone ids of us-east-1 where AgentCore Runtime supports VPC mode (AgentCore
 * developer guide, "Supported Availability Zones"). A subnet anywhere else fails at creation.
 */
export const AGENTCORE_VPC_ZONE_IDS = ["use1-az1", "use1-az2", "use1-az4"] as const;

const DEFAULT_PACK_NETWORK: { cidr: string; availabilityZoneIds: (typeof AGENTCORE_VPC_ZONE_IDS)[number][] } = {
  cidr: "10.210.0.0/22",
  availabilityZoneIds: ["use1-az1", "use1-az2"],
};

export const installationSchema = z
  .object({
    /** 3-8 lowercase alphanumerics, prefixed to every global name (rule 6). */
    namespace: z.string().regex(/^[a-z0-9]{3,8}$/),
    /**
     * `customer`: an installation for a customer (MFA required, Cognito Plus, data retained).
     * `lab`: Mango's own lab, where the exceptions in the decision log apply (D14, D20).
     */
    installationType: z.enum(["customer", "lab"]),
    region: z.literal("us-east-1"),
    /** Account where Mango is installed (Core stack). */
    mangoAccountId: accountId,
    /** Organization management (payer) account (Payer stack). */
    managementAccountId: accountId,
    organizationId: z.string().regex(/^o-[a-z0-9]{10,32}$/),
    /**
     * Two Availability Zone **ids** for the network of mango-api. Ids, not names: a name maps
     * to a different zone in every account. CloudFront VPC origins do not support use1-az3.
     */
    availabilityZoneIds: z
      .array(z.enum(AGENTCORE_VPC_ZONE_IDS))
      .length(2)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate Availability Zone id"),
    /**
     * Initial business unit -> OU ids (D17: seeded put-if-absent; the Settings table is
     * authoritative afterwards). Limits match `mango_core.business_units` (20 x 15).
     */
    businessUnits: z
      .record(businessUnitName, z.array(ouId).min(1).max(15))
      .refine(
        (units) => Object.keys(units).length <= 20,
        "at most 20 business units",
      ),
    /**
     * Initial access groups besides the built-in ones (D26; see `config/groups.ts`). Each one
     * becomes a Cognito group and an entry of the group registry, seeded only while the
     * registry is empty: afterwards the Settings table is authoritative, like D17.
     */
    accessGroups: z
      .record(
        accessGroupId,
        z
          .object({
            /** `central` may use account-data tools; `area` and `general` may not. */
            type: z.enum(["central", "area", "general"]),
            /** Area groups only: one of `businessUnits`. */
            area: businessUnitName.optional(),
            description: z
              .string()
              .max(200)
              // Printable text only, as `str.isprintable()` in `mango_core.groups`.
              .regex(/^(?:[^\p{C}\p{Z}]| )*$/u, "printable characters only")
              .optional(),
          })
          .refine(
            (g) => (g.type === "area") === (g.area !== undefined),
            "area is required for area groups only",
          ),
      )
      .refine((groups) => Object.keys(groups).length <= 50, "at most 50 access groups")
      .default({}),
    /** TOTP MFA for Cognito users. `off` is a lab-only choice (see decision log). */
    mfa: z.enum(["required", "off"]),
    /** Own login and self sign-up (D20, threat model `login-threat-model.md`). */
    auth: z.object({
      /**
       * Company email domains allowed to self-register, checked server-side by the pre sign-up
       * Lambda by exact equality: list subdomains explicitly.
       */
      signUpDomains: z
        .array(emailDomain)
        .min(1)
        .max(20)
        .refine((d) => new Set(d).size === d.length, "duplicate domains"),
      /**
       * Cognito feature plan: `plus` for customers (D20, D29): blocks compromised passwords at
       * sign-up and password reset, and keeps a risk-scored auth event history.
       */
      cognitoPlan: z.enum(["plus", "essentials"]),
      /**
       * Adaptive authentication response to a high-risk sign-in (Plus only, D31). `NO_ACTION`
       * scores and logs it. `BLOCK` rejects it: only once the installation meets the exit
       * criteria of D31 (SES notifications, observed traffic, false positives under the
       * threshold). Low and medium risk are never acted on.
       */
      highRiskAction: z.enum(["NO_ACTION", "BLOCK"]).default("NO_ACTION"),
      /**
       * Retention of the exported sign-in activity log (Plus only, D31). It holds PII (email,
       * IP address, device, city), so it is bounded. Default one year: the usual baseline for
       * security logs (e.g. PCI DSS 10.5.1) and enough to investigate a late-detected takeover.
       */
      authEventsRetentionDays: z
        .number()
        .int()
        .refine(
          (days) => AUTH_EVENTS_RETENTION_DAYS.includes(days),
          `must be one of ${AUTH_EVENTS_RETENTION_DAYS.join(", ")}`,
        )
        .default(365),
      /**
       * Optional company AI use policy. When set, sign-up asks to accept it and Ajustes ›
       * Autenticación shows it. `https:` only: it ends up in an `href` of the SPA.
       */
      aiPolicyUrl: z
        .url({ protocol: /^https$/ })
        .max(2048)
        .refine((value) => {
          const url = URL.canParse(value) ? new URL(value) : null;
          return url !== null && !url.username && !url.password;
        }, "must be an https URL without credentials")
        .optional(),
    }),
    /** PoC users (D14). Cognito emails a temporary password. */
    users: z
      .array(
        z.object({
          email: z.email(),
          groups: z.array(groupName).min(1),
          /** Lab-only automated test users: no invitation email is sent. */
          e2e: z.boolean().optional(),
        }),
      )
      .max(20),
    models: z.object({
      /** Bedrock inference profile id for the FinOps agent. */
      agent: z.string().regex(/^(us|global)\.anthropic\.[a-z0-9.:-]+$/),
      /** Bedrock inference profile id for auxiliary tasks (titles). */
      auxiliary: z.string().regex(/^(us|global)\.anthropic\.[a-z0-9.:-]+$/),
    }),
    /**
     * On-demand prices per 1M tokens in USD, keyed by inference profile id (rule 7: prices are
     * configuration; reconcile against CUR).
     */
    modelPrices: z.record(
      z.string(),
      z.object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheRead: z.number().nonnegative(),
        cacheWrite: z.number().nonnegative(),
      }),
    ),
    /** Budget per user per calendar month, in USD (MVP v0: user and agent scopes). */
    budgets: z.object({
      userMonthlyUsd: z.number().positive().max(10_000),
      agentMonthlyUsd: z.number().positive().max(100_000),
    }),
    /** Keep data resources on stack deletion. Must be true outside the lab. */
    retainData: z.boolean(),
    /** Object Lock retention for the audit bucket (GOVERNANCE mode in the lab). */
    audit: z.object({
      retentionDays: z.number().int().min(1).max(3650),
      mode: z.enum(["GOVERNANCE", "COMPLIANCE"]),
    }),
    /** MCP packs (D19, D36). */
    packs: z
      .object({
        /**
         * PEM of the ECC P-256 public key that verifies pack signatures, instead of the one
         * that ships with the release (`packs/signing-key.pub`). Lab only (a test key): a
         * customer installation trusts the provider's key and nothing else.
         */
        signingPublicKey: z
          .string()
          .max(1000)
          .regex(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n?$/)
          .optional(),
        /**
         * Network of the pack runtimes (R6): a VPC of its own, without internet gateway or
         * NAT. It only exists when the release ships packs.
         */
        network: z
          .object({
            /**
             * A private `/22`; each Availability Zone takes a `/24` of it. The VPC is not
             * peered with anything, so it only has to be a valid private range.
             */
            cidr: z
              .string()
              .regex(/^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.0\/22$/)
              .refine((cidr) => {
                const octets = cidr.split("/")[0]!.split(".").map(Number);
                return octets.every((octet) => octet <= 255) && octets[2]! % 4 === 0;
              }, "not a /22 network address")
              .default(DEFAULT_PACK_NETWORK.cidr),
            /**
             * Availability Zone **ids** of the pack subnets: at least two, and only zones
             * where AgentCore Runtime supports VPC mode. Ids, not names: a name maps to a
             * different zone in every account.
             */
            availabilityZoneIds: z
              .array(z.enum(AGENTCORE_VPC_ZONE_IDS))
              .min(2)
              .max(AGENTCORE_VPC_ZONE_IDS.length)
              .refine((ids) => new Set(ids).size === ids.length, "duplicate Availability Zone id")
              .default(DEFAULT_PACK_NETWORK.availabilityZoneIds),
          })
          .strict()
          .default(DEFAULT_PACK_NETWORK),
      })
      .strict()
      .default({ network: DEFAULT_PACK_NETWORK }),
    /** Tools Gateway (rule 3). */
    gateway: z
      .object({
        /**
         * MCP sessions on the Gateway (D47): it keeps one session per target for the calls
         * of a turn, so a pack's microVM is reused instead of started for every call. With
         * sessions on, the Gateway answers 400 to any request after `initialize` without the
         * `Mcp-Session-Id` it issued. The AgentCore harness sends it; `false` is the way
         * back for an installation whose MCP client does not.
         */
        mcpSessions: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    /**
     * Access to the member accounts (§4.10, D5): the stack `Mango-<ns>-OrgAccess` and its
     * StackSet. Without it only Core and Payer are synthesized; the broker of Core exists
     * either way, since no stack reads another at deploy time.
     */
    orgAccess: z
      .object({
        /**
         * Where the spoke roles are deployed, now and as accounts join: the root, or OU ids
         * (their child OUs included). Explicit OUs are preferred: with the root, every new
         * account of the organization gets the role without anyone deciding it.
         */
        targets: z
          .array(z.union([rootId, ouId]))
          .min(1)
          .max(50)
          .refine((t) => new Set(t).size === t.length, "duplicate targets")
          .refine(
            (t) => t.length === 1 || t.every((id) => id.startsWith("ou-")),
            "the root already covers every OU: name it alone",
          ),
        /** Accounts inside the targets that must not get the roles. */
        excludedAccountIds: z
          .array(accountId)
          .max(50)
          .refine((a) => new Set(a).size === a.length, "duplicate accounts")
          .default([]),
        /**
         * Account that owns the StackSet: the management account (default) or a delegated
         * administrator of StackSets, which then calls as `DELEGATED_ADMIN`.
         */
        adminAccountId: accountId.optional(),
      })
      .strict()
      .optional(),
    observability: z.object({
      /**
       * CloudWatch Transaction Search (account-wide, required for AgentCore traces). `stack`
       * enables it from this stack; `external` when the account already manages it elsewhere.
       */
      transactionSearch: z.enum(["stack", "external"]),
    }),
    /** Who is notified by the installation's alarms (topic `Mango-<ns>-Alerts`). */
    alerts: z
      .object({
        /**
         * Mailboxes subscribed to the alerts topic. SNS emails each one a confirmation link:
         * nothing is delivered until its owner accepts. Alarm messages carry alarm and metric
         * names, never agent content. Other channels (chat, paging) subscribe to the topic
         * outside the stack.
         */
        emails: z
          .array(z.email().max(254))
          .max(10)
          .refine(
            (emails) => new Set(emails.map((e) => e.toLowerCase())).size === emails.length,
            "duplicate emails",
          )
          .default([]),
      })
      .default({ emails: [] }),
  })
  .superRefine((cfg, ctx) => {
    for (const [id, group] of Object.entries(cfg.accessGroups)) {
      if (group.area !== undefined && !Object.hasOwn(cfg.businessUnits, group.area)) {
        ctx.addIssue({
          code: "custom",
          path: ["accessGroups", id, "area"],
          message: `unknown business unit ${group.area}`,
        });
      }
    }
    // A typo in a user's group would silently create an empty, unregistered Cognito group.
    cfg.users.forEach((user, index) => {
      for (const group of user.groups) {
        const known =
          SYSTEM_GROUPS.includes(group) ||
          BU_GROUP.test(group) ||
          Object.hasOwn(cfg.accessGroups, group);
        if (!known) {
          ctx.addIssue({
            code: "custom",
            path: ["users", index, "groups"],
            message: `unknown group ${group}`,
          });
        }
      }
    });
    // StackSets never reach the management account, and a delegated administrator is a member.
    if (cfg.orgAccess?.excludedAccountIds.includes(cfg.managementAccountId)) {
      ctx.addIssue({
        code: "custom",
        path: ["orgAccess", "excludedAccountIds"],
        message: "the management account is never a StackSet target",
      });
    }
    // Adaptive authentication only exists in Plus: Essentials would silently ignore the action.
    if (cfg.auth.highRiskAction === "BLOCK" && cfg.auth.cognitoPlan !== "plus") {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "highRiskAction"],
        message: "BLOCK requires Cognito Plus",
      });
    }
    // Customer installations never get the lab exceptions (D14, D20, D21).
    if (cfg.installationType !== "customer") return;
    // Open sign-up is only for the company's own domains (D28): never a public mail provider.
    for (const domain of cfg.auth.signUpDomains) {
      if (isPublicMailDomain(domain)) {
        ctx.addIssue({
          code: "custom",
          path: ["auth", "signUpDomains"],
          message: `customer installations cannot allow sign-up from public mail domain ${domain}`,
        });
      }
    }
    const rules: [boolean, (string | number)[], string][] = [
      [
        cfg.packs.signingPublicKey === undefined,
        ["packs", "signingPublicKey"],
        "customer installations only trust the pack signing key of the release",
      ],
      [cfg.mfa === "required", ["mfa"], "customer installations require MFA"],
      [
        cfg.auth.cognitoPlan === "plus",
        ["auth", "cognitoPlan"],
        "customer installations use Cognito Plus",
      ],
      [cfg.retainData, ["retainData"], "customer installations retain data"],
    ];
    for (const [ok, path, message] of rules) {
      if (!ok) ctx.addIssue({ code: "custom", path, message });
    }
  });

export type Installation = z.infer<typeof installationSchema>;

export function loadInstallation(path: string): Installation {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return installationSchema.parse(raw);
}
