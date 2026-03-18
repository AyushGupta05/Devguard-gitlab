import test from "node:test";
import assert from "node:assert/strict";

import { buildInvoiceSummary, sortInvoices } from "../src/billing.js";

test("sortInvoices orders invoice ids by issuedAt", () => {
  const ordered = sortInvoices([
    { id: "b", issuedAt: "2026-03-17T10:00:00.000Z" },
    { id: "a", issuedAt: "2026-03-16T10:00:00.000Z" }
  ]);

  assert.deepEqual(ordered.map((invoice) => invoice.id), ["a", "b"]);
});

test("buildInvoiceSummary uses REDIS_URL", () => {
  process.env.REDIS_URL = "redis://localhost:6379";

  const summary = buildInvoiceSummary([
    { id: "a", issuedAt: "2026-03-16T10:00:00.000Z" }
  ]);

  assert.equal(summary[0].cacheTarget, "redis://localhost:6379");
});
