// The one dependency rule this package structurally enforces: src/tools
// (plain Interchange tools — installable and grantable with zero hub,
// mounting, extension or webhook machinery) may never import from
// src/ingress (the webhook extension that depends on tools). The reverse is
// fine and expected. See ARCHITECTURE.md.
import { execSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;

try {
  const hits = execSync(
    `grep -rnE "(from|require\\()\\s*['\\"][^'\\"]*ingress" src/tools --include='*.ts' || true`,
    { cwd: root, encoding: "utf8" },
  ).trim();
  if (hits) {
    console.error(`check-deps: src/tools references src/ingress:\n${hits}`);
    process.exit(1);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
console.log("check-deps: clean — src/tools has no ingress imports.");
