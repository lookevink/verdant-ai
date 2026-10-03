import type { Metadata, Viewport } from "next";
import { Inter_Tight, Instrument_Serif } from "next/font/google";
import { phaseScript } from "./phase";
import "./globals.css";

const sans = Inter_Tight({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: "italic", variable: "--font-serif", display: "swap" });

export const metadata: Metadata = { title: "Verdant AI", description: "Clean climate data for agents." };
export const viewport: Viewport = { themeColor: "#e8f6e4", colorScheme: "light" };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The phase script sets data-phase before hydration, so the attribute is expected to differ from the server render.
  return <html lang="en" className={`${sans.variable} ${serif.variable}`} suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: phaseScript }} /></head>
    <body>{children}</body>
  </html>;
}
