"use client";

import { useQuery } from "@tanstack/react-query";
import { api, NewsRow } from "@/lib/api";
import { SectionHead } from "@/components/SectionHead";
import { SentimentDot } from "@/components/PnlLabel";
import { fmtTimeAgo } from "@/lib/format";

export default function NewsPage() {
  const { data } = useQuery<NewsRow[]>({
    queryKey: ["news", 100],
    queryFn: () => api.news(100),
  });
  const news = data ?? [];

  return (
    <div className="pt-6">
      <SectionHead
        eyebrow="The Market Wire"
        title="What the wires are saying"
        right={<span>{news.length} headlines · refreshed every 5 min</span>}
      />

      <div className="grid grid-cols-12 gap-6 md:gap-10">
        <div className="col-span-12 lg:col-span-8 rule-top pt-2">
          {news.length === 0 && (
            <p className="py-12 text-center text-ink-faint italic">No news yet.</p>
          )}
          {news.map((n, i) => (
            <article key={n.id} className="py-5 rule-hair">
              {i === 0 ? (
                <>
                  <div className="smallcaps mono text-[10px] tracking-[0.3em] text-ink-faint flex items-center gap-2 mb-1">
                    <SentimentDot label={n.sentiment_label} />
                    <span>{n.source}</span>
                    <span>·</span>
                    <span>{fmtTimeAgo(n.published_at)}</span>
                  </div>
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block display text-3xl md:text-4xl leading-[1.05] tracking-tight font-semibold"
                  >
                    {n.title}
                  </a>
                  {n.summary && (
                    <p className="max-w-[72ch] mt-2 text-[15px] leading-relaxed text-ink-muted italic">
                      {n.summary}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="smallcaps mono text-[10px] tracking-[0.25em] text-ink-faint flex items-center gap-2 mb-1">
                    <SentimentDot label={n.sentiment_label} />
                    <span>{n.source}</span>
                    <span>·</span>
                    <span>{fmtTimeAgo(n.published_at)}</span>
                  </div>
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-[17px] leading-snug font-medium"
                  >
                    {n.title}
                  </a>
                </>
              )}
              {n.tickers.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2 mono text-[10px]">
                  {n.tickers.map((t) => (
                    <a
                      key={t}
                      href={`/news?ticker=${t}`}
                      className="px-[6px] py-[1px] border border-rule-hair text-ink-muted hover:border-ink hover:text-ink"
                    >
                      {t}
                    </a>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>

        <aside className="col-span-12 lg:col-span-4 lg:pl-6 lg:border-l lg:border-rule-hair">
          <SectionHead eyebrow="Sentiment tally" title="Today's mood" />
          <Tally news={news} />
        </aside>
      </div>
    </div>
  );
}

function Tally({ news }: { news: NewsRow[] }) {
  const counts = { positive: 0, neutral: 0, negative: 0 };
  news.forEach((n) => {
    counts[n.sentiment_label]++;
  });
  const total = Math.max(1, news.length);
  const Bar = ({ label, count, color }: { label: string; count: number; color: string }) => (
    <li className="mb-3">
      <div className="flex justify-between mono text-[11px] text-ink-muted mb-1">
        <span className="smallcaps tracking-[0.2em]">{label}</span>
        <span>
          {count} <span className="text-ink-faint">· {((count / total) * 100).toFixed(0)}%</span>
        </span>
      </div>
      <div className="h-[6px] w-full bg-paper-deep border border-rule-hair relative">
        <div
          className="absolute top-0 left-0 h-full"
          style={{ width: `${(count / total) * 100}%`, background: color }}
        />
      </div>
    </li>
  );
  return (
    <ul>
      <Bar label="Positive" count={counts.positive} color="#1f4d2e" />
      <Bar label="Neutral" count={counts.neutral} color="#8a8175" />
      <Bar label="Negative" count={counts.negative} color="#7a1616" />
    </ul>
  );
}
