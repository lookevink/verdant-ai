import { Receipt } from "mppx";
import { readDataRequest } from "../../../../../src/lib/http";
import { dataResponse, unavailable } from "../../../../../src/lib/climate-data";
import { chargeOptions, paidAcquisition, prepareDataRequest, submitAcquisition, submitPaidAcquisition } from "../../../../../src/lib/acquisitions";
import { acquisitionPrice, credentialHash, stripePayment } from "../../../../../src/lib/payments";
import { isAdmin } from "../../../../../src/lib/services";

function accepted<T extends { links: { self?: string } }>(body: T, response = dataResponse(body, 202)) {
  response.headers.set("Location", body.links.self!);
  response.headers.set("Retry-After", "10");
  return response;
}

/**
 * Cache hit: 200, free. An identical acquisition already running: 202, free. Otherwise a new acquisition is
 * paid through MPP: 402 with a challenge, then 202 with a Payment-Receipt once the credential verifies.
 * The API bearer token can queue without payment. Payment and queueing commit together.
 */
export async function POST(request: Request) {
  const parsed = await readDataRequest(request);
  if (parsed.response) return parsed.response;
  let prepared;
  try { prepared = await prepareDataRequest(parsed.request); } catch { return unavailable(); }
  if (prepared.kind === "ready" || prepared.kind === "rejected") return dataResponse(prepared.body, prepared.status);
  if (prepared.kind === "existing") return prepared.status === 202 ? accepted(prepared.body) : dataResponse(prepared.body);
  const { plan } = prepared;
  if (isAdmin(request)) {
    try { return accepted({ ...await submitAcquisition(plan, parsed.request, "api_admin"), cache: "miss" }); }
    catch { return unavailable(); }
  }
  let payments, price;
  try { payments = stripePayment(); price = acquisitionPrice(); }
  catch { return dataResponse({ error: "payments_unavailable", cache: "miss", message: "Published coverage does not satisfy this request and paid acquisition is not configured." }, 503); }
  const authorization = request.headers.get("authorization");
  const hash = authorization?.startsWith("Payment ") ? credentialHash("verdant-acquisition", authorization) : null;
  try {
    if (hash) {
      // A retried credential recovers its request; the provider is never asked to charge it twice.
      const recovered = await paidAcquisition(hash);
      if (recovered) {
        const response = accepted({ ...recovered.record, cache: "miss" });
        if (recovered.receipt) response.headers.set("Payment-Receipt", recovered.receipt);
        return response;
      }
    }
    const payment = await payments.charge(chargeOptions(plan, price))(request);
    if (payment.status === 402) return payment.challenge;
    const encoded = payment.withReceipt(Response.json({})).headers.get("Payment-Receipt");
    if (!encoded || !hash) throw new Error("Missing payment receipt or credential.");
    const receipt = Receipt.deserialize(encoded);
    const record = await submitPaidAcquisition(plan, parsed.request, { provider: receipt.method, reference: receipt.reference,
      credentialHash: hash, receipt: encoded, amountMinor: price.amountMinor, currency: price.currency });
    return accepted({ ...record, cache: "miss" }, payment.withReceipt(dataResponse({ ...record, cache: "miss", paid: true }, 202)));
  } catch {
    return dataResponse({ error: "payment_or_fulfillment_failed", message:
      "Retry with the same credential if payment completed; it recovers the request without a second charge. Otherwise request a new challenge." }, 502);
  }
}
