import test from "node:test";
import assert from "node:assert/strict";
import { hasUnlimitedTestingAccess } from "./testing-access";

test("unlimited testing access requires an exact configured account ID", () => {
  assert.equal(hasUnlimitedTestingAccess("owner-a", "owner-a, owner-b"), true);
  assert.equal(hasUnlimitedTestingAccess("owner", "owner-a, owner-b"), false);
  assert.equal(hasUnlimitedTestingAccess("owner-a", ""), false);
});
