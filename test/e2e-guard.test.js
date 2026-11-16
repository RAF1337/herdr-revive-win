// The end-to-end harness may stop a herdr-core only when it is provably not
// the person's: their core's pid is known, and the one answering is another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeToStop } from "./e2e/guard.mjs";

test("the e2e harness stops only a core it can tell from the person's", () => {
  assert.equal(safeToStop({ pid: 200 }, 100), true);
  assert.equal(safeToStop({ pid: 100 }, 100), false, "the person's own core");
  assert.equal(safeToStop({ pid: 200 }, null), false, "the person's core unknown: can't tell");
  assert.equal(safeToStop(null, 100), false, "nothing answering");
});
