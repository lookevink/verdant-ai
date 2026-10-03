import { createHash } from "node:crypto";
import { dataRequestStatusSchema, type DataRequest } from "@verdant/contracts";
import type { AcquisitionPlan } from "@verdant/contracts/acquisition";
import { createDatabaseRpc, queueNamespace } from "@verdant/queue";

type Accepted = Extract<AcquisitionPlan, { ok: true }>;
/** Submitting is idempotent per target: concurrent identical misses share one acquisition and one pgmq job. */
export async function submitAcquisition(plan: Accepted, request: DataRequest, requester: string) {
  const record = await createDatabaseRpc()("verdant_submit_acquisition", { p_namespace: queueNamespace(),
    p_coverage_digest: plan.coverageDigest, p_target: plan.target, p_request: request,
    p_requester_hash: createHash("sha256").update(requester).digest("hex") });
  return withLinks(record);
}
export async function getAcquisition(id: string) {
  const record = await createDatabaseRpc()("verdant_get_acquisition", { p_namespace: queueNamespace(), p_id: id });
  return record === null ? null : withLinks(record);
}
function withLinks(record: unknown) {
  const { requester_hash: _requester, request: _request, ...value } = record as Record<string, unknown>;
  const links: Record<string, string> = { self: `/api/v1/data/requests/${value.id}` };
  if (value.status === "ready" && typeof value.datasetVersion === "string") {
    links.query = "/api/v1/data/query";
    links.dataset = `/api/v1/datasets/${value.datasetVersion}`;
  }
  return dataRequestStatusSchema.parse({ ...value, links });
}
