export function SectionHead({
  eyebrow,
  title,
  right,
}: {
  eyebrow?: string;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div
      className="rule-bot"
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 16,
        paddingBottom: 10,
        marginBottom: 18,
      }}
    >
      <div>
        {eyebrow && (
          <div
            className="mono smallcaps"
            style={{
              fontSize: 10,
              letterSpacing: "0.25em",
              color: "var(--cyan)",
              marginBottom: 6,
            }}
          >
            <span className="accent-bar" />
            {eyebrow}
          </div>
        )}
        <h2
          className="display"
          style={{
            margin: 0,
            fontSize: "clamp(20px, 2vw, 28px)",
            fontWeight: 600,
            lineHeight: 1,
          }}
        >
          {title}
        </h2>
      </div>
      {right && (
        <div className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
          {right}
        </div>
      )}
    </div>
  );
}
