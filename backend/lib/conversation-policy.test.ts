import assert from "node:assert/strict";
import { test } from "node:test";
import {
  currentApproval,
  followUpInput,
  revisionDecision,
} from "./conversation-policy.ts";

test("accepting new instructions immediately invalidates the earlier approval", () => {
  assert.equal(
    currentApproval(
      { requested_sequence: 3, latest_revision: 3, grants_active: true },
      3,
    ),
    true,
  );
  assert.equal(
    currentApproval(
      { requested_sequence: 4, latest_revision: 3, grants_active: true },
      3,
    ),
    false,
  );
  assert.equal(
    currentApproval(
      { requested_sequence: 4, latest_revision: 4, grants_active: true },
      3,
    ),
    false,
  );
  assert.equal(
    currentApproval(
      { requested_sequence: 4, latest_revision: 4, grants_active: false },
      4,
    ),
    false,
  );
});
test("follow-ups require a durable message identity and bounded text", () => {
  assert.equal(
    followUpInput.safeParse({ messageId: "not-an-id", text: "Revise" }).success,
    false,
  );
  assert.equal(
    followUpInput.safeParse({
      messageId: "0c12d83b-0809-407d-9d11-b9f1bfc88587",
      text: "x".repeat(2001),
    }).success,
    false,
  );
  assert.equal(
    revisionDecision.safeParse({
      action: "decision",
      revision: 0,
      digest: "0".repeat(64),
      decision: "approve",
    }).success,
    false,
  );
});
