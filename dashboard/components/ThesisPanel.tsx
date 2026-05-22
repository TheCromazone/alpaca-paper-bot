"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, MemoryDoc } from "@/lib/api";
import { SectionHead } from "./SectionHead";

/**
 * Renders the latest day's `## YYYY-MM-DD` block from `memory/research_log.md`
 * as a 2-column grid of subsections, each with its own emerald accent-bar
 * heading and a staggered rise animation. Matches the Cromaz design's
 * `ThesisPanel` layout — the panel itself is the emerald-edged glass card,
 * sections sit inside on a 2-column grid.
 */
export function ThesisPanel() {
  const { data, isLoading } = useQuery<MemoryDoc>({
    queryKey: ["memory", "research_log"],
    queryFn: () => api.memory("research_log"),
    refetchInterval: 60_000,
  });

  const latest = useMemo(() => extractLatestDay(data?.content ?? ""), [data]);

  // Pretty date label: "Friday, May 1" — same format as the design.
  const dateLabel = latest
    ? new Date(latest.date + "T12:00:00Z").toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : "No thesis yet";

  return (
    <article style={{ minWidth: 0 }}>
      <SectionHead
        eyebrow="Today's thesis"
        title={dateLabel}
        right={
          data?.updated_at ? (
            <span>
              research_log ·{" "}
              {new Date(data.updated_at).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hour12: false,
              })}
            </span>
          ) : (
            <span>research_log</span>
          )
        }
      />

      {isLoading ? (
        <p style={{ color: "var(--ink-muted)", fontStyle: "italic" }}>Loading…</p>
      ) : !latest ? (
        <div
          className="panel rise"
          style={{
            padding: "26px 30px",
            color: "var(--ink-muted)",
            fontSize: 14,
            lineHeight: 1.65,
            maxWidth: "72ch",
          }}
        >
          The pre-market routine runs at 07:00 ET and writes 2–3 catalyst-driven
          trade ideas here. Once it fires, you&apos;ll see today&apos;s headlines
          + theses here, and the execute routine will act on them at market open.
        </div>
      ) : (
        <div
          className="panel rise"
          style={{
            padding: "26px 30px",
            display: "grid",
            // Single column when only one section, otherwise 2-column.
            gridTemplateColumns:
              latest.sections.length > 1 ? "repeat(2, 1fr)" : "1fr",
            gap: 36,
          }}
        >
          {latest.sections.map((s, i) => (
            <div
              key={s.heading}
              style={{
                animation: "rise 700ms cubic-bezier(0.2,0.7,0.2,1) both",
                animationDelay: `${i * 120}ms`,
                minWidth: 0,
              }}
            >
              <div
                className="mono smallcaps"
                style={{
                  fontSize: 11,
                  letterSpacing: "0.25em",
                  color: "var(--emerald)",
                  marginBottom: 12,
                }}
              >
                <span className="accent-bar" />
                {s.heading}
              </div>
              <ThesisBody body={s.body} />
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * Renders a thesis subsection's markdown body as readable prose.
 *
 * The previous version dumped everything into a `<pre>` with JetBrains Mono at
 * 12.5px — a wall of monospace text that was technically accurate to the file
 * but unreadable at a glance. This renderer:
 *  - turns `- ` / `* ` / `1. ` lines into a real <ul>/<ol> with proper indent
 *  - bolds inline `**text**`
 *  - highlights stand-alone $TICKER tokens in emerald (the ticker is what you
 *    actually scan for)
 *  - groups blank-line-separated chunks into <p> blocks with breathing room
 *  - uses Inter at 14px / line-height 1.65 — same family as body copy
 */
function ThesisBody({ body }: { body: string }) {
  // Group lines into paragraphs / lists. A blank line breaks a block.
  const blocks: { kind: "p" | "ul" | "ol"; lines: string[] }[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      blocks.push({ kind: "p", lines: [] });
      continue;
    }
    const isUL = /^\s*[-*]\s+/.test(line);
    const isOL = /^\s*\d+[.)]\s+/.test(line);
    const targetKind = isUL ? "ul" : isOL ? "ol" : "p";
    const last = blocks[blocks.length - 1];
    if (last && last.kind === targetKind && last.lines.length > 0) {
      last.lines.push(line);
    } else {
      blocks.push({ kind: targetKind, lines: [line] });
    }
  }

  const inline = (s: string, keyBase: string): React.ReactNode[] => {
    // **bold** + $TICKER + plain
    const out: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|\$[A-Z]{1,5}\b)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith("**")) {
        out.push(
          <strong key={`${keyBase}-b-${i++}`} style={{ color: "var(--ink)", fontWeight: 700 }}>
            {tok.slice(2, -2)}
          </strong>,
        );
      } else {
        out.push(
          <span
            key={`${keyBase}-t-${i++}`}
            className="mono"
            style={{
              color: "var(--emerald)",
              fontWeight: 600,
              padding: "0 2px",
            }}
          >
            {tok}
          </span>,
        );
      }
      last = m.index + tok.length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };

  return (
    <div
      style={{
        fontFamily: "var(--font-inter), Inter, sans-serif",
        fontSize: 14,
        lineHeight: 1.65,
        color: "var(--ink)",
      }}
    >
      {blocks.map((b, i) => {
        if (b.lines.length === 0) return null;
        if (b.kind === "ul" || b.kind === "ol") {
          const Tag = b.kind === "ul" ? "ul" : "ol";
          return (
            <Tag
              key={i}
              style={{
                margin: "0 0 14px",
                paddingLeft: 22,
                listStyleType: b.kind === "ul" ? "none" : "decimal",
              }}
            >
              {b.lines.map((ln, j) => {
                const stripped = ln.replace(/^\s*([-*]|\d+[.)])\s+/, "");
                return (
                  <li
                    key={j}
                    style={{
                      position: "relative",
                      marginBottom: 7,
                      paddingLeft: b.kind === "ul" ? 4 : 0,
                    }}
                  >
                    {b.kind === "ul" && (
                      <span
                        aria-hidden
                        style={{
                          position: "absolute",
                          left: -16,
                          top: 8,
                          width: 6,
                          height: 6,
                          background: "var(--emerald)",
                          boxShadow: "0 0 6px var(--emerald-glow)",
                          borderRadius: 1,
                          transform: "rotate(45deg)",
                        }}
                      />
                    )}
                    {inline(stripped, `${i}-${j}`)}
                  </li>
                );
              })}
            </Tag>
          );
        }
        // Plain paragraph — collapse internal newlines to spaces, normalize whitespace.
        const text = b.lines.join(" ").replace(/\s+/g, " ").trim();
        if (!text) return null;
        return (
          <p key={i} style={{ margin: "0 0 14px" }}>
            {inline(text, `${i}-p`)}
          </p>
        );
      })}
    </div>
  );
}

/**
 * Parser for the research_log.md format.
 *
 *   ## 2026-04-21
 *   ### Pre-market
 *   - idea 1 ...
 *   ### Execute
 *   ...
 *
 * Returns the most recent `## YYYY-MM-DD` block split into its `### Subsection`
 * bullets. If the file has no dated header yet, returns null.
 */
function extractLatestDay(
  md: string
): { date: string; sections: { heading: string; body: string }[] } | null {
  if (!md.trim()) return null;
  const lines = md.split(/\r?\n/);
  let currentDate: string | null = null;
  const collected: { date: string; body: string }[] = [];
  let buf: string[] = [];

  const flush = () => {
    if (currentDate !== null) {
      collected.push({ date: currentDate, body: buf.join("\n").trim() });
    }
  };

  for (const line of lines) {
    const dateMatch = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (dateMatch) {
      flush();
      currentDate = dateMatch[1];
      buf = [];
    } else if (currentDate !== null) {
      buf.push(line);
    }
  }
  flush();

  if (!collected.length) return null;
  collected.sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = collected[0];

  const sections: { heading: string; body: string }[] = [];
  const subSplit = latest.body.split(/^###\s+/m).map((s) => s.trimEnd());
  if (subSplit[0].trim()) {
    sections.push({ heading: "Notes", body: subSplit[0].trim() });
  }
  for (let i = 1; i < subSplit.length; i++) {
    const block = subSplit[i];
    const firstLineEnd = block.indexOf("\n");
    const heading = (firstLineEnd === -1 ? block : block.slice(0, firstLineEnd)).trim();
    const body = firstLineEnd === -1 ? "" : block.slice(firstLineEnd + 1).trim();
    sections.push({ heading, body });
  }

  return { date: latest.date, sections };
}
