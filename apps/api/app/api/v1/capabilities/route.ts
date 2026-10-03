import { capabilities } from "@verdant/contracts";
import { dataResponse } from "../../../../src/lib/climate-data";
export function GET() { return dataResponse(capabilities); }
