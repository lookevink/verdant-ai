export function GET() { return Response.json({ version: "1.0.0", transport: "http", url: "https://api.verdant-ai.com/mcp",
  servers: [{ name: "verdant-climate-data", url: "https://api.verdant-ai.com/mcp", transport: "http", authentication: "none" }],
}, { headers: { "Cache-Control": "public, max-age=300" } }); }
