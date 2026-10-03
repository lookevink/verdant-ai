import { readFile } from "node:fs/promises";
import { dataRequestSchema } from "@verdant/contracts";

// Read this app's environment only. Never load the API's database secret.
try { process.loadEnvFile(".env.local"); } catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

if (process.argv.includes("--check")) {
  const required = ["VERDANT_API_URL", "VERDANT_WORKER_TOKEN", "ANTHROPIC_API_KEY", "PI_MODEL"];
  const missing = required.filter(key => !process.env[key]?.trim());
  console.log(JSON.stringify({
    service: "verdant-worker", configurationReady: missing.length === 0,
    missing, acquisitionImplemented: false,
    message: "Worker foundation only. Job claiming, Pi execution and upload are the next integration.",
  }, null, 2));
  if (missing.length) process.exitCode = 1;
} else if (process.argv.includes("--validate")) {
  const path = process.argv[process.argv.indexOf("--validate") + 1];
  if (!path) throw new Error("Supply a path after --validate.");
  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  console.log(JSON.stringify(dataRequestSchema.parse(input), null, 2));
} else {
  console.error("Use --check or --validate <request.json>. Acquisition is not connected yet.");
  process.exitCode = 1;
}
