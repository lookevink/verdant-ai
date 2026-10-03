import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "../../src/lib/mcp";
import { readJsonBody } from "../../src/lib/http";
import { deliveryLimits } from "@verdant/contracts";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const allowedOrigins = ["https://verdant-ai.com", "https://www.verdant-ai.com", "https://docs.verdant-ai.com", "https://api.verdant-ai.com"];
  if (process.env.VERCEL !== "1") allowedOrigins.push("http://localhost:3000", "http://127.0.0.1:3000");
  if (origin && !allowedOrigins.includes(origin)) return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  const parsed = await readJsonBody(request, 32_768);
  if (parsed.response) return parsed.response;
  if (Array.isArray(parsed.body)) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch requests are not supported. Send one bounded operation per request." } }, { status: 400 });
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 32_768 });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody: parsed.body });
    const body = await response.arrayBuffer();
    if (body.byteLength > deliveryLimits.maxResponseBytes)
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Response exceeds the 1 MB limit." } }, { status: 413 });
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(body.byteLength ? body : null, { status: response.status, headers });
  } finally { await server.close(); }
}
export function GET() { return Response.json({ error: "method_not_allowed", message: "Use Streamable HTTP POST; this server has no SSE sessions." }, { status: 405, headers: { Allow: "POST" } }); }
export const DELETE = GET;
