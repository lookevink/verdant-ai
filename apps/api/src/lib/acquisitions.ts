import { createHash } from "node:crypto";
import { dataRequestStatusSchema, type DataRequest } from "@verdant/contracts";
import { planAcquisition, type AcquisitionPlan } from "@verdant/contracts/acquisition";
import { createDatabaseRpc, queueNamespace } from "@verdant/queue";
import { dataStore } from "./climate-data";
import { resolveData } from "./data-query";

type Accepted = Extract<AcquisitionPlan, { ok: true }>;
const rpc = (name: string, args: Record<string, unknown>) => createDatabaseRpc()(name, { p_namespace: queueNamespace(), ...args });
const requesterHash = (requester: string) => createHash("sha256").update(requester).digest("hex");

/** Submitting is idempotent per target: concurrent identical misses share one acquisition and one pgmq job. */
export async function submitAcquisition(plan: Accepted, request: DataRequest, requester: string) {
  return withLinks(await rpc("verdant_submit_acquisition", { p_coverage_digest: plan.coverageDigest, p_target: plan.target,
    p_request: request, p_requester_hash: requesterHash(requester) }));
}
export type VerifiedPayment = { provider: string; reference: string; credentialHash: string; receipt: string; amountMinor: number; currency: string };
/** Records a provider-verified payment and queues (or joins) the acquisition in one transaction. */
export async function submitPaidAcquisition(plan: Accepted, request: DataRequest, payment: VerifiedPayment) {
  const record = await rpc("verdant_submit_paid_acquisition", { p_coverage_digest: plan.coverageDigest, p_target: plan.target, p_request: request,
    p_requester_hash: requesterHash(`payment:${payment.credentialHash}`), p_provider: payment.provider, p_reference: payment.reference,
    p_credential_hash: payment.credentialHash, p_receipt: payment.receipt, p_amount_minor: payment.amountMinor, p_currency: payment.currency });
  return withLinks(record);
}
/** The request a payment credential already bought, so a retried credential is never charged again. */
export async function paidAcquisition(credentialHash: string) {
  const record = await rpc("verdant_paid_acquisition", { p_credential_hash: credentialHash }) as { receipt?: string } | null;
  return record === null ? null : { record: withLinks(record), receipt: record.receipt ?? null };
}
export async function getAcquisition(id: string) {
  const record = await rpc("verdant_get_acquisition", { p_id: id });
  return record === null ? null : withLinks(record);
}
function withLinks(record: unknown) {
  const { requester_hash: _requester, request: _request, receipt: _receipt, ...value } = record as Record<string, unknown>;
  const links: Record<string, string> = { self: `/api/v1/data/requests/${value.id}` };
  if (value.status === "ready" && typeof value.datasetVersion === "string") {
    links.query = "/api/v1/data/query";
    links.dataset = `/api/v1/datasets/${value.datasetVersion}`;
  }
  return dataRequestStatusSchema.parse({ ...value, links });
}
export type AcquisitionRecord = ReturnType<typeof withLinks>;

export type Preparation =
  | { kind: "ready"; status: 200; body: { status: "ready"; cache: "hit"; datasetVersion: string; rowCount: number; links: Record<string, string> } }
  | { kind: "rejected"; status: 413 | 422; body: { error: string; message: string } }
  | { kind: "existing"; status: 200 | 202; body: AcquisitionRecord & { cache: "miss" } }
  | { kind: "acquire"; plan: Accepted };
/**
 * Shared by REST and MCP. Published coverage is free; an identical acquisition that is running (or failed
 * within the cooldown) is returned without charge. Only a genuinely new acquisition needs payment.
 */
export async function prepareDataRequest(request: DataRequest): Promise<Preparation> {
  const resolution = await resolveData(request, dataStore);
  if (resolution.available) return { kind: "ready", status: 200, body: { status: "ready", cache: "hit", datasetVersion: resolution.selection!.datasetVersion,
    rowCount: resolution.selection!.rowCount, links: { query: "/api/v1/data/query", dataset: `/api/v1/datasets/${resolution.selection!.datasetVersion}` } } };
  const plan = planAcquisition(request);
  if (!plan.ok) return { kind: "rejected", status: plan.reason === "request_too_large" ? 413 : 422, body: { error: plan.reason, message: plan.message } };
  const existing = await rpc("verdant_find_acquisition", { p_coverage_digest: plan.coverageDigest });
  if (existing) {
    const record = withLinks(existing);
    return { kind: "existing", status: ["ready", "failed"].includes(record.status) ? 200 : 202, body: { ...record, cache: "miss" } };
  }
  return { kind: "acquire", plan };
}
export function chargeOptions(plan: Accepted, price: { amount: string }) {
  const t = plan.target;
  return { amount: price.amount, scope: `verdant-acquisition:${plan.coverageDigest}`, meta: { coverageDigest: plan.coverageDigest },
    description: `Verdant data acquisition: ${t.source} ${t.variable} ${t.period.start}–${t.period.end}, ${t.window.width}×${t.window.height} cells` };
}

/** Failed paid acquisitions; refunded by the API, which alone holds payment credentials. */
export async function refundCandidates() {
  return await rpc("verdant_refund_candidates", { p_limit: 20 }) as { paymentId: string; provider: string; reference: string; amountMinor: number;
    currency: string; acquisitionId: string; reason: string | null }[];
}
export async function recordRefund(paymentId: string, status: "refund_pending" | "refunded" | "reconciliation_required", details: Record<string, unknown>) {
  return await rpc("verdant_record_refund", { p_payment_id: paymentId, p_status: status, p_details: details }) === true;
}
