import { Installation } from "./schema.js";

/** Cognito groups Mango always creates. Only IaC or an administrator changes membership. */
export const ROLE_GROUPS = ["finops-central", "bu-lead"] as const;
export const ADMIN_GROUP = "mango-admin";
/** Members may create agent drafts (`CreateAgent`); publishing still needs an admin (D18). */
export const AGENT_CREATOR_GROUP = "mango-agent-creator";
export const SYSTEM_GROUPS: readonly string[] = [...ROLE_GROUPS, ADMIN_GROUP, AGENT_CREATOR_GROUP];

/** Type of an access group (D26). Only `central` groups may use account-data tools. */
export type AccessGroupType = "central" | "area" | "general";

export interface AccessGroup {
  readonly id: string;
  readonly type: AccessGroupType;
  /** Area groups only: the business unit whose OUs its members see. */
  readonly area?: string;
  readonly description: string;
}

/**
 * Initial registry of access groups (Settings table, partition `GROUPS`), sorted by id: the
 * FinOps groups Mango already uses, one area group per business unit and the ones declared in
 * `accessGroups`. `mango-admin` and `mango-agent-creator` grant permissions, not access to
 * agents, so they are not part of it.
 */
export function accessGroupRegistry(cfg: Installation): AccessGroup[] {
  const groups: AccessGroup[] = [
    { id: "finops-central", type: "central", description: "FinOps central" },
    { id: "bu-lead", type: "general", description: "Líderes de área" },
    ...Object.keys(cfg.businessUnits).map(
      (unit): AccessGroup => ({
        id: `bu-${unit}`,
        type: "area",
        area: unit,
        description: `Líderes de ${unit}`,
      }),
    ),
    ...Object.entries(cfg.accessGroups).map(
      ([id, group]): AccessGroup => ({
        id,
        type: group.type,
        ...(group.area ? { area: group.area } : {}),
        description: group.description ?? "",
      }),
    ),
  ];
  return groups.sort((a, b) => a.id.localeCompare(b.id));
}

/** Every Cognito group of the installation: system groups, the registry and the users' own. */
export function cognitoGroupNames(cfg: Installation): string[] {
  const names = new Set<string>(SYSTEM_GROUPS);
  for (const group of accessGroupRegistry(cfg)) names.add(group.id);
  for (const user of cfg.users) for (const g of user.groups) names.add(g);
  return [...names];
}
