import test from "node:test";
import assert from "node:assert/strict";
import { giftFollowupAnchor, giftSetupMessageId, type GiftAnchorMessage } from "./gift-checkpoint-anchors";

test("gift checkpoints stay with their original turns as later messages arrive", () => {
  const messages: GiftAnchorMessage[] = [
    { id: "u1", role: "user", content: "Plan a group gift" },
    { id: "a1", role: "assistant", content: "Let’s set up your gift." },
    { id: "u2", role: "user", content: "Dallas trip gift" },
    { id: "a2", role: "assistant", content: "Who is it for?" },
  ];
  assert.equal(giftSetupMessageId(messages), "a1");
  assert.deepEqual(giftFollowupAnchor(messages, "Dallas trip gift"), { answered: false, assistantId: undefined });
  messages.push({ id: "u3", role: "user", content: "My parents" }, { id: "a3", role: "assistant", content: "Thinking…" });
  assert.deepEqual(giftFollowupAnchor(messages, "Dallas trip gift"), { answered: true, assistantId: "a3" });
  messages.push({ id: "u4", role: "user", content: "Dallas trip gift" }, { id: "a4", role: "assistant", content: "Understood" });
  assert.equal(giftSetupMessageId(messages), "a1");
  assert.deepEqual(giftFollowupAnchor(messages, "Dallas trip gift"), { answered: true, assistantId: "a3" });
});
