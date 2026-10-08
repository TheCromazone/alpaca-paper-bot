"use client";

/**
 * Fit-to-whole-rows primitives. Panels on the security screen never cut a row
 * (or a line of prose) in half: the visible window is snapped to the last row
 * that fits completely, and a footer says how much is below ("▼ 4 more") and
 * pages to the first hidden row.
 */
import { Children, isValidElement, useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import s from "./security.module.css";

const FOOT = 22;

/**
 * A vertical list whose visible window always ends on a row boundary.
 * Each child is one row. `unit` names the rows in the footer ("headlines").
 */
export function FitList({
  children,
  unit = "",
  className = "",
  style,
}: {
  children: ReactNode;
  unit?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const rows = Children.toArray(children);
  const rootRef = useRef<HTMLDivElement>(null);
  const scRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ h: number | null; partial: boolean }>({ h: null, partial: false });
  const [below, setBelow] = useState(0);

  const countBelow = useCallback((h: number | null) => {
    const sc = scRef.current;
    const el = contentRef.current;
    if (!sc || !el || h == null) {
      setBelow(0);
      return;
    }
    const edge = sc.getBoundingClientRect().top + h + 0.5;
    let n = 0;
    for (const r of Array.from(el.children) as HTMLElement[]) if (r.getBoundingClientRect().bottom > edge) n++;
    setBelow(n);
  }, []);

  const measure = useCallback(() => {
    const r = rootRef.current;
    const el = contentRef.current;
    if (!r || !el) return;
    const avail = r.clientHeight;
    const kids = Array.from(el.children) as HTMLElement[];
    // Sub-pixel exact bottoms (offsetTop/offsetHeight round, which shaves rows).
    const top0 = el.getBoundingClientRect().top;
    const bottoms = kids.map((k) => k.getBoundingClientRect().bottom - top0);
    const total = bottoms.length ? bottoms[bottoms.length - 1] : 0;
    if (!avail || total <= avail + 0.5) {
      setFit((p) => (p.h === null ? p : { h: null, partial: false }));
      setBelow(0);
      return;
    }
    const lim = avail - FOOT;
    let snapped = 0;
    for (const b of bottoms) {
      if (b <= lim) snapped = b; // exact (fractional) — rounding up would expose a sliver of the next row
      else break;
    }
    // If whole rows would leave most of the panel empty (one very tall row),
    // show the partial row instead — the footer + fade still cue the rest.
    const partial = snapped < lim * 0.55;
    const h = partial ? lim : snapped;
    setFit((p) => (p.h === h && p.partial === partial ? p : { h, partial }));
    countBelow(h);
  }, [countBelow]);

  // ResizeObserver reports once on observe(), so this also does the first measure.
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => measure());
    if (rootRef.current) ro.observe(rootRef.current);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, [measure, rows.length]);

  const overflow = fit.h != null;
  return (
    <div ref={rootRef} className={`${s.fit} ${className}`} style={style}>
      <div
        ref={scRef}
        className={`${s.fitScroll}${fit.partial ? ` ${s.fitFade}` : ""}`}
        style={overflow ? { height: fit.h ?? undefined, flex: "none" } : undefined}
        onScroll={() => countBelow(fit.h)}
      >
        <div ref={contentRef} className={s.fitContent}>
          {rows.map((r, i) => (
            <div key={isValidElement(r) && r.key != null ? r.key : i}>
              {r}
            </div>
          ))}
        </div>
      </div>
      {overflow && (
        <button
          type="button"
          className={s.fitFoot}
          onClick={() => {
            const sc = scRef.current;
            const el = contentRef.current;
            if (!sc || !el) return;
            if (below > 0) {
              // Page to the first row that isn't fully visible, so the view stays row-aligned.
              const box = sc.getBoundingClientRect();
              const next = (Array.from(el.children) as HTMLElement[]).find((r) => r.getBoundingClientRect().bottom > box.top + (fit.h ?? 0) + 0.5);
              if (next) sc.scrollTo({ top: sc.scrollTop + next.getBoundingClientRect().top - box.top, behavior: "smooth" });
            } else sc.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          {below > 0 ? (
            <>
              <span aria-hidden="true">▼</span>
              <span className="num">{below}</span> more{unit ? ` ${unit}` : ""} · scroll
            </>
          ) : (
            <>
              <span aria-hidden="true">▲</span> back to top
            </>
          )}
        </button>
      )}
    </div>
  );
}

/**
 * Prose clamped to whole lines (`lines`, or as many as fit when "fit"), ending
 * in an ellipsis, with a footer that expands it in place.
 */
export function FitLines({ text, lines = 3, lineHeight = 18, className = "" }: { text: string; lines?: number | "fit"; lineHeight?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(typeof lines === "number" ? lines : 3);
  const [clamped, setClamped] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pRef = useRef<HTMLParagraphElement>(null);
  const PAD = 12;
  const measure = useCallback(() => {
    const r = rootRef.current;
    const p = pRef.current;
    if (!r || !p) return;
    let k = typeof lines === "number" ? lines : Math.max(3, Math.floor((r.clientHeight - PAD - FOOT) / lineHeight));
    // Whole text fits without a footer → no clamp at all.
    const full = Math.round(p.scrollHeight / lineHeight);
    if (typeof lines !== "number" && full * lineHeight + PAD <= r.clientHeight) k = full;
    setN(k);
    setClamped(full > k);
  }, [lines, lineHeight]);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => measure());
    if (rootRef.current) ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, [measure, text]);
  return (
    <div ref={rootRef} className={typeof lines === "number" ? s.colAuto : s.fit}>
      <div className={s.fitScroll} style={open ? { overflowY: "auto" } : { overflow: "hidden" }}>
        {/* Padding lives on the wrapper: inside the clamped box it would expose the next line. */}
        <div style={{ padding: `${PAD / 2}px 10px` }}>
          <p
            ref={pRef}
            className={className}
            style={{
              margin: 0,
              lineHeight: `${lineHeight}px`,
              ...(open ? {} : { display: "-webkit-box", WebkitLineClamp: n, WebkitBoxOrient: "vertical" as const, overflow: "hidden", maxHeight: n * lineHeight }),
            }}
          >
            {text}
          </p>
        </div>
      </div>
      {(clamped || open) && (
        <button type="button" className={s.fitFoot} onClick={() => setOpen((o) => !o)}>
          {open ? (
            <>
              <span aria-hidden="true">▲</span> collapse
            </>
          ) : (
            <>
              <span aria-hidden="true">▼</span> read more
            </>
          )}
        </button>
      )}
    </div>
  );
}

/**
 * One line of text truncated at a WORD boundary (never mid-word) to the width
 * it's given, ending in "…"; the full text is the tooltip. Measured with
 * canvas against the element's computed font, re-fitted on resize.
 */
export function WordClamp({ text, className = "", style }: { text: string; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [out, setOut] = useState(text);
  useLayoutEffect(() => {
    const el = ref.current;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!el || !ctx) return;
    const fit = () => {
      const w = el.clientWidth - 2;
      if (w <= 0) return;
      const cs = getComputedStyle(el);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      if (ctx.measureText(text).width <= w) {
        setOut(text);
        return;
      }
      const words = text.split(/\s+/);
      const cut = (k: number) => `${words.slice(0, k).join(" ").replace(/[\s,;:.\-–—(]+$/, "")}…`;
      let lo = 0;
      let hi = words.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(cut(mid)).width <= w) lo = mid;
        else hi = mid - 1;
      }
      setOut(lo ? cut(lo) : "…");
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <span ref={ref} className={className} title={text} style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", minWidth: 0, ...style }}>
      {out}
    </span>
  );
}
