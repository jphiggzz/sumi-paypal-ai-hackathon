import test from "node:test";
import assert from "node:assert/strict";
import { requireRequestedEvidence } from "./creator/evidence";
import { emptyBrief } from "./creator/policy";
import { creators } from "./creator/catalog";

test("API-testing requests cite testing evidence and drop unrelated profiles", () => {
  const candidates = [
    { id: "api-educator", reason: "API testing", evidenceIndexes: [0] },
    { id: "developer-sample-12", reason: "API testing", evidenceIndexes: [0] },
    { id: "deployment-builder", reason: "Deployment", evidenceIndexes: [0] },
  ];
  const brief = { ...emptyBrief, brand: "Postman", audience: "developers" as const, topics: ["API testing"] };
  const result = requireRequestedEvidence(brief, candidates, creators);
  assert.deepEqual(result.map((candidate) => [candidate.id, candidate.evidenceIndexes]), [
    ["api-educator", [1]],
    ["developer-sample-12", [0]],
  ]);
  assert.deepEqual(requireRequestedEvidence({ ...brief, topics: ["deployment"] }, candidates, creators), candidates);
});

test("product search and SDK requests require and cite the requested evidence", () => {
  const candidates = ["search-engineer", "developer-sample-01", "developer-sample-14"].map(id => ({ id, reason: "Unverified claim", evidenceIndexes: [0] }));
  const search = { ...emptyBrief, audience: "developers" as const, audienceDetail: "Developers building ecommerce product search and shopping agents" };
  const found = requireRequestedEvidence(search, candidates, creators);
  assert.deepEqual(found.map(c => c.id), ["search-engineer", "developer-sample-14"]);
  assert.ok(found.every(c => c.reason !== "Unverified claim"));
  const sdk = { ...emptyBrief, audience: "developers" as const, audienceDetail: "API developers who need generated SDKs" };
  const result = requireRequestedEvidence(sdk, [{ id: "developer-sample-07", reason: "SDK integration", evidenceIndexes: [1] }, { id: "api-educator", reason: "SDK integration", evidenceIndexes: [0] }], creators);
  assert.deepEqual(result.map(c => [c.id, c.evidenceIndexes]), [["api-educator", [1]]]);
});

test("an explicitly requested audience niche requires matching sample evidence", () => {
  const candidates = ["maya-chen", "student-sample-02", "sam-rivera"].map(id => ({ id, reason: "Student audience", evidenceIndexes: [0] }));
  const brief = { ...emptyBrief, audience: "students" as const, audienceDetail: "nursing students" };
  assert.deepEqual(requireRequestedEvidence(brief, candidates, creators, true).map(c => c.id), ["student-sample-02"]);
  assert.deepEqual(requireRequestedEvidence(brief, candidates, creators, false), candidates);
  const detailed = { ...brief, audience: "developers" as const, audienceDetail: "Frontend developers building scheduling interfaces" };
  const educator = [{ id: "react-educator", reason: "Scheduling", evidenceIndexes: [0] }];
  assert.deepEqual(requireRequestedEvidence(detailed, educator, creators, true), educator);
});
