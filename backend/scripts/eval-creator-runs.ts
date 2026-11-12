import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { creators } from "../lib/creator/catalog";
const base = process.env.WORKSPACE_VERIFY_URL || "http://localhost:3016";
if (!/^http:\/\/localhost:\d+$/.test(base))
  throw Error("Local verification only");
const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: base,
  database: authPool,
  user: { modelName: "auth_users" },
  session: { modelName: "auth_sessions" },
  account: { modelName: "auth_accounts" },
  verification: { modelName: "auth_verifications" },
  emailAndPassword: { enabled: true },
});
const cases = JSON.parse(
  await readFile(
    new URL("../evals/creator-scenarios.json", import.meta.url),
    "utf8",
  ),
);
const rows: any[] = [];
let userId = "";
try {
  const signup = await auth.api.signUpEmail({
    body: {
      email: `creator-runs-${randomUUID()}@example.invalid`,
      name: "Creator verification",
      password: randomUUID() + randomUUID(),
    },
    asResponse: true,
  });
  assert.equal(signup.status, 200);
  userId = (await signup.json()).user.id;
  const cookie = signup.headers
    .getSetCookie()
    .filter((c) => c.split("=")[0].includes("session_token"))
    .map((c) => c.split(";")[0])
    .join("; ");
  const headers = {
    Origin: base,
    "Content-Type": "application/json",
    "x-demo-code": process.env.SUME_DEMO_CODE || "",
    Cookie: cookie,
  };
  for (const test of cases.filter(
    (t: any) =>
      !process.env.CREATOR_EVAL_FILTER ||
      process.env.CREATOR_EVAL_FILTER.split(",").includes(t.id),
  )) {
    const cid = randomUUID();
    let revision = 0;
    let lastMessageId = "";
    const trace: unknown[] = [];
    const snapshots = new Map<string, string>();
    try {
      const create = await fetch(base + "/api/workspace-chat", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "create", id: cid, mode: "creators" }),
      });
      assert.equal(create.status, 200);
      if (process.env.CREATOR_EVAL_KEEP)
        await writeFile(
          "/tmp/sume-creator-run-browser.json",
          JSON.stringify({
            base,
            cookie,
            code: process.env.SUME_DEMO_CODE || "",
            conversationId: cid,
            userId,
          }),
          { mode: 0o600 },
        );
      const inputs = process.env.CREATOR_EVAL_DIRECT
        ? [`${test.initial} ${test.followup}`]
        : [
            test.initial,
            process.env.CREATOR_EVAL_BUDGET && test.id === "paypal"
              ? `${test.followup} Total budget is $2,000.`
              : test.followup,
            ...(process.env.CREATOR_EVAL_HISTORY && test.id === "chatedu"
              ? ["Exclude Maya Chen and find another creator."]
              : []),
          ];
      for (const text of inputs) {
        lastMessageId = randomUUID();
        const response = await fetch(base + "/api/workspace-chat/stream", {
          method: "POST",
          headers,
          body: JSON.stringify({
            conversationId: cid,
            requestId: lastMessageId,
            messageId: randomUUID(),
            text,
            mode: "creators",
            revision,
          }),
        });
        if (response.status !== 200)
          throw Error(`HTTP ${response.status}: ${await response.text()}`);
        revision++;
        let stream = await response.text();
        if (stream.includes('"type":"error"'))
          throw Error("Reply failed: " + stream.slice(-350));
        let state: any;
        let status = await fetch(base + "/api/creator-campaign?conversationId=" + cid, { headers });
        assert.equal(status.status, 200);
        state = await status.json();
        if (state.state.setup?.awaitingWebsite) {
          lastMessageId = randomUUID();
          const skip = await fetch(base + "/api/workspace-chat/stream", {
            method: "POST",
            headers,
            body: JSON.stringify({
              conversationId: cid,
              requestId: lastMessageId,
              messageId: randomUUID(),
              text: "Continue without a website",
              mode: "creators",
              revision,
            }),
          });
          assert.equal(skip.status, 200);
          revision++;
          stream += await skip.text();
          if (stream.includes('"type":"error"')) throw Error("Website skip failed");
          status = await fetch(base + "/api/creator-campaign?conversationId=" + cid, { headers });
          assert.equal(status.status, 200);
          state = await status.json();
        }
        const draft = state.runs.find((r: any) => r.status === "draft" && r.revision === state.state.revision);
        if (draft) {
          const approved = await fetch(base + "/api/creator-campaign", {
            method: "POST", headers, body: JSON.stringify({ conversationId: cid, command: { action: "approve_business", revision: state.state.revision, runId: draft.id } }),
          });
          assert.equal(approved.status, 200, "Business review failed");
          const started = await fetch(base + "/api/creator-campaign/start", {
            method: "POST", headers, body: JSON.stringify({ runId: draft.id }),
          });
          assert.equal(started.status, 200, "Explicit discovery start failed");
        }
        const until = Date.now() + 240000;
        do {
          const res = await fetch(
            base + "/api/creator-campaign?conversationId=" + cid,
            { headers },
          );
          assert.equal(res.status, 200);
          state = await res.json();
          const active = state.runs.filter((r: any) =>
            ["queued", "running"].includes(r.status),
          );
          if (!active.length) break;
          if (Date.now() > until) throw Error("Discovery timeout");
          await new Promise((r) => setTimeout(r, 2500));
        } while (true);
        for (const r of state.runs.filter((r: any) => r.status === "ready")) {
          const prior = snapshots.get(r.id);
          if (prior)
            assert.equal(
              JSON.stringify(r.result),
              prior,
              "Earlier result changed",
            );
          else snapshots.set(r.id, JSON.stringify(r.result));
        }
        if (
          process.env.CREATOR_EVAL_HISTORY &&
          test.id === "chatedu" &&
          text === test.followup
        )
          assert.ok(
            state.runs
              .at(-1)
              ?.result?.candidates.some((c: any) => c.id === test.expected),
            "Expected study creator missing before refinement",
          );
        trace.push({
          input: text,
          stream,
          brief: state.state.brief,
          runs: state.runs.map((r: any) => ({
            status: r.status,
            message_id: r.message_id,
            activity: r.activity,
            result: r.result,
          })),
        });
        if (state.runs.some((r: any) => r.status === "failed"))
          throw Error("Discovery run failed: " + JSON.stringify(state.runs));
      }
      const res = await fetch(
        base + "/api/creator-campaign?conversationId=" + cid,
        { headers },
      );
      const state = await res.json();
      const expectedBrands: Record<string, string> = {
        paypal: "PayPal",
        chatedu: "ChatEDU",
        "ag-grid": "AG Grid",
        apimatic: "APIMatic",
        bryntum: "Bryntum",
        channel3: "Channel3",
        elastic: "Elastic",
        postman: "Postman",
        render: "Render",
      };
      assert.equal(
        state.state.brief.brand?.toLowerCase(),
        expectedBrands[test.id].toLowerCase(),
        "Campaign brand was not preserved",
      );
      const run = state.runs.at(-1);
      assert.ok(run, "No discovery run");
      assert.equal(run.status, "ready");
      assert.equal(
        run.message_id,
        lastMessageId,
        "Result belongs to its assistant message",
      );
      const isHistoryCase = process.env.CREATOR_EVAL_HISTORY && test.id === "chatedu";
      const discovery = isHistoryCase ? state.runs.at(-2) : run;
      assert.deepEqual(discovery.activity.map((x: any) => x.name), ["Scout", "Muse", "Dot"]);
      if (isHistoryCase) {
        assert.deepEqual(run.activity.map((x: any) => x.name), ["Scout", "Muse", "Dot"]);
        assert.equal(typeof run.result.replacementAdded, "number");
        const prior = new Set(discovery.result.candidates.map((c: any) => c.id));
        assert.ok(discovery.result.candidates.filter((c: any) => c.id !== "student-educator").every((c: any) => run.result.candidates.some((next: any) => next.id === c.id)), "Existing candidates were not preserved");
        assert.equal(run.result.candidates.filter((c: any) => !prior.has(c.id)).length, run.result.replacementAdded, "Replacement must be unseen");
      }
      assert.ok(
        (!isHistoryCase && ["postman", "apimatic", "channel3"].includes(test.id))
          ? run.result.candidates.length > 0
          : run.result.candidates.some(
          (c: any) =>
            c.id ===
            (process.env.CREATOR_EVAL_HISTORY && test.id === "chatedu"
              ? "student-community"
              : test.expected),
        ),
        "Expected relevant creator missing",
      );
      if (process.env.CREATOR_EVAL_KEEP)
        await writeFile(
          "/tmp/sume-creator-run-browser.json",
          JSON.stringify({
            base,
            cookie,
            code: process.env.SUME_DEMO_CODE || "",
            conversationId: cid,
            userId,
          }),
          { mode: 0o600 },
        );
      if (test.id === "postman")
        assert.ok(
          run.result.candidates.every((candidate: any) =>
            creators.some((creator) => creator.id === candidate.id &&
              creator.topics.some((topic) => topic.toLowerCase() === "api testing") &&
              candidate.evidenceIndexes.some((index: number) =>
                /test|assertion/i.test(creator.evidence[index] || ""),
              ),
            ),
          ),
          "Adjacent non-testing creator retained",
        );
      if (test.id === "channel3")
        assert.ok(run.result.candidates.every((candidate: any) =>
          creators.some((creator) => creator.id === candidate.id && candidate.evidenceIndexes.some((index: number) =>
            /product search|search (?:results|ranking)|retrieval|shopping agents?|ecommerce agents?/i.test(creator.evidence[index] || "")))),
          "Candidate lacks cited search or shopping-agent evidence");
      if (test.id === "channel3")
        assert.ok(run.activity.every((role: any) => role.ids.every((id: string) =>
          creators.some((creator) => creator.id === id && creator.evidence.some((evidence) =>
            /product search|search (?:results|ranking)|retrieval|shopping agents?|ecommerce agents?/i.test(evidence))))),
          "An agent proposed a creator without direct search or shopping-agent evidence");
      if (test.id === "apimatic")
        assert.ok(run.result.candidates.every((candidate: any) =>
          creators.some((creator) => creator.id === candidate.id && candidate.evidenceIndexes.some((index: number) =>
            /\bgenerat(?:e|ed|ing|ion)\b[^.!?]{0,30}\bsdks?\b|\bsdks?\b[^.!?]{0,30}\bgenerat(?:e|ed|ing|ion)\b/i.test(creator.evidence[index] || "")))),
          "Candidate lacks cited generated-SDK evidence");
      if (test.id === "apimatic" || test.id === "postman") {
        const required = test.id === "apimatic"
          ? /\bgenerat(?:e|ed|ing|ion)\b[^.!?]{0,30}\bsdks?\b|\bsdks?\b[^.!?]{0,30}\bgenerat(?:e|ed|ing|ion)\b/i
          : /\b(?:api tests?|api testing|testing (?:an? )?api|request assertions?|test (?:an? )?api)\b/i;
        assert.ok(run.activity.every((role: any) => role.ids.every((id: string) => creators.some((creator) => creator.id === id && creator.evidence.some((evidence) => required.test(evidence))))), "An agent proposed a creator lacking requested evidence");
      }
      if (process.env.CREATOR_EVAL_HISTORY && test.id === "chatedu") {
        assert.ok(state.runs.length >= 2, "Missing prior discovery history");
        assert.ok(
          !run.result.candidates.some((c: any) => c.id === "student-educator"),
          "Excluded creator returned",
        );
      }
      rows.push({
        case: test.id,
        pass: true,
        runId: run.id,
        roles: run.activity,
        candidates: run.result.candidates,
      });
    } catch (e) {
      rows.push({
        case: test.id,
        pass: false,
        error: (e as Error).message,
        trace,
      });
    }
    console.log(JSON.stringify(rows.at(-1)));
    await writeFile(
      process.env.CREATOR_EVAL_OUTPUT || new URL(
        `../../research/creator-real-runs-${process.env.CREATOR_EVAL_DIRECT ? "direct-" : ""}${process.env.CREATOR_EVAL_FILTER || "all"}-2026-11-10.json`,
        import.meta.url,
      ),
      JSON.stringify(
        {
          method:
            "Local authenticated HTTP conversation and durable workflow, three real model roles, fictional catalog. Expected candidate presence is not a full relevance evaluation.",
          rows,
        },
        null,
        2,
      ) + "\n",
    );
  }
} finally {
  if (userId && !process.env.CREATOR_EVAL_KEEP)
    await authPool.query("DELETE FROM auth_users WHERE id=$1", [userId]);
  await authPool.end();
}
if (rows.some((r) => !r.pass)) process.exitCode = 1;
