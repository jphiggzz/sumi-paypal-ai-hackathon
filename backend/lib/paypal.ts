import { FatalError } from "workflow";
import type { Offer } from "./policy";

const base = "https://api-m.sandbox.paypal.com";
const path = "/v1/payments/payouts";

async function call(endpoint: string, options: RequestInit) {
  const response = await fetch(base + endpoint, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
  if (response.status >= 500 || response.status === 429)
    throw new Error("Sandbox API temporarily unavailable");
  return response;
}

async function headers() {
  const client = process.env.PAYPAL_SANDBOX_CLIENT_ID;
  const secret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
  if (!client || !secret) throw new FatalError("Sandbox credentials missing");
  const response = await call("/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(client + ":" + secret).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw new FatalError("Sandbox authentication failed");
  const { access_token: token } = await response.json();
  if (!token) throw new FatalError("Sandbox token missing");
  return {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
}

export function campaignPayoutReady() {
  return Boolean(
    process.env.PAYPAL_SANDBOX_CLIENT_ID &&
    process.env.PAYPAL_SANDBOX_CLIENT_SECRET &&
    ["A", "B"].every((k) =>
      /^sb-[^@\s]+@(?:personal|business)\.example\.com$/i.test(
        process.env["PAYPAL_SANDBOX_CREATOR_" + k]?.trim() || "",
      ),
    ),
  );
}

function recipient(offer: Offer) {
  const email = process.env["PAYPAL_SANDBOX_CREATOR_" + offer.creator]?.trim();
  if (
    !email ||
    !/^sb-[^@\s]+@(?:personal|business)\.example\.com$/i.test(email)
  ) {
    throw new FatalError("Sandbox recipient missing or invalid");
  }
  return email;
}

export async function submit(offer: Offer, key: string) {
  const response = await call(path, {
    method: "POST",
    headers: { ...(await headers()), "PayPal-Request-Id": key },
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: key,
        email_subject: "Sume Sandbox milestone",
      },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: recipient(offer),
          sender_item_id: offer.creator,
          amount: {
            currency: "USD",
            value: (offer.milestoneCents / 100).toFixed(2),
          },
        },
      ],
    }),
  });
  const body = await response.json();
  if (response.ok && typeof body.batch_header?.payout_batch_id === "string")
    return body.batch_header.payout_batch_id as string;
  const details: {
    field?: string;
    issue?: string;
    link?: unknown[];
    links?: unknown[];
  }[] = Array.isArray(body.details) ? body.details : [];
  const duplicates = details.filter(
    (detail) =>
      detail.issue === "DUPLICATE_BATCH_ID" ||
      (detail.field === "SENDER_BATCH_ID" &&
        detail.issue === "Batch with given sender_batch_id already exists"),
  );
  if (duplicates.length || body.name === "DUPLICATE_BATCH_ID") {
    const links = [
      ...(Array.isArray(body.links) ? body.links : []),
      ...duplicates.flatMap((detail) =>
        [detail.link, detail.links].filter(Array.isArray).flat(),
      ),
    ];
    for (const link of links) {
      if (link?.rel !== "self" || typeof link.href !== "string") continue;
      const url = URL.parse(link.href, base);
      if (
        !url ||
        ![base, "https://api.sandbox.paypal.com"].includes(url.origin)
      )
        continue;
      const match = url.pathname.match(
        /^\/v1\/payments\/payouts\/([a-zA-Z0-9]+)$/,
      );
      if (match) return match[1];
    }
    throw new FatalError(
      "Sandbox duplicate response omitted the original batch reference",
    );
  }
  if (response.ok) throw new Error("Sandbox response omitted batch ID");
  throw new FatalError(
    "Sandbox submission requires reconciliation (HTTP " + response.status + ")",
  );
}

export async function status(offer: Offer, key: string, batchId: string) {
  const response = await call(path + "/" + encodeURIComponent(batchId), {
    headers: await headers(),
  });
  if (!response.ok) throw new FatalError("Sandbox lookup failed");
  const body = await response.json();
  if (body.batch_header?.sender_batch_header?.sender_batch_id !== key)
    throw new FatalError("Sandbox batch mismatch");
  if (body.batch_header?.batch_status === "DENIED") return { status: "DENIED" };
  const item = body.items?.find(
    (entry: { payout_item?: { sender_item_id?: string } }) =>
      entry.payout_item?.sender_item_id === offer.creator,
  );
  if (
    item &&
    (item.payout_item.receiver?.toLowerCase() !==
      recipient(offer).toLowerCase() ||
      item.payout_item.amount?.currency !== "USD" ||
      item.payout_item.amount?.value !==
        (offer.milestoneCents / 100).toFixed(2))
  )
    throw new FatalError("Sandbox payout item mismatch");
  if (item?.transaction_status !== "SUCCESS")
    return { status: String(item?.transaction_status ?? "PENDING") };
  if (typeof item.payout_item_id !== "string")
    throw new FatalError("Sandbox payout item mismatch");
  return { status: "SUCCESS", itemId: item.payout_item_id as string };
}
