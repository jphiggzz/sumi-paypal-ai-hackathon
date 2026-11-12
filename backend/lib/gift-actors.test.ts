import test from "node:test";
import assert from "node:assert/strict";
import { giftActors } from "./gift-actors";
test("solo perspectives are real AI roles using only the owner's shared member identity", () => {
  const actors = giftActors([{ member_id: "owner" }], [{ id: "owner", simulated: false }], true);
  assert.deepEqual(actors.map((actor) => actor.name), ["Scout", "Muse", "Dot"]);
  assert.ok(actors.every((actor) => actor.memberId === "owner" && actor.perspective));
});
test("groups use only members with shared facts and put real participants first", () => {
  const actors = giftActors([{ member_id: "sim" }, { member_id: "real" }, { member_id: "real" }], [{ id: "sim", simulated: true }, { id: "real", simulated: false }, { id: "silent" }], true);
  assert.deepEqual(actors.map((actor) => actor.memberId), ["real", "sim"]);
  assert.ok(actors.every((actor) => !actor.perspective));
});
