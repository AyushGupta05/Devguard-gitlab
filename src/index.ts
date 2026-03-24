// Primary API — scan() prevents, diagnose() recovers
export * from "./devguard.js";

// Contracts and schemas
export * from "./contracts.js";

// Internal modules (for custom pipelines and testing)
export * from "./itworkshere/analysis.js";
export * from "./itworkshere/failure-intake.js";
export * from "./itworkshere/response.js";
export * from "./reproguard/reasoning.js";
export * from "./reproguard/scanners.js";

export const projectName = "DevGuard";
