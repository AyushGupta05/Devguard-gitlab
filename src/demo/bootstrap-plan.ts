import { resolve } from "node:path";

import { buildLocalSetupPlan, formatLocalSetupGuide } from "../itworkshere/bootstrap.js";

const target = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const projectPath = process.argv[3] ?? target;

const plan = buildLocalSetupPlan({
  rootDir: target,
  projectPath
});

process.stdout.write(`${formatLocalSetupGuide(plan)}\n`);
