import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { MemberStack } from "../lib/stacks/member-stack.js";
import { OrgAccessStack } from "../lib/stacks/org-access-stack.js";
import { PackNetworkStack } from "../lib/stacks/pack-network-stack.js";
import { PayerStack } from "../lib/stacks/payer-stack.js";

/* No template may have a dependency cycle between its resources. CloudFormation refuses it
 * ("Circular dependency between resources") and neither `cdk synth` nor cdk-nag, cfn-guard or
 * Checkov say so: on 2026-10-21 Core went through all of them and the CI with one (the access
 * logs policy, the documents bucket of the knowledge bases, the distribution and the load
 * balancer). The tests synthesize with the feature flags of `cdk.json`. The graph is what CloudFormation orders by: `Ref`, `Fn::GetAtt`, the names inside
 * `Fn::Sub` and `DependsOn`. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The resources each resource of a template waits for. */
export function dependencies(template: Json): Map<string, Set<string>> {
  const resources: Record<string, Json> = template.Resources ?? {};
  const names = new Set(Object.keys(resources));
  const graph = new Map<string, Set<string>>();
  const visit = (node: Json, out: Set<string>): void => {
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, out));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "Ref" && typeof value === "string") {
        if (names.has(value)) out.add(value);
      } else if (key === "Fn::GetAtt") {
        const target = Array.isArray(value) ? value[0] : String(value).split(".")[0];
        if (typeof target === "string" && names.has(target)) out.add(target);
        else visit(value, out);
      } else if (key === "Fn::Sub") {
        const [text, variables] = Array.isArray(value) ? value : [value, {}];
        const local = new Set(Object.keys(variables ?? {}));
        for (const match of String(text).matchAll(/\$\{([^}!.]+)(?:\.[^}]*)?\}/g)) {
          const name = match[1]!;
          if (!local.has(name) && names.has(name)) out.add(name);
        }
        visit(variables, out);
      } else {
        visit(value, out);
      }
    }
  };
  for (const [name, resource] of Object.entries(resources)) {
    const out = new Set<string>();
    const { DependsOn: dependsOn, ...rest } = resource;
    visit(rest, out);
    for (const target of [dependsOn ?? []].flat()) if (names.has(target)) out.add(target);
    out.delete(name);
    graph.set(name, out);
  }
  return graph;
}

/** One cycle of the graph, as the names along it (the first repeated at the end), or none. */
export function findCycle(graph: Map<string, Set<string>>): string[] | undefined {
  // Kahn's topological order: whatever cannot be ordered is in or behind a cycle.
  const pending = new Map([...graph].map(([name, deps]) => [name, deps.size]));
  const dependents = new Map<string, string[]>();
  for (const [name, deps] of graph) for (const dep of deps) dependents.set(dep, [...(dependents.get(dep) ?? []), name]);
  const ready = [...pending].filter(([, n]) => n === 0).map(([name]) => name);
  while (ready.length) {
    const name = ready.pop()!;
    pending.delete(name);
    for (const next of dependents.get(name) ?? []) {
      const left = pending.get(next)! - 1;
      pending.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  if (pending.size === 0) return undefined;
  // Walk the unordered part until a name repeats: that is a cycle.
  let current = [...pending.keys()][0]!;
  const path: string[] = [];
  const seen = new Map<string, number>();
  while (!seen.has(current)) {
    seen.set(current, path.length);
    path.push(current);
    current = [...graph.get(current)!].find((dep) => pending.has(dep))!;
  }
  return [...path.slice(seen.get(current)), current];
}

// The context of `cdk.json`, as `cdk synth` has it: its feature flags change the templates. A
// bare `new App()` misses `@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy`, and without it the
// cycle of 2026-10-21 does not even exist.
const cdkJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../cdk.json"), "utf8"));
const context = { ...cdkJson.context, packsDir: mkdtempSync(join(tmpdir(), "mango-no-packs-")) };
const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const stacks: [string, () => Stack][] = [
  // As `bin/mango.ts` builds them for a release (D58), and Core for one installation too.
  ["Core (release)", () => new CoreStack(new App({ context }), "Core", { env: { region: "us-east-1" } })],
  [
    "Core (installation)",
    () =>
      new CoreStack(new App({ context }), "Core", {
        installation: cfg,
        env: { account: cfg.mangoAccountId, region: cfg.region },
      }),
  ],
  ["PackNetwork", () => new PackNetworkStack(new App({ context }), "PackNetwork", { env: { region: "us-east-1" } })],
  ["Payer", () => new PayerStack(new App({ context }), "Payer")],
  ["Member", () => new MemberStack(new App({ context }), "Member")],
  ["OrgAccess", () => new OrgAccessStack(new App({ context }), "OrgAccess")],
];

describe("dependency cycles", () => {
  it("finds the cycles CloudFormation refuses, through every kind of reference", () => {
    const cyclic = {
      Resources: {
        Policy: { Type: "P", Properties: { Arn: { "Fn::GetAtt": ["Bucket", "Arn"] } } },
        Bucket: { Type: "B", Properties: { Cors: { "Fn::Sub": "https://${Distribution.DomainName}" } } },
        Distribution: { Type: "D", Properties: { Origin: { Ref: "Alb" } } },
        Alb: { Type: "A", Properties: {}, DependsOn: ["Policy"] },
        Other: { Type: "O", Properties: { Name: { Ref: "AWS::StackName" } } },
      },
    };
    expect(findCycle(dependencies(cyclic))).toEqual(["Policy", "Bucket", "Distribution", "Alb", "Policy"]);
    const ordered = { Resources: { ...cyclic.Resources, Alb: { Type: "A", Properties: {} } } };
    expect(findCycle(dependencies(ordered))).toBeUndefined();
    // A variable of `Fn::Sub` that shadows a resource is not that resource.
    const shadowed = {
      Resources: {
        A: { Type: "A", Properties: { V: { "Fn::Sub": ["${B}", { B: "literal" }] } } },
        B: { Type: "B", Properties: { V: { Ref: "A" } } },
      },
    };
    expect(findCycle(dependencies(shadowed))).toBeUndefined();
  });

  // A whole Core takes about 11 s to synthesize alone; with the rest of the suite running, more.
  it.each(stacks)(
    "%s has none",
    (_name, build) => {
      const graph = dependencies(Template.fromStack(build()).toJSON());
      expect(graph.size).toBeGreaterThan(0);
      expect(findCycle(graph)).toBeUndefined();
    },
    120_000,
  );
});
