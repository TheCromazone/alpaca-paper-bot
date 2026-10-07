import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Condensed } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { FnBar, StatusBar, TopBar } from "@/components/term/Shell";

// Two faces, one family: Plex Sans Condensed carries every label and line of
// prose at terminal density; Plex Mono carries every number, ticker and code.
const plexCond = IBM_Plex_Sans_Condensed({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-cond",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cromaz Terminal",
  description:
    "Paper-trading terminal for the Cromaz LLM bot — portfolio, cross-asset monitor, risk guards, insider flow, news and the bot's reasoning.",
  icons: { icon: "/cromaz-logo.png" },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexCond.variable} ${plexMono.variable}`}>
      <body>
        <Providers>
          <div className="term">
            <TopBar />
            <FnBar />
            <main className="term-main">{children}</main>
            <StatusBar />
          </div>
        </Providers>
      </body>
    </html>
  );
}
