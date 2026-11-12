import test from "node:test";
import assert from "node:assert/strict";
import { workspaceConversationUrl } from "./workspace-return";

test("reopening a returned conversation retains the payment marker until handled", () => {
  assert.equal(workspaceConversationUrl("http://localhost:3016/workspace?conversation=chat&contribution=payment&token=order&PayerID=buyer", "chat"), "/workspace?conversation=chat&contribution=payment&token=order&PayerID=buyer");
  assert.equal(workspaceConversationUrl("http://localhost:3016/workspace?conversation=chat&snackInvite=invite", "chat"), "/workspace?conversation=chat&snackInvite=invite");
  assert.equal(workspaceConversationUrl("http://localhost:3016/workspace?conversation=chat&snackPayment=payment&token=order", "chat"), "/workspace?conversation=chat&snackPayment=payment&token=order");
  assert.equal(workspaceConversationUrl("http://localhost:3016/workspace?conversation=chat&cancelled=payment&token=order", "chat"), "/workspace?conversation=chat&cancelled=payment&token=order");
});

test("payment markers do not follow the user to a different conversation", () => {
  assert.equal(workspaceConversationUrl("http://localhost:3016/workspace?conversation=old&contribution=payment&token=order", "new"), "/workspace?conversation=new");
  assert.equal(workspaceConversationUrl("http://localhost:3016/workspace?conversation=chat&token=unrelated", "chat"), "/workspace?conversation=chat");
});
