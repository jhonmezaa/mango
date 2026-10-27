import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NestedStack, Stack, Stage } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";

/** The stacks nested in `stack` (D99), at any depth. */
export function nestedStacks(stack: Stack): NestedStack[] {
  return stack.node.findAll().filter((c): c is NestedStack => c instanceof NestedStack);
}

/**
 * The template of a stack nested in `stack`, from the assembly already synthesized for it:
 * `Template.fromStack` synthesizes the whole app again on every call.
 */
export function nestedTemplate(nested: NestedStack): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const assembly = Stage.of(nested)!.synth();
  return JSON.parse(readFileSync(join(assembly.directory, nested.templateFile), "utf8"));
}

/** `value` with every `{ Ref: <parameter> }` of `parameters` replaced by what the parent passes. */
function substitute(value: unknown, parameters: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => substitute(item, parameters));
  if (value === null || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const keys = Object.keys(node);
  if (keys.length === 1 && keys[0] === "Ref" && typeof node.Ref === "string" && node.Ref in parameters) {
    return parameters[node.Ref];
  }
  return Object.fromEntries(keys.map((key) => [key, substitute(node[key], parameters)]));
}

/**
 * What an installation of `stack` creates: its template with the resources of the stacks nested
 * in it (D99), for the tests that look for a resource wherever it lives. A nested resource names
 * Core's resources through parameters of its template; here each parameter is replaced by the
 * value Core passes, so it reads as if it were in Core.
 */
export function fromCore(stack: Stack): Template {
  const template = Template.fromStack(stack).toJSON() as { Resources: Record<string, { Properties?: any }> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const resources: Record<string, unknown> = { ...template.Resources };
  for (const nested of nestedStacks(stack)) {
    const parent = nested.nestedStackParent!;
    const resourceId = parent.resolve(parent.getLogicalId(nested.nestedStackResource! as never)) as string;
    const parentTemplate = parent === stack ? template : (nestedTemplate(parent as NestedStack) as typeof template);
    const parameters = (parentTemplate.Resources[resourceId]?.Properties?.Parameters ?? {}) as Record<string, unknown>;
    for (const [id, resource] of Object.entries(nestedTemplate(nested).Resources ?? {})) {
      if (id in resources) throw new Error(`logical id ${id} is in Core and in ${nested.node.id}`);
      resources[id] = substitute(resource, parameters);
    }
  }
  return Template.fromJSON({ ...template, Resources: resources });
}
