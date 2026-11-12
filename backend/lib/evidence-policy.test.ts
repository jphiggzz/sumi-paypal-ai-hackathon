import { test } from "node:test";
import assert from "node:assert/strict";
import { validateExtraction, usdCents, paymentScope } from "./evidence-policy";
import {
  workspaceState,
  initialWorkspace,
  applyWorkspacePlan,
} from "./workspace-policy";
import { workInput, workPhaseTools } from "./work-policy";
test("evidence validation rejects fabricated, empty, duplicate and unsupported field findings", () => {
  const text = "The service costs 1.25 USD and takes three days.";
  const good = {
    field: "Price",
    status: "found",
    value: "1.25 USD",
    quotes: [text],
  };
  assert.equal(
    validateExtraction(text, ["Price"], { facts: [good] })[0].value,
    "1.25 USD",
  );
  for (const patch of [
    { quotes: ["fake quote"] },
    { value: "99 USD" },
    { value: "" },
  ])
    assert.equal(
      validateExtraction(text, ["Price"], { facts: [{ ...good, ...patch }] })[0]
        .status,
      "absent",
    );
  assert.equal(
    validateExtraction(text, ["Price"], { facts: [good, good] })[0].status,
    "absent",
  );
  const e = validateExtraction(text, ["Price"], { facts: [good] })[0]
    .evidence[0];
  assert.equal(text.slice(e.start, e.end), e.quote);
});
test("conflicts cannot become a spendable value and literal evidence does not promise semantic truth", () => {
  const text = "Option one costs 1 USD. Option two costs 2 USD.";
  assert.equal(
    validateExtraction(text, ["Price"], {
      facts: [
        { field: "Price", status: "ambiguous", value: null, quotes: [text] },
      ],
    })[0].value,
    null,
  );
  // Semantic correctness is measured independently; provenance alone accepts any literal value.
  assert.equal(
    validateExtraction(text, ["Price"], {
      facts: [
        { field: "Price", status: "found", value: "1 USD", quotes: [text] },
      ],
    })[0].status,
    "found",
  );
});
test("payment parser uses exact integer cents, explicit USD and conservative maximum", () => {
  assert.equal(usdCents("1.25 USD"), 125);
  assert.equal(usdCents("USD 0.01"), 1);
  assert.equal(usdCents("100 USD"), 10000);
  for (const v of [
    "$5",
    "5 EUR",
    "USD 5.005",
    "-1 USD",
    "1e2 USD",
    "0 USD",
    "100.01 USD",
    "1 USD and 2 USD",
    "NaN",
    null,
  ])
    assert.equal(usdCents(v), null, String(v));
  assert.equal(
    paymentScope.safeParse({
      sourceIndex: 0,
      amountField: "Price",
      payee: "arbitrary@email.com",
      maxCents: 100,
      currency: "USD",
    }).success,
    false,
  );
});
test("workspace state cannot persist executable expressions, unknown tables, widgets or arbitrary links", () => {
  const s = initialWorkspace();
  assert.ok(workspaceState.safeParse(s).success);
  assert.equal(
    workspaceState.safeParse({
      ...s,
      pages: [
        {
          ...s.pages[0],
          widgets: { attack: { type: "html", html: "<script>" } },
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    workspaceState.safeParse({
      ...s,
      pages: [
        {
          ...s.pages[0],
          widgets: {
            ...s.pages[0].widgets,
            comparison: {
              type: "grid",
              dataMapping: { cols: [{ id: "secrets.token" }] },
            },
          },
        },
      ],
    }).success,
    false,
  );
  const clean = workspaceState.parse({ ...s, expression: "run code" });
  assert.equal("expression" in clean, false);
  assert.equal(
    applyWorkspacePlan(s, "show_missing").pages[0].widgets.missing.type,
    "grid",
  );
});
test("payment proposal phase follows result read and cannot authorize execution", () => {
  const w = {
    state: "completed",
    internal_kind: "job_result",
    request: { sources: [], fields: ["Price"], payment: {} },
    resolved_sources: [],
  };
  assert.deepEqual(workPhaseTools(w, "completed", []), ["read_job_result"]);
  assert.deepEqual(workPhaseTools(w, "completed", ["read_job_result"]), [
    "propose_sandbox_payment",
  ]);
  assert.deepEqual(
    workPhaseTools(w, "completed", [
      "read_job_result",
      "propose_sandbox_payment",
    ]),
    ["reply", "create_draft"],
  );
  assert.deepEqual(
    workPhaseTools({ ...w, internal_kind: "payment_result" }, "completed", []),
    ["reply"],
  );
});
