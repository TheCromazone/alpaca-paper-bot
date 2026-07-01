export function SectionHead({
  eyebrow,
  title,
  right,
  scene,
}: {
  eyebrow?: string;
  title: string;
  right?: React.ReactNode;
  /** Act number ("01"…"05") — renders the cinematic scene marker chip. */
  scene?: string;
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
              color: "var(--emerald)",
              marginBottom: 6,
            }}
          >
            {scene && <span className="scene-no">ACT {scene}</span>}
            <span className="accent-bar" />
            {eyebrow}
          </div>
        )}
        <h2
          className="display wipe"
          style={{
            margin: 0,
            fontSize: "clamp(18px, 1.7vw, 24px)",
            fontWeight: 600,
            lineHeight: 1,
            color: "var(--ink)",
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
