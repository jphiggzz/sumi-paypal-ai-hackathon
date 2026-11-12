import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extractFields, renderComparison } from "../lib/document-policy";
const corpus = JSON.parse(
  await readFile(
    new URL("./fixtures/document-eval-cases.json", import.meta.url),
    "utf8",
  ),
);
const code = await readFile(
  new URL("../lib/document-policy.ts", import.meta.url),
  "utf8",
);
const cases = corpus.cases.map((c: any) => {
  const source = {
    id: "52b993c3-f5cf-45d2-9f7c-cfc91b1447ba",
    version: 1,
    title: c.id,
    content: c.content,
  };
  const actual = extractFields([source], [c.field])[0].facts[0];
  const first = c.content
    .split(/\r?\n/)
    .map((line: string) =>
      /^\s*([A-Za-z][A-Za-z0-9 _-]{0,39})\s*[:=]\s*(.{1,500})\s*$/.exec(line),
    )
    .find(
      (m: RegExpExecArray | null) =>
        m?.[1].trim().toLowerCase() === c.field.toLowerCase(),
    );
  const baseline = first
    ? { status: "found", value: first[2].trim() }
    : { status: "absent", value: null };
  const correct =
    actual.status === c.expected.status && actual.value === c.expected.value;
  const baselineCorrect =
    baseline.status === c.expected.status &&
    baseline.value === c.expected.value;
  const evidenceValid =
    actual.status !== "found" ||
    actual.evidence.some(
      (e) =>
        source.content.split(/\r?\n/)[e.line - 1] === e.quote &&
        e.quote.includes(actual.value!),
    );
  return {
    id: c.id,
    partition: c.partition,
    expected: c.expected,
    actual: { status: actual.status, value: actual.value },
    correct,
    evidenceValid,
    baselineCorrect,
  };
});
function score(partition: string) {
  const rows = cases.filter((c: any) => c.partition === partition);
  const supported = rows.filter((r: any) => r.expected.status === "found");
  return {
    cases: rows.length,
    exactStatusAndValueCorrect: rows.filter((r: any) => r.correct).length,
    baselineCorrect: rows.filter((r: any) => r.baselineCorrect).length,
    supported: supported.length,
    coveredSupported: supported.filter((r: any) => r.actual.status === "found")
      .length,
    correctSupported: supported.filter((r: any) => r.correct).length,
    correctAbstentions: rows.filter(
      (r: any) => r.expected.status !== "found" && r.correct,
    ).length,
    unsupportedAnswers: rows.filter(
      (r: any) => r.expected.status !== "found" && r.actual.status === "found",
    ).length,
  };
}
assert.ok(
  cases.every((r: any) => r.correct && r.evidenceValid),
  "Gold comparison failed",
);
const d = {
  checkedAt: new Date().toISOString(),
  success: true,
  contract: corpus.contract,
  provenance: corpus.provenance,
  evaluationHistory: corpus.evaluationHistory,
  implementationSha256: createHash("sha256").update(code).digest("hex"),
  dev: score("dev"),
  heldout: score("heldout"),
  cases,
  review: {
    humanTimedReviewSeconds: null,
    modelJudgeCalls: 0,
    correctionEffort:
      "Explicit exact gold labels; no model self-grading or timed human study.",
  },
  limitations: [
    "This scores a narrow deterministic extraction contract, not general semantic reasoning or user value.",
    "The baseline is first-occurrence extraction; conflict abstention is a deliberate improvement.",
    "Source content is inert data; the code-looking value is not executed.",
  ],
  inferenceCalls: 0,
};
if (process.env.AGENT_EVIDENCE_PATH)
  await writeFile(
    process.env.AGENT_EVIDENCE_PATH,
    JSON.stringify(d, null, 2) + "\n",
  );
console.log(JSON.stringify(d, null, 2));
