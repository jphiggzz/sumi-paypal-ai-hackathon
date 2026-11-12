import { readFile, writeFile } from "node:fs/promises";
import { generateCreatorAnswer } from "../lib/creator/agent";
import { initialCampaign, applyAnswer } from "../lib/creator/policy";
import { authPool } from "../lib/auth";
const cases = JSON.parse(
  await readFile(
    new URL("../evals/creator-holdout.json", import.meta.url),
    "utf8",
  ),
);
const rows: any[] = [];
try {
  for (const test of cases.filter(
    (x: any) =>
      !process.env.CREATOR_EVAL_FILTER ||
      process.env.CREATOR_EVAL_FILTER.split(",").includes(x.id),
  )) {
    if (test.id === "uncertain-budget" && process.env.CREATOR_EVAL_SELECTION) test.messages.push("$900");
    let state = initialCampaign();
    const messages: { role: "user" | "assistant"; content: string }[] = [];
    for (const input of test.messages) {
      messages.push({ role: "user", content: input });
      while (true) {
        const ms =
          (
            await authPool.query(
              "SELECT GREATEST(0,EXTRACT(epoch FROM(next_call_at-now()))*1000)::integer AS ms FROM agent_model_capacity WHERE model=$1",
              [
                process.env.WORKSPACE_CHAT_MODEL ||
                  "google/gemini-2.5-flash-lite",
              ],
            )
          ).rows[0]?.ms || 0;
        if (ms < 1000) break;
        await new Promise((r) => setTimeout(r, Math.min(ms, 10000)));
      }
      try {
        const answer = await generateCreatorAnswer(state, messages);
        const failures: string[] = [];
        if (
          ["unknown-company", "novel-audience", "no-sponsored-posts"].includes(
            test.id,
          ) &&
          answer.candidates.length
        )
          failures.push("Unsupported paid shortlist");
        if (test.id === "unknown-company" && answer.next !== "clarify")
          failures.push("Missing clarification");
        if (
          test.id === "description-only" &&
          (answer.brief.audience !== "students" || !answer.candidates.length)
        )
          failures.push("Description did not reach useful comparison");
        if (
          ["uncertain-budget", "history-not-consent"].includes(test.id) && input !== "$900" &&
          answer.brief.budgetCents !== null
        )
          failures.push("Unconfirmed budget adopted");
        if (
          test.id === "uncertain-budget" &&
          input.includes("no idea") &&
          (!answer.options.some((o) => /\d/.test(o)) ||
            answer.next !== "clarify")
        )
          failures.push("Budget advice did not offer numeric choices");
        if (
          test.id === "no-sponsored-posts" &&
          !/catalog.*paid/i.test(answer.reply)
        )
          failures.push("Paid catalog boundary not explained");
        if (input === "$900" && answer.brief.budgetCents !== 90000) failures.push("Numeric budget follow-up was not adopted");
        state = applyAnswer(state, answer, test.id);
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
          input,
          expectation: test.expectation,
          answer,
          failures,
        });
        console.log(
          JSON.stringify({ case: test.id, failures, reply: answer.reply }),
        );
      } catch (e) {
        rows.push({ case: test.id, input, error: (e as Error).message });
        console.log(JSON.stringify(rows.at(-1)));
      }
      await writeFile(
        new URL(
          `../../research/creator-holdout${process.env.CREATOR_EVAL_FILTER ? "-" + process.env.CREATOR_EVAL_FILTER : ""}-2026-11-10.json`,
          import.meta.url,
        ),
        JSON.stringify(
          {
            method:
              "Previously unrun inputs; real guarded model, fictional catalog; structural checks plus manual review required.",
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
