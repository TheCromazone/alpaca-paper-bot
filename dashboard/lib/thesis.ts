/**
 * The bot's theses follow a 5-field rubric (memory/playbook.md §1):
 * "Catalyst: … Why mispriced: … Variant view: … Datable catalyst: … Key risk: …".
 * Split one into labeled parts so the UI can render it as a definition list.
 */
const LABELS = [
  "Catalyst",
  "Why mispriced",
  "Why-mispriced",
  "What market is missing",
  "Variant view",
  "Datable catalyst",
  "Datable",
  "Key risk",
  "Reason",
  "Sources",
];

const RX = new RegExp(`(${LABELS.map((l) => l.replace(/-/g, "\\-")).join("|")})\\s*(?:\\([^)]*\\))?:`, "g");

export type ThesisPart = { k: string; v: string };

export function thesisParts(text: string | null | undefined): ThesisPart[] {
  if (!text) return [];
  const idx: { k: string; at: number; end: number }[] = [];
  RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RX.exec(text))) idx.push({ k: m[1].replace("-", " "), at: m.index, end: RX.lastIndex });
  if (!idx.length) return [{ k: "", v: text.trim() }];
  const out: ThesisPart[] = [];
  if (idx[0].at > 0) out.push({ k: "", v: text.slice(0, idx[0].at).trim() });
  idx.forEach((p, i) => out.push({ k: p.k, v: text.slice(p.end, i + 1 < idx.length ? idx[i + 1].at : undefined).trim() }));
  return out.filter((p) => p.v);
}

/** First field's text (usually the catalyst) for one-line previews. */
export function thesisHeadline(text: string | null | undefined, max = 160): string {
  const parts = thesisParts(text);
  const first = parts.find((p) => p.k === "Catalyst") ?? parts[0];
  if (!first) return "";
  return first.v.length > max ? `${first.v.slice(0, max - 1)}…` : first.v;
}
