import crypto from "node:crypto";
import Stripe from "stripe";
import type { Payment, Provider } from "@prisma/client";
import { type Config, equal, fail } from "./core.js";
export interface Verified {
  reference: string;
  providerId: string;
  status: "SUCCESS" | "PENDING" | "FAILED";
  amountMinor: bigint;
  currency: string;
  payload: object;
}
export interface PaymentProvider {
  initialize(payment: Payment): Promise<{ id: string; url: string }>;
  verify(payment: Payment): Promise<Verified>;
  webhook(
    raw: Buffer,
    headers: Record<string, unknown>,
  ): { eventId: string; reference: string } | null;
  refund(payment: Payment, refundId: string, amount: bigint): Promise<string>;
}
export async function providerRequest(
  url: string,
  token: string,
  body?: unknown,
) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    fail(
      502,
      "PROVIDER_ERROR",
      "The payment provider could not complete the request.",
    );
  return response.json() as Promise<any>;
}
export function toMinor(value: string | number) {
  const text = String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    fail(422, "AMOUNT_FORMAT", "Unsupported provider amount.");
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
export function validateVerification(
  payment: Pick<
    Payment,
    "reference" | "amountMinor" | "currency" | "providerId"
  >,
  v: Verified,
) {
  if (
    v.reference !== payment.reference ||
    v.amountMinor !== payment.amountMinor ||
    v.currency.toUpperCase() !== payment.currency ||
    !v.providerId ||
    (payment.providerId && v.providerId !== payment.providerId)
  )
    fail(
      422,
      "PAYMENT_MISMATCH",
      "Verified payment details do not match the server invoice.",
    );
}
export function providers(
  config: Config,
): Partial<Record<Provider, PaymentProvider>> {
  const result: Partial<Record<Provider, PaymentProvider>> = {};
  if (config.PAYSTACK_SECRET_KEY) {
    const key = config.PAYSTACK_SECRET_KEY;
    result.PAYSTACK = {
      async initialize(p) {
        const v = await providerRequest(
          "https://api.paystack.co/transaction/initialize",
          key,
          {
            reference: p.reference,
            email: p.payerEmail,
            amount: p.amountMinor.toString(),
            currency: p.currency,
            callback_url: `${config.FRONTEND_ORIGIN}/payment-status?ref=${encodeURIComponent(p.reference)}`,
          },
        );
        return { id: String(v.data.reference), url: v.data.authorization_url };
      },
      async verify(p) {
        const v = await providerRequest(
          "https://api.paystack.co/transaction/verify/" +
            encodeURIComponent(p.reference),
          key,
        );
        return {
          reference: v.data.reference,
          providerId: p.reference,
          status:
            v.data.status === "success"
              ? "SUCCESS"
              : ["failed", "abandoned"].includes(v.data.status)
                ? "FAILED"
                : "PENDING",
          amountMinor: BigInt(v.data.amount),
          currency: v.data.currency,
          payload: { transactionId: v.data.id, status: v.data.status },
        };
      },
      webhook(raw, headers) {
        const mac = crypto.createHmac("sha512", key).update(raw).digest("hex");
        if (!equal(String(headers["x-paystack-signature"] || ""), mac))
          fail(401, "SIGNATURE", "Invalid webhook signature.");
        const e = JSON.parse(raw.toString());
        if (e.event !== "charge.success") return null;
        return {
          eventId: `${e.event}:${e.data.id}`,
          reference: String(e.data.reference),
        };
      },
      async refund(p, refundId, amount) {
        const v = await providerRequest("https://api.paystack.co/refund", key, {
          transaction: p.reference,
          amount: amount.toString(),
          merchant_note: refundId,
        });
        return String(v.data.id);
      },
    };
  }
  if (config.FLUTTERWAVE_SECRET_KEY && config.FLUTTERWAVE_WEBHOOK_SECRET) {
    const key = config.FLUTTERWAVE_SECRET_KEY;
    result.FLUTTERWAVE = {
      async initialize(p) {
        const v = await providerRequest(
          "https://api.flutterwave.com/v3/payments",
          key,
          {
            tx_ref: p.reference,
            amount: (Number(p.amountMinor) / 100).toFixed(2),
            currency: p.currency,
            redirect_url: `${config.FRONTEND_ORIGIN}/payment-status?ref=${encodeURIComponent(p.reference)}`,
            customer: {
              email: p.payerEmail,
              phonenumber: p.payerPhone,
              name: p.payerName,
            },
          },
        );
        return { id: p.reference, url: v.data.link };
      },
      async verify(p) {
        const v = await providerRequest(
          "https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=" +
            encodeURIComponent(p.reference),
          key,
        );
        return {
          reference: v.data.tx_ref,
          providerId: p.reference,
          status:
            v.data.status === "successful"
              ? "SUCCESS"
              : v.data.status === "failed"
                ? "FAILED"
                : "PENDING",
          amountMinor: toMinor(v.data.amount),
          currency: v.data.currency,
          payload: { transactionId: v.data.id, status: v.data.status },
        };
      },
      webhook(raw, headers) {
        const mac = crypto
          .createHmac("sha256", config.FLUTTERWAVE_WEBHOOK_SECRET!)
          .update(raw)
          .digest("base64");
        if (!equal(String(headers["flutterwave-signature"] || ""), mac))
          fail(401, "SIGNATURE", "Invalid webhook signature.");
        const e = JSON.parse(raw.toString());
        if (e.event !== "charge.completed") return null;
        return {
          eventId: String(e.id || `charge:${e.data.id}`),
          reference: e.data.tx_ref,
        };
      },
      async refund(p, _id, amount) {
        const v = await providerRequest(
          "https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=" +
            encodeURIComponent(p.reference),
          key,
        );
        const refund = await providerRequest(
          `https://api.flutterwave.com/v3/transactions/${v.data.id}/refund`,
          key,
          { amount: (Number(amount) / 100).toFixed(2) },
        );
        return String(refund.data.id);
      },
    };
  }
  if (config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET) {
    const stripe = new Stripe(config.STRIPE_SECRET_KEY);
    result.STRIPE = {
      async initialize(p) {
        const v = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            client_reference_id: p.reference,
            customer_email: p.payerEmail,
            line_items: [
              {
                price_data: {
                  currency: p.currency.toLowerCase(),
                  unit_amount: Number(p.amountMinor),
                  product_data: { name: p.purpose + " fee" },
                },
                quantity: 1,
              },
            ],
            success_url: `${config.FRONTEND_ORIGIN}/payment-status?ref=${encodeURIComponent(p.reference)}`,
            cancel_url: `${config.FRONTEND_ORIGIN}/payment-status?ref=${encodeURIComponent(p.reference)}`,
          },
          { idempotencyKey: p.reference },
        );
        return { id: v.id, url: v.url! };
      },
      async verify(p) {
        if (!p.providerId)
          fail(
            409,
            "CHECKOUT_PENDING",
            "Checkout initialization is incomplete.",
          );
        const v = await stripe.checkout.sessions.retrieve(p.providerId);
        return {
          reference: v.client_reference_id!,
          providerId: v.id,
          status:
            v.payment_status === "paid"
              ? "SUCCESS"
              : v.status === "expired"
                ? "FAILED"
                : "PENDING",
          amountMinor: BigInt(v.amount_total || 0),
          currency: v.currency!.toUpperCase(),
          payload: {
            sessionId: v.id,
            paymentIntent: v.payment_intent,
            status: v.payment_status,
          },
        };
      },
      webhook(raw, headers) {
        let e: Stripe.Event;
        try {
          e = stripe.webhooks.constructEvent(
            raw,
            String(headers["stripe-signature"] || ""),
            config.STRIPE_WEBHOOK_SECRET!,
          );
        } catch {
          fail(401, "SIGNATURE", "Invalid webhook signature.");
        }
        if (
          ![
            "checkout.session.completed",
            "checkout.session.async_payment_succeeded",
          ].includes(e.type)
        )
          return null;
        const s = e.data.object as Stripe.Checkout.Session;
        return { eventId: e.id, reference: s.client_reference_id! };
      },
      async refund(p, refundId, amount) {
        const s = await stripe.checkout.sessions.retrieve(p.providerId!);
        const v = await stripe.refunds.create(
          { payment_intent: String(s.payment_intent), amount: Number(amount) },
          { idempotencyKey: refundId },
        );
        return v.id;
      },
    };
  }
  return result;
}
