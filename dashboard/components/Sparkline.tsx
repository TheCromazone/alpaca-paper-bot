"use client";

export function Sparkline({
  points,
  color = "var(--cyan)",
  width = 90,
  height = 28,
}: {
  points: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const sx = (i: number) => (i / (points.length - 1)) * width;
  const sy = (v: number) =>
    height - ((v - min) / (max - min || 1)) * (height - 4) - 2;
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${sx(i).toFixed(1)},${sy(p).toFixed(1)}`)
    .join(" ");
  const approxLen = points.length * 8;
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <path
        d={d}
        stroke={color}
        strokeWidth="1.4"
        fill="none"
        className="draw-in"
        style={
          {
            ["--len" as never]: approxLen,
            filter: `drop-shadow(0 0 3px ${color})`,
          } as React.CSSProperties
        }
      />
      <circle
        cx={sx(points.length - 1)}
        cy={sy(points[points.length - 1])}
        r="2.2"
        fill={color}
        style={{ filter: `drop-shadow(0 0 4px ${color})` }}
      />
    </svg>
  );
}

/** Deterministic pseudo-price-path for a leader-board sparkline preview. */
export function genSpark(endPct: number, volatility = 0.02, n = 28): number[] {
  let seed = Math.abs(Math.round(endPct * 10_000)) + 3;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const arr: number[] = [];
  let v = 100;
  for (let i = 0; i < n; i++) {
    v *= 1 + (rnd() - 0.5) * volatility;
    arr.push(v);
  }
  const target = 100 * (1 + endPct);
  const delta = (target - arr[arr.length - 1]) / 6;
  for (let i = n - 6; i < n; i++) arr[i] += delta * (i - (n - 6) + 1);
  return arr;
}
