export * from "./contracts.js";
export * from "./reproguard/reasoning.js";
export * from "./reproguard/scanners.js";

export const projectName = "ReproGuard + ItWorksHere";

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`${projectName} baseline is ready.`);
}
