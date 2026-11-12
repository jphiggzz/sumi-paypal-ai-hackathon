import { readFile, writeFile } from "node:fs/promises";
import { Output } from "ai";
import { budgetedGenerateText } from "../lib/model-charges";
import { reserveModelCapacityCore } from "../lib/model-capacity-core";
import { setTimeout as delay } from "node:timers/promises";
import { authPool } from "../lib/auth";
import { giftClarificationSystem, giftClarificationSchema, safeGiftClarification } from "../lib/gift-clarification";
const model = process.env.WORKSPACE_CHAT_MODEL || "google/gemini-2.5-flash-lite";
const mode = process.argv[2];
if (!["baseline", "candidate"].includes(mode)) throw Error("Use baseline or candidate");
const fixture = process.env.GIFT_EVAL_CASES || "gift-clarification-cases.json";
if (!/^[a-z0-9-]+\.json$/.test(fixture)) throw Error("Invalid evaluation fixture");
const cases: {id:string;split:string;brief:string;title:string;review:string}[] = JSON.parse(await readFile(new URL(`../evals/${fixture}`, import.meta.url), "utf8"));
const suffix = fixture.includes("comparison") ? `-comparison-${model.replaceAll("/", "-")}` : fixture.includes("holdout") ? "-holdout" : "";
const outputName = process.env.GIFT_EVAL_OUTPUT || `gift-clarification-${mode}${suffix}-2026-11-10.json`;
if (!/^[a-z0-9-]+\.json$/.test(outputName)) throw Error("Invalid evaluation output");
const baselineSystem = (await readFile(new URL("../evals/gift-baseline-system.txt", import.meta.url), "utf8")).trim();
const rows = [];
try {
  let halted = false;
  for (const item of cases) {
    if (halted) { rows.push({ ...item, status: "skipped", error: "Evaluation stopped after access or budget failure" }); continue; }
    const verified = [{ kind: "gift", group: { title: item.title, recipient: null, occasion: null, reserveCents: 1000, budgetCents: 0 }, draft: { version: 2, title: item.title, participantChoice: "solo" }, members: [{ name: "Test user" }], sharedContext: [] }];
    const messages = [{role: "user" as const, content: item.brief}, {role:"assistant" as const,content:"Let’s set up your gift."}, {role:"user" as const,content:item.title}];
    const started = Date.now();
    try {
      // Avoid reserving a slot too far in the future; failed probes must not
      // repeatedly extend the shared schedule and block interactive users.
      while (true) {
        const pending = await authPool.query("SELECT GREATEST(0, EXTRACT(epoch FROM (next_call_at-now()))*1000)::integer AS ms FROM agent_model_capacity WHERE model=$1", [model]);
        const ms = pending.rows[0]?.ms || 0;
        if (ms < 12000) break;
        await delay(Math.min(ms - 10000, 10000));
      }
      const wait = await reserveModelCapacityCore(model);
      if (wait > 30000) throw Error("Capacity busy");
      if (wait > 0) await delay(wait);
      const result = mode === "baseline" ? await budgetedGenerateText({ model, system: baselineSystem + "\nVerified workflow state: " + JSON.stringify(verified), messages, maxOutputTokens: 1500 }) : await budgetedGenerateText({ model, system: giftClarificationSystem, messages, output: Output.object({ schema: giftClarificationSchema }), maxOutputTokens: 700 });
      rows.push({ ...item, output: mode === "baseline" ? result.text : safeGiftClarification(giftClarificationSchema.parse(result.output), `${item.brief}\n${item.title}`), elapsedMs: Date.now() - started, status:"ok" });
    } catch (error) { const message = error instanceof Error ? error.message : "unknown"; rows.push({ ...item, status:"error", error: message, elapsedMs: Date.now() - started }); if (/Free tier users do not have access|MODEL_DAILY_BUDGET_EXHAUSTED|MODEL_NOT_ALLOWED/i.test(message)) halted = true; }
  }
  await writeFile(new URL(`../../research/${outputName}`, import.meta.url), JSON.stringify({ date:"2026-11-10", model, mode, method:"synthetic matched prompts; real guarded Gateway calls; expected criteria authored before outputs; not customer validation", rows }, null, 2) + "\n");
  for (const row of rows) console.log(JSON.stringify({ id: row.id, status: row.status, output: row.output, error: row.error }));
} finally { await authPool.end(); }
