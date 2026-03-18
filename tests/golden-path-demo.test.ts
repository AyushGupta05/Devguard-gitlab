import { describe, expect, it } from "vitest";

import { buildGoldenPathDemoRun } from "../src/demo/golden-path.js";

describe("golden path demo run", () => {
  it("assembles the full prevention-to-fix story", () => {
    const demoRun = buildGoldenPathDemoRun();

    expect(demoRun.timeline).toHaveLength(6);
    expect(demoRun.predictionMatch.status).toBe("CONFIRMED");
    expect(demoRun.fixBundle.artifacts).toHaveLength(4);
  });
});
