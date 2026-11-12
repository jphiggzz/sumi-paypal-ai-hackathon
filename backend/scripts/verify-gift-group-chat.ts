import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { fundGift } from "../lib/gift-store";
const base = process.env.WORKSPACE_VERIFY_URL || "http://localhost:3000";
if (!/^http:\/\/localhost:\d+$/.test(base))
  throw Error("Local verification only");
const keep = process.argv.includes("--keep");
const startedAt = new Date().toISOString();
const people: any[] = [],
  checks: string[] = [];
let simulatedUsers: string[] = [],
  succeeded = false;
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
async function request(a: any, path: string, body?: any, admission = true) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: base,
      Cookie: a.cookie,
      "Content-Type": "application/json",
      ...(admission ? { "x-demo-code": process.env.SUME_DEMO_CODE || "" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
async function person(name: string) {
  const r = await auth.api.signUpEmail({
    body: {
      email: `gift-chat-verify-${randomUUID()}@example.invalid`,
      name,
      password: randomUUID() + randomUUID(),
    },
    asResponse: true,
  });
  assert.equal(r.status, 200);
  const { user } = await r.json();
  const a = {
    id: user.id,
    name,
    cookie: r.headers
      .getSetCookie()
      .filter((c) => c.split("=")[0].includes("session_token"))
      .map((c) => c.split(";")[0])
      .join("; "),
    conversation: randomUUID(),
  };
  people.push(a);
  assert.equal(
    (
      await request(
        a,
        "/api/workspace-chat",
        { action: "create", id: a.conversation, mode: "shopping" },
        false,
      )
    ).status,
    200,
  );
  return a;
}
async function command(a: any, command: any, admission = true) {
  return request(
    a,
    "/api/workspace-chat/workflows",
    { conversationId: a.conversation, command },
    admission,
  );
}
async function gift(a: any, payload: any, admission = true) {
  return command(a, { action: "gift", payload }, admission);
}
async function state(a: any) {
  const r = await request(
    a,
    "/api/workspace-chat/workflows?conversationId=" + a.conversation,
    undefined,
    false,
  );
  assert.equal(r.status, 200);
  return r.body.flows.find((f: any) => f.kind === "gift").state;
}
try {
  if (process.argv.includes("--cleanup")) {
    const saved = JSON.parse(
      await readFile("/tmp/gift-group-chat-verification.json", "utf8"),
    );
    people.push(...saved.people);
    simulatedUsers = saved.simulatedUsers;
    const a = people[1];
    assert.equal(
      (
        await gift(
          a,
          { action: "share", messageId: saved.feedbackId, active: false },
          false,
        )
      ).status,
      200,
    );
    const changed = await state(people[0]);
    assert.equal(changed.option, null);
    assert(changed.members.every((m: any) => !m.approved));
    assert(
      changed.jobs
        .filter(
          (j: any) =>
            j.kind === "plan" && j.revision !== changed.group.revision,
        )
        .every((j: any) => j.result === null),
    );
    const path = "../research/gift-group-chat-verification-2026-11-10.json";
    const evidence = JSON.parse(await readFile(path, "utf8"));
    evidence.checks.push(
      "Context withdrawal invalidates proposal and every approval; superseded transcripts omitted from member reads",
    );
    evidence.fixturesCleaned = true;
    await writeFile(path, JSON.stringify(evidence, null, 2) + "\n");
    console.log(
      "Withdrawal checks passed; removing synthetic verification accounts and private session files.",
    );
  } else {
    const alex = await person("Alex"),
      taylor = await person("Taylor"),
      stranger = await person("Outsider");
    assert.equal(
      (await command(stranger, { action: "prepare_campaign" }, false)).status,
      403,
    );
    assert.equal(
      (
        await command(alex, {
          action: "prepare_gift",
          recipient: "Sam",
          occasion:
            "Thank Sam for hosting our birthday weekend; he paints watercolors",
          reserveCents: 1000,
        })
      ).status,
      200,
    );
    const group = (await state(alex)).group.id;
    const invite = await gift(alex, { action: "invite" });
    assert.equal(invite.status, 200);
    assert.equal(
      (
        await command(
          taylor,
          { action: "join_gift", token: invite.body.result.inviteToken },
          false,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          stranger,
          "/api/workspace-chat/workflows?conversationId=" + alex.conversation,
          undefined,
          false,
        )
      ).status,
      404,
    );
    assert.equal(
      (await gift(taylor, { action: "simulate_friends" }, false)).status,
      403,
    );
    assert.equal(
      (await gift(alex, { action: "simulate_friends" })).status,
      200,
    );
    assert.equal(
      (await gift(alex, { action: "simulate_friends" })).status,
      200,
    );
    let s = await state(alex);
    assert.equal(s.members.length, 4);
    assert.equal(s.members.filter((m: any) => m.simulated).length, 2);
    simulatedUsers = (
      await authPool.query(
        "SELECT user_id FROM gift_members WHERE group_id=$1 AND simulated",
        [group],
      )
    ).rows.map((r) => r.user_id);
    checks.push(
      "Real link join without preview code; nonmember ownership isolation; owner-only, idempotent simulation; real and simulated friends coexist",
    );
    assert.equal(
      (await gift(alex, { action: "limit", cents: 5000 })).status,
      200,
    );
    assert.equal(
      (await gift(taylor, { action: "limit", cents: 2000 }, false)).status,
      200,
    );
    for (const [a, text] of [
      [
        alex,
        "Sam recently started watercolor painting and already bought paint. Please find quality watercolor paper or artist brushes, not more paint.",
      ],
      [
        taylor,
        "Sam already has several mugs and a backpack. Prefer compact art supplies, especially watercolor paper.",
      ],
    ] as const) {
      const r = await command(
        a,
        { action: "group_feedback", id: randomUUID(), text },
        false,
      );
      assert.equal(r.status, 200);
    }
    const privateId = randomUUID(),
      secret = "UNSHARED_PRIVATE_VERIFICATION_" + randomUUID();
    await authPool.query(
      "INSERT INTO gift_messages(id,member_id,role,content) SELECT $1,id,'user',$3 FROM gift_members WHERE group_id=$2 AND user_id=$4",
      [privateId, group, secret, taylor.id],
    );
    s = await state(alex);
    assert(!JSON.stringify(s).includes(secret));
    assert(!s.members.some((m: any) => "limitCents" in m));
    const feedbackId = randomUUID();
    assert.equal(
      (
        await command(
          taylor,
          {
            action: "group_feedback",
            id: feedbackId,
            text: "Please avoid bulky gifts.",
          },
          false,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await command(
          taylor,
          {
            action: "group_feedback",
            id: feedbackId,
            text: "Please avoid bulky gifts.",
          },
          false,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await command(alex, {
          action: "group_feedback",
          id: feedbackId,
          text: "Replace another person’s note.",
        })
      ).status,
      409,
    );
    checks.push(
      "Private chats and individual limits excluded; explicit shared feedback is owned and replay-safe",
    );
    const job = randomUUID();
    assert.equal((await gift(alex, { action: "plan", id: job })).status, 200);
    assert.equal(
      (await gift(taylor, { action: "plan", id: randomUUID() }, false)).status,
      409,
    );
    const input = (
      await authPool.query("SELECT input FROM gift_jobs WHERE id=$1", [job])
    ).rows[0].input;
    assert(!JSON.stringify(input).includes(secret));
    let latest: any;
    for (let i = 0; i < 150; i++) {
      s = await state(alex);
      latest = s.jobs.find((j: any) => j.id === job);
      if (["ready", "failed", "cancelled"].includes(latest.status)) break;
      if (i % 10 === 0)
        console.log(
          JSON.stringify({
            status: latest.status,
            turns: latest.result?.transcript?.length || 0,
          }),
        );
      await delay(3000);
    }
    assert.equal(latest.status, "ready");
    assert(latest.result.options.length > 0);
    assert(
      latest.result.options.every((o: any) =>
        o.lines.every((p: any) => /paper|brush/i.test(p.title)),
      ),
      "Explicit art-supply fixture must avoid paint sets and propose paper/brushes",
    );
    const turns = latest.result.transcript;
    assert.equal(turns.length, 8);
    assert.equal(turns.filter((t: any) => t.phase === "discussion").length, 4);
    assert(
      turns.every((t: any) =>
        t.factIds.every((id: string) =>
          input.facts.some((f: any) => f.id === id),
        ),
      ),
    );
    assert(!JSON.stringify(latest).includes(secret));
    checks.push(
      "Live four-agent two-round discussion persisted; real Channel3 products; source citations valid; no unshared input; concurrent starts rejected",
    );
    const option = latest.result.options[0];
    assert(option.goalCents <= s.group.budgetCents);
    assert.equal(
      (await gift(alex, { action: "select", jobId: job, optionId: option.id }))
        .status,
      200,
    );
    s = await state(alex);
    const digest = s.option.digest;
    assert.equal(
      (await gift(taylor, { action: "approve_simulated", digest }, false))
        .status,
      403,
    );
    assert.equal(
      (await gift(alex, { action: "approve_simulated", digest })).status,
      200,
    );
    s = await state(alex);
    assert(
      s.members.filter((m: any) => m.simulated).every((m: any) => m.approved),
    );
    assert(
      s.members.filter((m: any) => !m.simulated).every((m: any) => !m.approved),
    );
    assert.equal(s.group.fundedCents, 0);
    await assert.rejects(
      () => fundGift(simulatedUsers[0], group, randomUUID(), digest, 100, base),
      /SIMULATED_FRIEND_CANNOT_PAY/,
    );
    assert.equal(
      (await gift(taylor, { action: "approve", digest }, false)).status,
      200,
    );
    assert.equal((await gift(alex, { action: "approve", digest })).status, 200);
    checks.push(
      "Exact-plan approvals stay individual; demo approvals cannot affect real members or create funding; simulated accounts cannot pay",
    );
    // Keep the completed state for browser checks, then exercise invalidation on cleanup run.
    const chargeRows = (
      await authPool.query(
        "SELECT id,held_usd,confirmed_usd FROM agent_model_charges WHERE created_at>=$1 AND model='google/gemini-2.5-flash-lite' ORDER BY created_at",
        [startedAt],
      )
    ).rows;
    assert.equal(
      chargeRows.length,
      9,
      "One model call per delegate round plus coordinator",
    );
    const evidence = {
      costReceipts: chargeRows.map((r) => r.id),
      checkedAt: new Date().toISOString(),
      checks,
      live: {
        agents: 4,
        turns: turns.length,
        options: latest.result.options.length,
        products: latest.result.products.length,
      },
      paymentCalls: 0,
      boundaries:
        "Synthetic test accounts, live AI and Channel3; no payment requested. Product relevance remains human-reviewed.",
    };
    await writeFile(
      "../research/gift-group-chat-verification-2026-11-10.json",
      JSON.stringify(evidence, null, 2) + "\n",
    );
    if (keep) {
      await writeFile(
        "/tmp/gift-group-chat-verification.json",
        JSON.stringify({ people, simulatedUsers, group, feedbackId }),
        { mode: 0o600 },
      );
      const cookie = alex.cookie.split("=");
      await writeFile(
        "/tmp/gift-group-chat-browser.json",
        JSON.stringify({
          cookies: [
            {
              name: cookie[0],
              value: cookie.slice(1).join("="),
              domain: "localhost",
              path: "/",
              httpOnly: true,
              secure: false,
              sameSite: "Lax",
              expires: Date.now() / 1000 + 3600,
            },
          ],
          origins: [
            {
              origin: base,
              localStorage: [
                {
                  name: "gift-verification-admission",
                  value: process.env.SUME_DEMO_CODE || "",
                },
              ],
            },
          ],
        }),
        { mode: 0o600 },
      );
    }
    succeeded = true;
    console.log(JSON.stringify(evidence));
  }
} finally {
  if (!keep || !succeeded) {
    for (const a of people)
      await authPool.query(
        "DELETE FROM auth_users WHERE id=$1 AND email LIKE 'gift-chat-verify-%@example.invalid'",
        [a.id],
      );
    for (const id of simulatedUsers)
      await authPool.query(
        "DELETE FROM auth_users WHERE id=$1 AND email LIKE 'gift-simulated-%@example.invalid'",
        [id],
      );
    await rm("/tmp/gift-group-chat-verification.json", { force: true });
    await rm("/tmp/gift-group-chat-browser.json", { force: true });
  }
  await authPool.end();
}
