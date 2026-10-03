import { SourceError, type SourceAdapter } from "./types";
import { silo } from "./silo";
import { cpc } from "./cpc";
import { nclimgrid } from "./nclimgrid";

const adapters: Record<string, SourceAdapter> = { silo, nclimgrid, cpc };
export function adapterFor(source: string): SourceAdapter {
  const adapter = adapters[source];
  if (!adapter) throw new SourceError(`No adapter for source ${source}.`, true);
  return adapter;
}
