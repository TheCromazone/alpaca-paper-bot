"use client";

import { useEffect, useRef } from "react";

/**
 * Scroll-entrance wrapper. Renders children hidden per the [data-fx] CSS in
 * globals.css, then sets data-in the first time the element intersects the
 * viewport — the CSS transition does the rest. One-shot: the observer
 * disconnects after firing so entrances never replay while polling re-renders.
 *
 * fx values (see design/compiled-spec.md): "clip-up" | "slide-l" | "slide-r"
 * | "blur-in" | "reel" (staggers .reel-frame children via --i).
 */
export function Reveal({
  fx,
  delay = 0,
  className,
  style,
  children,
}: {
  fx: "clip-up" | "slide-l" | "slide-r" | "blur-in" | "reel";
  /** transition-delay in ms, applied via the --d custom property */
  delay?: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const show = () => el.setAttribute("data-in", "true");
    if (typeof IntersectionObserver === "undefined") {
      show();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          // Reveal on intersect, or if the viewport has already jumped past
          // the element (End key / anchor jump) so content is never stranded
          // invisible above the fold.
          if (e.isIntersecting || e.boundingClientRect.bottom < 0) {
            show();
            io.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    io.observe(el);
    // The initial IO entry at mount can report non-intersecting for elements
    // already in the viewport (observed in Chrome during hydration), which
    // would leave above-the-fold acts hidden until the first scroll. Check
    // the bounding box on the next frame and reveal directly if visible.
    const raf = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight - 40) {
        show();
        io.disconnect();
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      data-fx={fx}
      className={className}
      style={
        delay
          ? ({ ...style, ["--d" as never]: `${delay}ms` } as React.CSSProperties)
          : style
      }
    >
      {children}
    </div>
  );
}
