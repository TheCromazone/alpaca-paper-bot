import type { Metadata } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { TickerStrip } from "@/components/TickerStrip";
import { Masthead } from "@/components/Masthead";
import { Nav } from "@/components/Nav";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  weight: ["400", "500", "600", "700", "900"],
  style: ["normal", "italic"],
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "The Ledger — Paper Trading Terminal",
  description:
    "Live portfolio terminal with trade rationale, signals, and news sentiment.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${inter.variable} ${jetbrains.variable}`}
    >
      <body className="antialiased">
        <div className="scanline" aria-hidden="true" />
        <Providers>
          <TickerStrip />
          <div className="page">
            <Masthead />
            <Nav />
            <main>{children}</main>
            <footer className="mono smallcaps rule-top" style={{
              fontSize: 10,
              letterSpacing: "0.2em",
              color: "var(--ink-faint)",
              paddingTop: 16,
              marginTop: 48,
            }}>
              <span>Local paper account &middot; data cached 30s &middot; no financial advice &middot; est. 2026</span>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
