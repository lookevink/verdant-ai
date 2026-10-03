import Stripe from "stripe";
import { recordRefund, refundCandidates } from "../../../../../src/lib/acquisitions";
import { stripeClient } from "../../../../../src/lib/payments";
import { isWorker } from "../../../../../src/lib/services";

/**
 * Refund verified payments whose acquisition failed. Called by the worker (which holds no payment
 * credentials) after a terminal failure and periodically. Idempotency keys make repeated sweeps safe.
 */
export async function POST(request: Request) {
  if (!isWorker(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let stripe: Stripe;
  try { stripe = stripeClient(); } catch { return Response.json({ error: "payments_unavailable" }, { status: 503 }); }
  try {
    const results = [];
    for (const c of await refundCandidates()) {
      if (c.provider !== "stripe") { await recordRefund(c.paymentId, "reconciliation_required", { reason: "unsupported_provider" }); continue; }
      try {
        const refund = await stripe.refunds.create({ payment_intent: c.reference, metadata: { acquisitionId: c.acquisitionId, paymentId: c.paymentId } },
          { idempotencyKey: `verdant-refund-${c.paymentId}` });
        const status = refund.status === "succeeded" ? "refunded" : refund.status === "pending" ? "refund_pending" : "reconciliation_required";
        await recordRefund(c.paymentId, status, { refund: refund.id, providerStatus: refund.status });
        results.push({ paymentId: c.paymentId, status });
      } catch (error) {
        const code = error instanceof Stripe.errors.StripeError ? error.code ?? error.type : "unknown";
        if (code === "charge_already_refunded") await recordRefund(c.paymentId, "refunded", { providerCode: code });
        else if (error instanceof Stripe.errors.StripeInvalidRequestError) await recordRefund(c.paymentId, "reconciliation_required", { providerCode: code });
        results.push({ paymentId: c.paymentId, status: "error", code });
      }
    }
    return Response.json({ processed: results.length, results }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "refund_sweep_failed" }, { status: 503 }); }
}
