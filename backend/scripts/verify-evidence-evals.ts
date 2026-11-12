import { reserveModelCall } from "../lib/model-capacity";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { generateText, Output } from "ai";
import {
  extractionOutput,
  validateExtraction,
  EXTRACTION_SYSTEM,
} from "../lib/evidence-policy";
import { extractFields } from "../lib/document-policy";
import { reserveModelBudget } from "../lib/model-budget";
import { authPool } from "../lib/auth";
const corpus = JSON.parse(
    await readFile(
      new URL("./fixtures/evidence-ai-eval-cases.json", import.meta.url),
      "utf8",
    ),
  ),
  results: any[] = [];
try {
  for (const c of corpus.cases) {
    const waitMs = await reserveModelCall("amazon/nova-micro");
    if (waitMs > 0) await delay(waitMs);
    await reserveModelBudget("amazon/nova-micro");
    const started = Date.now();
    let actual: any, usage: any, error: string | undefined;
    try {
      const result = await generateText({
        model: "amazon/nova-micro",
        maxRetries: 0,
        maxOutputTokens: 2500,
        abortSignal: AbortSignal.timeout(35000),
        output: Output.object({ schema: extractionOutput }),
        system: EXTRACTION_SYSTEM,
        prompt: JSON.stringify({ fields: [c.field], document: c.content }),
      });
      actual = validateExtraction(c.content, [c.field], result.output)[0];
      usage = {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        estimatedUsd:
          ((result.usage.inputTokens ?? 0) * 0.035 +
            (result.usage.outputTokens ?? 0) * 0.14) /
          1e6,
      };
    } catch (e) {
      error = String(e).slice(0, 100);
      actual = { status: "error", value: null, evidence: [] };
    }
    const baseline = extractFields(
      [{ id: "fixture", version: 1, title: c.id, content: c.content }],
      [c.field],
    )[0].facts[0];
    results.push({
      ...c,
      actual,
      correct:
        actual.status === c.expected.status &&
        actual.value === c.expected.value,
      baselineCorrect:
        baseline.status === c.expected.status &&
        baseline.value === c.expected.value,
      evidenceValid:
        actual.status !== "found" ||
        actual.evidence.every(
          (e: any) =>
            c.content.slice(e.start, e.end) === e.quote &&
            e.quote.includes(actual.value),
        ),
      latencyMs: Date.now() - started,
      usage,
      error,
    });
    console.log(c.id, results.at(-1).correct ? "correct" : "MISS");
  }
  const score = (partition: string) => {
    const rows = results.filter((r) => r.partition === partition),
      found = rows.filter((r) => r.actual.status === "found"),
      supported = rows.filter((r) => r.expected.status === "found");
    return {
      cases: rows.length,
      exactCorrect: rows.filter((r) => r.correct).length,
      baselineCorrect: rows.filter((r) => r.baselineCorrect).length,
      supported: supported.length,
      coveredSupported: supported.filter((r) => r.actual.status === "found")
        .length,
      correctSupported: supported.filter((r) => r.correct).length,
      returnedFound: found.length,
      correctReturnedFound: found.filter((r) => r.correct).length,
      incorrectAbstentions: supported.filter((r) => r.actual.status !== "found")
        .length,
      evidenceValid: rows.filter((r) => r.evidenceValid).length,
    };
  };
  const out = {
    status: "completed",
    model: "amazon/nova-micro",
    recordedAt: new Date().toISOString(),
    labelOrigin: corpus.labelOrigin,
    promptSha256: createHash("sha256").update(EXTRACTION_SYSTEM).digest("hex"),
    development: score("development"),
    heldout: score("heldout"),
    estimatedInferenceUsd: results.reduce(
      (n, r) => n + (r.usage?.estimatedUsd ?? 0),
      0,
    ),
    humanReview: {
      correctionCandidates: results.filter((r) => !r.correct).map((r) => r.id),
      measuredCorrectionTimeSeconds: null,
      note: "No timed human review study. Candidates count exact mismatches, not measured reviewer effort.",
    },
    results,
  };
  await writeFile(
    "../research/evidence-ai-evals-2026-11-09.json",
    JSON.stringify(out, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      development: out.development,
      heldout: out.heldout,
      estimatedInferenceUsd: out.estimatedInferenceUsd,
    }),
  );
} finally {
  await authPool.end();
}
