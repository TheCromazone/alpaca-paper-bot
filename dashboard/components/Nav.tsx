"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Overview" },
  { href: "/positions", label: "Holdings" },
  { href: "/trades", label: "Trade Journal" },
  { href: "/news", label: "Market Wire" },
  { href: "/signals", label: "Insider Desk" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav
      className="mono smallcaps"
      style={{
        fontSize: 10,
        letterSpacing: "0.25em",
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        marginBottom: 24,
      }}
    >
      {links.map((l) => {
        const active = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`nav-pill${active ? " active" : ""}`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
