import { describe, expect, it } from "vitest";

import { projectName } from "../src/index.js";

describe("project baseline", () => {
  it("exports the project name", () => {
    expect(projectName).toContain("ReproGuard");
  });
});
