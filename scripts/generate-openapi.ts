import { mkdir, readFile, writeFile } from "node:fs/promises";
import { openapi } from "../packages/contracts/src/openapi.js";
const filename = new URL("../docs/openapi.json", import.meta.url);
const serialized = JSON.stringify(openapi, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (await readFile(filename, "utf8") !== serialized) throw new Error("OpenAPI drift: run pnpm docs:generate and commit docs/openapi.json.");
  console.log("OpenAPI matches the runtime contract.");
} else {
  await mkdir(new URL("../docs/", import.meta.url), { recursive: true });
  await writeFile(filename, serialized);
  console.log("Generated docs/openapi.json from the runtime schemas.");
}
