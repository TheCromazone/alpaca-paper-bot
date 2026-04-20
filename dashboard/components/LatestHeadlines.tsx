"use client";

import { useQuery } from "@tanstack/react-query";
import { api, NewsRow } from "@/lib/api";
import { fmtTimeAgo } from "@/lib/format";
import { SentimentDot } from "./PnlLabel";

export function LatestHeadlines({ limit = 8 }: { limit?: number }) {
  const { data } = useQuery<NewsRow[]>({
    queryKey: ["news", limit],
    queryFn: () => api.news(limit),
  });
  const news = data ?? [];

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {news.map((n, i) => (
        <li
          key={n.id}
          className="rule-hair rise"
          style={{ padding: "11px 0", animationDelay: `${i * 50}ms` }}
        >
          <a href={n.url} target="_blank" rel="noreferrer">
            <div
              className="mono smallcaps"
              style={{
                fontSize: 10,
                letterSpacing: "0.2em",
                color: "var(--ink-faint)",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <SentimentDot label={n.sentiment_label} />
              <span>{n.source}</span>
              <span>·</span>
              <span>{fmtTimeAgo(n.published_at)}</span>
              {n.vader_score != null && (
                <span
                  style={{
                    marginLeft: "auto",
                    color:
                      n.vader_score > 0
                        ? "var(--gain)"
                        : n.vader_score < 0
                        ? "var(--loss)"
                        : "var(--ink-faint)",
                  }}
                >
                  {n.vader_score >= 0 ? "+" : "−"}
                  {Math.abs(n.vader_score).toFixed(2)}
                </span>
              )}
            </div>
            <div
              style={{
                marginTop: 5,
                fontSize: 14,
                fontWeight: 500,
                lineHeight: 1.4,
                color: "var(--ink)",
                fontFamily: "var(--font-inter), Inter, sans-serif",
              }}
            >
              {n.title}
            </div>
            {n.tickers.length > 0 && (
              <div style={{ marginTop: 7, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {n.tickers.map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}
