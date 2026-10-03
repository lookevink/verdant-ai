import { createDatabaseRpc } from "@verdant/queue";
export type Dataset = { id: string; access_level: "demo" | "paid" | "restricted"; [key: string]: unknown };
export type RasterTile = { id: string; width: number; height: number; cells: (number | null)[];
  variable: string; unit: string; observed_on: string; crs: string; transform: number[]; [key: string]: unknown };
export function climateRpc() {
  const environment = process.env.VERDANT_ENV;
  if (environment !== "sandbox" && environment !== "production") throw new Error("Explicit environment required.");
  const rpc = createDatabaseRpc();
  return (name: string, args: Record<string, unknown> = {}) => rpc(name, { p_environment: environment, ...args });
}
export async function catalog(): Promise<Dataset[]> {
  return await climateRpc()("verdant_catalog") as Dataset[];
}
export async function demoDataset(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return undefined;
  return (await catalog()).find(d => d.id === id && d.access_level === "demo");
}
export function dataResponse(body: unknown, status = 200) {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > 1_000_000) return Response.json({ error: "response_too_large" }, { status: 413 });
  return new Response(encoded, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
export function unavailable() { return dataResponse({ error: "data_service_unavailable" }, 503); }
