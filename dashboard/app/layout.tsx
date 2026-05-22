import type { Metadata } from "next";
import { Cinzel, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { TickerStrip } from "@/components/TickerStrip";
import { Masthead } from "@/components/Masthead";
import { Nav } from "@/components/Nav";

// Cinzel: serif display face used for the CROMAZ wordmark + every section
// title. Replaces the old Fraunces — Cinzel's Roman-monumental shapes pair
// better with the chrome-shimmer treatment.
const cinzel = Cinzel({
  subsets: ["latin"],
  variable: "--font-cinzel",
  weight: ["500", "600", "700", "800"],
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cromaz — Trading Bot Investments",
  description:
    "Live paper-trading terminal: portfolio, signals, news sentiment, LLM-driven swing routines.",
  icons: { icon: "/cromaz-logo.png" },
};

/**
 * Decorative SVG that lives in the page-level fixed layer behind everything.
 * Pure ambient — no data, no interactivity. Lifted from the design's
 * `<svg class="ambient-candles">` block.
 */
function AmbientCandles() {
  return (
    <svg
      className="ambient-candles"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <pattern id="cdl" x="0" y="0" width="180" height="180" patternUnits="userSpaceOnUse">
          <rect x="20" y="50" width="3" height="60" fill="oklch(72% 0.22 148)" />
          <rect x="14" y="60" width="15" height="34" fill="oklch(72% 0.22 148)" opacity="0.7" />
          <rect x="62" y="40" width="3" height="80" fill="#9aa3ad" />
          <rect x="56" y="60" width="15" height="40" fill="#9aa3ad" opacity="0.5" />
          <rect x="110" y="70" width="3" height="60" fill="oklch(68% 0.22 22)" />
          <rect x="104" y="80" width="15" height="34" fill="oklch(68% 0.22 22)" opacity="0.6" />
          <rect x="150" y="30" width="3" height="80" fill="oklch(72% 0.22 148)" />
          <rect x="144" y="50" width="15" height="40" fill="oklch(72% 0.22 148)" opacity="0.7" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#cdl)" />
    </svg>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${cinzel.variable} ${inter.variable} ${jetbrains.variable}`}
    >
      <body className="antialiased">
        <div className="scanline" aria-hidden="true" />
        <AmbientCandles />
        <Providers>
          <TickerStrip />
          <div className="page">
            <Masthead />
            <Nav />
            <main>{children}</main>
            <footer
              className="mono smallcaps rule-top"
              style={{
                fontSize: 10,
                letterSpacing: "0.2em",
                color: "var(--ink-faint)",
                paddingTop: 16,
                marginTop: 48,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 12,
              }}
            >
              <span>
                Cromaz · Paper Account · cached 30s · not financial advice
              </span>
              <span style={{ color: "var(--emerald)" }}>
                Invest Smart. Grow Strong.
              </span>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
