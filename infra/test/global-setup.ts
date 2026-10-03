import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every synthesis leaves a `cdk.out…` folder (hundreds of MB with the release assets) in the
// system temp folder and nothing removes it: thousands piled up on developer machines. The
// whole run gets one temp root (the workers inherit TMPDIR), removed when the run ends.
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "mango-infra-test-"));
  process.env.TMPDIR = root;
  return () => rmSync(root, { recursive: true, force: true });
}
