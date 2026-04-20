export function PnlLabel({
  value,
  children,
  className = "",
}: {
  value: number;
  children: React.ReactNode;
  className?: string;
}) {
  const color =
    value > 0 ? "var(--gain)" : value < 0 ? "var(--loss)" : "var(--ink-muted)";
  const glow =
    value > 0
      ? "0 0 12px var(--gain-glow)"
      : value < 0
      ? "0 0 12px var(--loss-glow)"
      : "none";
  return (
    <span
      className={className}
      style={{ color, textShadow: glow, fontWeight: 500 }}
    >
      {children}
    </span>
  );
}

export function SentimentDot({
  label,
}: {
  label: "positive" | "neutral" | "negative";
}) {
  const color =
    label === "positive"
      ? "var(--gain)"
      : label === "negative"
      ? "var(--loss)"
      : "var(--ink-faint)";
  const glow =
    label === "positive"
      ? "var(--gain-glow)"
      : label === "negative"
      ? "var(--loss-glow)"
      : "transparent";
  return (
    <span
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 6px ${glow}`,
        marginRight: 6,
      }}
    />
  );
}

export function LiveDot({
  on,
  color = "var(--loss)",
}: {
  on: boolean;
  color?: string;
}) {
  return (
    <span style={{ position: "relative", display: "inline-block", width: 10, height: 10 }}>
      <span
        className={on ? "pulse-dot" : ""}
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: on ? color : "var(--ink-faint)",
          boxShadow: on ? `0 0 10px ${color}` : "none",
        }}
      />
      {on && (
        <span
          className="pulse-ring"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: `2px solid ${color}`,
          }}
        />
      )}
    </span>
  );
}
