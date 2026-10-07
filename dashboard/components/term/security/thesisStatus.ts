/**
 * Is the bot's thesis for this name still live? Best-effort parse of the
 * "Datable catalyst" field ("late-July earnings window", "Jul 15 pre-market",
 * "2026-07-16", "Jun 17 FOMC/SEP, then late-July earnings…") into the LAST
 * date it names, plus the bot's activity state from /bot/status.
 */
import type { BotStatus, SecurityResp } from "@/lib/api";
import { thesisParts } from "@/lib/thesis";
import { MONTHS, dayNum, etDate, fmtD } from "./util";

const MONTH_RX = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthIdx = (m: string) => MONTHS.findIndex((x) => x.toLowerCase() === m.slice(0, 3).toLowerCase());

type Hit = { day: string; label: string };

function iso(y: number, m: number, d: number) {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Every date-ish mention in `text`, resolved against the decision date. */
export function catalystDates(text: string, decidedOn: string): Hit[] {
  const [dy, dm] = decidedOn.split("-").map(Number);
  // A month earlier than the decision month by > 2 means next year ("Jan" written in Nov).
  const yearFor = (m: number) => (m + 1 < dm - 2 ? dy + 1 : dy);
  const hits: Hit[] = [];
  for (const m of text.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) hits.push({ day: `${m[1]}-${m[2]}-${m[3]}`, label: m[0] });
  const rxPart = new RegExp(`\\b(early|mid|late|end[- ]of)[- ]?${MONTH_RX}\\b`, "gi");
  for (const m of text.matchAll(rxPart)) {
    const mi = monthIdx(m[2]);
    const part = m[1].toLowerCase();
    const d = part === "early" ? 10 : part === "mid" ? 20 : 31;
    hits.push({ day: iso(yearFor(mi), mi, d), label: m[0] });
  }
  const rxDay = new RegExp(`\\b${MONTH_RX}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?\\b`, "gi");
  for (const m of text.matchAll(rxDay)) {
    const mi = monthIdx(m[1]);
    const y = m[3] ? Number(m[3]) : yearFor(mi);
    hits.push({ day: iso(y, mi, Number(m[2])), label: m[0] });
  }
  if (!hits.length) {
    // Bare month ("July earnings") → end of that month.
    for (const m of text.matchAll(new RegExp(`\\b${MONTH_RX}\\b`, "gi"))) {
      const mi = monthIdx(m[1]);
      hits.push({ day: iso(yearFor(mi), mi, 31), label: m[0] });
    }
  }
  return hits;
}

export type ThesisState = {
  /** Collapse the reasoning by default. */
  expired: boolean;
  /** Latest catalyst date the live theses name, and the phrase it came from. */
  catalyst: Hit | null;
  catalystPassed: boolean;
  botActive: boolean;
  botOffDays: number | null;
  routinesEnabled: boolean | null;
  /** One-line summary, e.g. "Thesis catalyst passed (late-July) · bot off 79d". */
  line: string;
};

export function thesisState(data: SecurityResp, bot: BotStatus | undefined, now: number): ThesisState | null {
  if (!data.decisions.length || !now) return null;
  const today = etDate(new Date(now).toISOString());
  // The theses that matter: buys since the last sell (the live position's rationale).
  const lastSell = data.decisions.find((d) => d.action.includes("sell"));
  const live = data.decisions.filter((d) => d.action.includes("buy") && (!lastSell || d.at > lastSell.at));
  const pool = live.length ? live : data.decisions.slice(0, 1);
  let catalyst: Hit | null = null;
  for (const d of pool) {
    const parts = thesisParts(d.reason);
    const field = parts.find((p) => p.k === "Datable catalyst")?.v ?? parts.find((p) => p.k === "Catalyst")?.v ?? d.reason;
    for (const h of catalystDates(field, etDate(d.at))) if (!catalyst || h.day > catalyst.day) catalyst = h;
  }
  const catalystPassed = !!catalyst && dayNum(catalyst.day) < dayNum(today);
  const run = bot?.last_llm_run;
  const botOffDays = run ? Math.floor((now - new Date(run.started_at).getTime()) / 86_400_000) : null;
  const botActive = bot?.active ?? true;
  const parts: string[] = [];
  const exited = !data.position && !!lastSell;
  if (exited) parts.push(`Position exited ${fmtD(etDate(lastSell!.at), "dmy")}`);
  else if (catalystPassed) parts.push(`Thesis catalyst passed (${catalyst!.label})`);
  if (!botActive) parts.push(bot?.routines_enabled === false && botOffDays == null ? "bot off" : `bot off ${botOffDays ?? "?"}d`);
  return {
    expired: exited || catalystPassed || !botActive,
    catalyst,
    catalystPassed,
    botActive,
    botOffDays,
    routinesEnabled: bot?.routines_enabled ?? null,
    line: parts.join(" · ") || "Thesis live",
  };
}
