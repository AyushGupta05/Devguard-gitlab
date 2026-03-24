import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { projectName } from "../src/index.js";

describe("project baseline", () => {
  it("exports the project name", () => {
    expect(projectName).toContain("DevGuard");
  });

  it("includes the billing-service fixture with the intended landmines", () => {
    const ci = readFileSync("fixtures/billing-service/.gitlab-ci.yml", "utf8");
    const cache = readFileSync("fixtures/billing-service/src/cache.js", "utf8");
    const envExample = readFileSync("fixtures/billing-service/.env.example", "utf8");

    expect(ci).toContain("node:18-alpine");
    expect(cache).toContain("REDIS_URL");
    expect(envExample).not.toContain("REDIS_URL");
  });
});
