import { catalog, dataResponse, unavailable } from "../../../../../src/lib/climate-data";
import { idSchema } from "@verdant/contracts";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return dataResponse({ error: "dataset_not_found" }, 404);
  try {
    const dataset = (await catalog()).find(d => d.id === id);
    return dataset ? dataResponse({ dataset }) : dataResponse({ error: "dataset_not_found" }, 404);
  } catch { return unavailable(); }
}
