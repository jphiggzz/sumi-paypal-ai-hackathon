import test from "node:test";
import assert from "node:assert/strict";
import { groundedSnackBrief, snackClarificationSchema, avoidRepeatedSnackQuestion } from "./snack-clarification";
const blank = { question:"How many people?", people:null, budget:null, days:null, servings:null, reserve:null };
test("snack draft only accepts quoted numeric facts from user messages", () => {
  const output=snackClarificationSchema.parse({ ...blank, people:{value:12,evidence:"12 people"}, budget:{value:200,evidence:"$200 per month"}, reserve:{value:50,evidence:"$50"} });
  assert.deepEqual(groundedSnackBrief(output,["12 people and $200 per month"]),{people:{value:12,evidence:"12 people"},budget:{value:200,evidence:"$200 per month"}});
});
test("ranges and non-dollar budgets do not become proposals", () => {
  const output=snackClarificationSchema.parse({ ...blank, people:{value:12,evidence:"10-12 people"}, budget:{value:200,evidence:"200 people"}, days:{value:5,evidence:"4 office days"} });
  assert.deepEqual(groundedSnackBrief(output,["10-12 people, 200 people, 4 office days"]),{});
});
test("a rough headcount remains explicitly marked as an estimate", () => {
  const output=snackClarificationSchema.parse({...blank,people:{value:12,evidence:"12 people"}});
  assert.deepEqual(groundedSnackBrief(output,["around 12 people"]).people,{value:12,evidence:"12 people",approximate:true});
});

test("an explicit answer to a people question can update the count, but old evidence cannot overwrite it", () => {
  const prior={people:{value:12,evidence:"12 people"}};
  const output=snackClarificationSchema.parse({...blank,people:{value:15,evidence:"15"}});
  assert.equal(groundedSnackBrief(output,["15"],prior,"How many people are in the office?").people?.value,15);
  assert.equal(groundedSnackBrief(output,["15"],prior,"What is the budget?").people?.value,12);
  const stale=snackClarificationSchema.parse({...blank,people:{value:12,evidence:"12 people"}});
  assert.equal(groundedSnackBrief(stale,["12 people","Actually 15"],{people:{value:15,evidence:"15 people"}}).people?.value,15);
});
test("explicit withdrawn numeric facts are removed until re-confirmed", () => {
  const output=snackClarificationSchema.parse({...blank,clear:[{field:"budget",evidence:"not $200"}]});
  assert.deepEqual(groundedSnackBrief(output,["It's not $200 anymore"],{budget:{value:200,evidence:"$200"}}),{});
});

test("food preferences and office exclusions require literal user evidence", () => {
  const value=snackClarificationSchema.parse({...blank,likes:[{term:"pretzels",evidence:"we like pretzels"}],avoid:[{term:"peanuts",evidence:"avoid peanuts"}],dietary:[{term:"vegan",evidence:"some are vegan"}]});
  const brief=groundedSnackBrief(value,["we like pretzels; some are vegan; avoid peanuts"]);
  assert.deepEqual(brief.likes,["pretzels"]);assert.deepEqual(brief.avoid,["peanuts"]);assert.deepEqual(brief.dietary,["vegan"]);
  assert.deepEqual(groundedSnackBrief(value,["we like pretzels"]).avoid,undefined);
});

test("later dietary details do not erase earlier exclusions", () => {
  const value=snackClarificationSchema.parse({...blank,dietary:[{term:"vegan",evidence:"vegan"}],avoid:[{term:"sesame",evidence:"avoid sesame"}]});
  const brief=groundedSnackBrief(value,["vegan and avoid sesame"],{avoid:["peanuts"]});
  assert.deepEqual(brief.avoid,["peanuts","sesame"]);
});

test("repeated office-day questions are replaced with a useful open preference question", () => {
  assert.equal(avoidRepeatedSnackQuestion("How many office days should I plan for?", "How many days per month is the office open?"), "Are there any other snacks your team likes or wants to avoid?");
  assert.equal(avoidRepeatedSnackQuestion("What snacks does the team like?", "How many people?"), "What snacks does the team like?");
});
