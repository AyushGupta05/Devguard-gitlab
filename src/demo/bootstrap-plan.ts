import { resolve } from "node:path";

import { buildLocalSetupPlan, formatLocalSetupGuide } from "../itworkshere/bootstrap.js";

const targetRoot = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const projectPath = process.argv[3] ?? targetRoot;

const plan = buildLocalSetupPlan({
  rootDir: targetRoot,
  projectPath
});

console.log(formatLocalSetupGuide(plan));
