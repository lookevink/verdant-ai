import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Verdant AI", description: "Clean climate data for agents." };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
