import { Playground } from "./playground";
import { pageMetadata } from "../seo";
import "./playground.css";

export const metadata = pageMetadata(
  "Climate & Farm Data Playground",
  "Ask climate and farm data questions in plain language. Verdant's AI analyst gathers evidence and returns sourced answers, charts, methodology and downloadable data.",
  "/playground",
);

export default function Page() {
  return <Playground />;
}
