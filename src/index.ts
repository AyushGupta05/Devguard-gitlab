export * from "./contracts.js";
export * from "./demo/golden-path.js";
export * from "./itworkshere/bootstrap.js";
export * from "./itworkshere/analysis.js";
export * from "./itworkshere/failure-intake.js";
export * from "./itworkshere/response.js";
export * from "./reproguard/local-run.js";
export * from "./reproguard/reasoning.js";
export * from "./reproguard/scanners.js";

export const projectName = "ReproGuard + ItWorksHere";

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`${projectName} baseline is ready.`);
}
