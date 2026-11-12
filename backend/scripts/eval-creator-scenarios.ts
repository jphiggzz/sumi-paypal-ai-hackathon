import { readFile, writeFile } from "node:fs/promises";
import { generateCreatorAnswer } from "../lib/creator/agent";
import {
  applyAnswer,
  initialCampaign,
  type Campaign,
} from "../lib/creator/policy";
import { creators } from "../lib/creator/catalog";
import { authPool } from "../lib/auth";
const cases = JSON.parse(
  await readFile(
    new URL("../evals/creator-scenarios.json", import.meta.url),
    "utf8",
  ),
);
const rows: any[] = [];
const filter = process.env.CREATOR_EVAL_FILTER;
try {
  for (const test of cases.filter(
    (x: any) => !filter || filter.split(",").includes(x.id),
  )) {
    let state: Campaign = initialCampaign();
    const messages: { role: "user" | "assistant"; content: string }[] = [];
    const steps = [
      test.initial,
      test.followup,
      "Why did you choose those creators?",
      "Actually our total budget is only $100.",
      "Make the budget $2,000 instead. Find suitable creators.",
      `Exclude ${creators.find((c) => c.id === test.expected)!.name}. Who else fits?`,
    ];
    for (
      let i = 0;
      i < (process.env.CREATOR_EVAL_SMOKE ? 2 : steps.length);
      i++
    ) {
      messages.push({ role: "user", content: steps[i] });
      const started = Date.now();
      try {
        while (true) {
          const pending =
            (
              await authPool.query(
                "SELECT GREATEST(0,EXTRACT(epoch FROM(next_call_at-now()))*1000)::integer AS ms FROM agent_model_capacity WHERE model=$1",
                [
                  process.env.WORKSPACE_CHAT_MODEL ||
                    "google/gemini-2.5-flash-lite",
                ],
              )
            ).rows[0]?.ms || 0;
          if (pending < 1000) break;
          await new Promise((r) => setTimeout(r, Math.min(pending, 10000)));
        }
        const answer = await generateCreatorAnswer(state, messages);
        const failures: string[] = [];
        if (i === 0 && test.id !== "chatedu" && answer.next !== "clarify")
          failures.push("Vague audience should be clarified");
        if (
          i === 1 &&
          (answer.brief.audience !== test.audience ||
            !answer.candidates.some((c) => c.id === test.expected))
        )
          failures.push(
            "Expected relevant creator missing after audience follow-up",
          );
        if (
          i === 2 &&
          (answer.next !== "explain" || answer.brief.budgetCents !== null)
        )
          failures.push("Explanation should preserve unknown budget");
        if (
          i === 3 &&
          (answer.brief.budgetCents !== 10000 || answer.candidates.length !== 0)
        )
          failures.push("Impossible budget must return no candidates");
        if (
          i === 4 &&
          (answer.brief.budgetCents !== 200000 ||
            !answer.candidates.some((c) => c.id === test.expected))
        )
          failures.push("Budget correction should restore relevant candidates");
        if (i === 5 && answer.candidates.some((c) => c.id === test.expected))
          failures.push("Excluded creator returned");
        state = applyAnswer(state, answer, `${test.id}-${i}`);
        messages.push({
          role: "assistant",
          content:
            answer.reply +
            (answer.options.length
              ? `\n[Options presented to the user: ${JSON.stringify(answer.options)}]`
              : ""),
        });
        rows.push({
          case: test.id,
          step: i,
          input: steps[i],
          answer,
          failures,
          elapsedMs: Date.now() - started,
        });
        console.log(
          JSON.stringify({
            case: test.id,
            step: i,
            failures,
            reply: answer.reply,
            candidates: answer.candidates.map((c) => c.id),
          }),
        );
      } catch (e) {
        rows.push({
          case: test.id,
          step: i,
          error: (e as Error).message,
          candidateAnswer: (e as any).candidateAnswer,
        });
        console.log(JSON.stringify(rows.at(-1)));
        if (/BUDGET|PRICE|NOT_ALLOWED/.test((e as Error).message)) throw e;
      }
      await writeFile(
        new URL(
          `../../research/creator-scenarios-${filter || (process.env.CREATOR_EVAL_SMOKE ? "sponsor-smoke" : "all")}-2026-11-10.json`,
          import.meta.url,
        ),
        JSON.stringify(
          {
            method:
              "Real budget-guarded model calls. Fictional catalog. Expectations authored before runs; deterministic checks, not user-value validation.",
            rows,
          },
          null,
          2,
        ) + "\n",
      );
    }
  }
} finally {
  await authPool.end();
}
if (rows.some((r) => r.error || r.failures?.length)) process.exitCode = 1;
