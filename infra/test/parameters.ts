import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { PayerStack } from "../lib/stacks/payer-stack.js";

/**
 * Release templates take the installation's values as stack parameters (D58). Tests check the
 * policies of an installation, so they read a template the way CloudFormation would deploy it:
 * with parameters and pseudo parameters replaced and the string functions evaluated. A
 * condition is given as `Condition:<Name>` with the value `"true"` or `"false"`.
 */
export type Values = Record<string, string | string[]>;

function substitute(text: string, values: Values, local: Record<string, unknown> = {}): unknown {
  let pending = false;
  const out = text.replace(/\$\{([^}!][^}]*)\}/g, (whole, name: string) => {
    const value = local[name] ?? values[name];
    if (typeof value === "string") return value;
    pending = true;
    return whole;
  });
  return pending ? undefined : out;
}

export function instantiate<T>(node: T, values: Values): T {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1) {
      const [key, raw] = entries[0]!;
      if (key === "Ref" && typeof raw === "string" && raw in values) return values[raw];
      if (key === "Fn::Join") {
        const [separator, parts] = walk(raw) as [string, unknown[]];
        const flat = parts.flat();
        if (flat.every((part) => typeof part === "string")) return flat.join(separator);
        return { "Fn::Join": [separator, parts] };
      }
      if (key === "Fn::Split") {
        const [separator, text] = walk(raw) as [string, unknown];
        if (typeof text === "string") return text.split(separator);
      }
      if (key === "Fn::If") {
        const [condition, whenTrue, whenFalse] = raw as [string, unknown, unknown];
        const chosen = values[`Condition:${condition}`];
        if (chosen !== undefined) return walk(chosen === "true" ? whenTrue : whenFalse);
      }
      if (key === "Fn::Sub") {
        const [text, local] = (typeof raw === "string" ? [raw, {}] : walk(raw)) as [string, Record<string, unknown>];
        const done = substitute(text, values, local);
        if (done !== undefined) return done;
      }
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, walk(v)]));
  };
  return walk(node) as T;
}

/** `Mango-<ns>-Payer` as deployed in the management account of an installation. */
export function payerTemplate(installation: {
  namespace: string;
  mangoAccountId: string;
  managementAccountId: string;
  organizationId: string;
}): Template {
  const source = Template.fromStack(new PayerStack(new App(), "Payer")).toJSON() as Record<string, unknown>;
  return Template.fromJSON(
    instantiate(source, {
      Namespace: installation.namespace,
      MangoAccountId: installation.mangoAccountId,
      OrganizationId: installation.organizationId,
      "AWS::AccountId": installation.managementAccountId,
      "AWS::Partition": "aws",
    }),
  );
}
