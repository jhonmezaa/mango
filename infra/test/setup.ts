import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MANGO_PACKS_DIR ??= mkdtempSync(join(tmpdir(), "mango-test-packs-"));
