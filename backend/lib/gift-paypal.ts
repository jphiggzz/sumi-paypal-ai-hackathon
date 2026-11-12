import { giftMoney } from "./gift-policy";
const base = "https://api-m.sandbox.paypal.com";
export async function giftPayPal(path: string, method = "GET", body?: unknown, key?: string) {
  if (!process.env.PAYPAL_SANDBOX_CLIENT_ID || !process.env.PAYPAL_SANDBOX_CLIENT_SECRET) throw new Error("PAYPAL_SANDBOX_NOT_CONFIGURED");
  const auth = await fetch(base + "/v1/oauth2/token", { method: "POST", redirect: "error", signal: AbortSignal.timeout(12000), headers: { Authorization: "Basic " + Buffer.from(process.env.PAYPAL_SANDBOX_CLIENT_ID + ":" + process.env.PAYPAL_SANDBOX_CLIENT_SECRET).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  if (!auth.ok) throw new Error("PAYPAL_AUTH_FAILED");
  const token = await auth.json();
  const response = await fetch(base + path, { method, redirect: "error", signal: AbortSignal.timeout(12000), headers: { Authorization: "Bearer " + token.access_token, "Content-Type": "application/json", Prefer: "return=representation", ...(key ? { "PayPal-Request-Id": key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}
export function contributionOrder(id: string, cents: number, returnUrl: string, cancelUrl: string) {
  return { intent: "CAPTURE", purchase_units: [{ custom_id: id, description: "Sume group thank-you contribution — Sandbox demo merchant", amount: { currency_code: "USD", value: giftMoney(cents) } }], payment_source: { paypal: { experience_context: { brand_name: "Sume Sandbox", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", return_url: returnUrl, cancel_url: cancelUrl } } } };
}
