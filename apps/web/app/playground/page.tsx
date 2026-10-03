import type { Metadata } from "next";
import { Playground } from "./playground";
import "./playground.css";

export const metadata: Metadata = {
  title: "Playground · Verdant AI",
  description: "Ask questions in plain language; Verdant's analyst gathers the evidence, documents its methodology and answers with charts.",
};

export default function Page() {
  return <Playground />;
}
