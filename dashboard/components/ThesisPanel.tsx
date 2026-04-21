"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, MemoryDoc } from "@/lib/api";
import { SectionHead } from "./SectionHead";

/**
 * Renders the latest day's `## YYYY-MM-DD` block from `memory/research_log.md`.
 * Splits on top-level headers and picks the most recent one. If the research
 * log is still empty (first-run state), shows a placeholder that explains
 * where the thesis comes from so the reader isn't staring at an empty panel.
 */
export function ThesisPanel() {
  const { data, isLoading } = useQuery<MemoryDoc>({
    queryKey: ["memory", "research_log"],
    queryFn: () => api.memory("research_log"),
    refetchInterval: 60_000,
  });

  const latest = useMemo(() => extractLatestDay(data?.content ?? ""), [data]);

  return (
    <article style={{ minWidth: 0 }}>
      <SectionHead
        eyebrow="Today's Thesis"
        title={latest?.date ?? "No thesis yet"}
        right={
          data?.updated_at ? (
            <span>
              research_log · {new Date(data.updated_at).toLocaleString("en-US", {
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
        <p
          style={{
            color: "var(--ink-muted)",
            lineHeight: 1.55,
            maxWidth: "68ch",
          }}
        >
          The pre-market routine runs at 07:00 ET and writes 2–3 catalyst-driven
          trade ideas here. Once it fires, you&apos;ll see today&apos;s
          headlines + theses here, and the execute routine will act on them at
          market open.
        </p>
      ) : (
        <div style={{ lineHeight: 1.55, maxWidth: "72ch" }}>
          {latest.sections.map((s) => (
            <div key={s.heading} style={{ marginBottom: 14 }}>
              <div
                className="mono smallcaps"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.25em",
                  color: "var(--violet)",
                  marginBottom: 4,
                }}
              >
                {s.heading}
              </div>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  fontSize: 14,
                  color: "var(--ink)",
                }}
              >
                {s.body}
              </pre>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * Parser for the research_log.md format.
 *
 *   ## 2026-04-21
 *   ### Pre-market
 *   - idea 1 ...
 *   - idea 2 ...
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
  let collected: { date: string; body: string }[] = [];
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
  // Newest by ISO date sort.
  collected.sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = collected[0];

  // Split the body on `### ` subheadings.
  const sections: { heading: string; body: string }[] = [];
  const subSplit = latest.body.split(/^###\s+/m).map((s) => s.trimEnd());
  // First chunk before any ### is top-level chatter (rare); attribute to "Notes".
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
