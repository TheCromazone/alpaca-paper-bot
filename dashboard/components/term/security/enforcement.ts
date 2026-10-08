/**
 * Who actually acts on a position's exit levels — the ONE source the POS panel
 * (header chip, banner, guard rows) and the GP chart (inactive styling) read.
 *
 * Mirrors the bot (lead, /bot/status):
 *  - Trailing stop: a broker GTC order if one exists; otherwise the 5-min
 *    `sync_account` job sells a breach — it runs even with LLM routines off,
 *    but only while the scheduler is alive and DRY_RUN is off.
 *  - −7% cut: only the 13:00 ET midday routine, i.e. only while `active`
 *    (routines enabled and not stale).
 */
import type { BotStatus } from "@/lib/api";
import { etDate, fmtD } from "./util";

/** Fields /bot/status serves that lib/api.ts doesn't type yet. */
export type BotStatusX = BotStatus & {
  scheduler_alive?: boolean;
  synthetic_stops?: boolean;
  dry_run?: boolean;
  last_sync_at?: string | null;
};

export type Enforcement = {
  /** Status not loaded yet — callers show nothing rather than guess. */
  known: boolean;
  stop: { by: "broker" | "synthetic" | "none"; armed: boolean; why: string[] };
  cut: { armed: boolean; why: string[] };
};

export function enforcement(brokerStop: boolean, bot: BotStatusX | undefined, now: number): Enforcement {
  if (!bot) return { known: false, stop: { by: brokerStop ? "broker" : "synthetic", armed: true, why: [] }, cut: { armed: true, why: [] } };
  const run = bot.last_llm_run;
  const offDays = run && now ? Math.floor((now - new Date(run.started_at).getTime()) / 86_400_000) : null;

  let stop: Enforcement["stop"];
  if (brokerStop) stop = { by: "broker", armed: true, why: [] };
  else {
    const armed = bot.synthetic_stops ?? (bot.scheduler_alive !== false && bot.dry_run !== true);
    const why: string[] = [];
    if (bot.scheduler_alive === false) why.push("scheduler down");
    if (bot.dry_run === true) why.push("DRY_RUN on");
    stop = armed ? { by: "synthetic", armed: true, why: [] } : { by: "none", armed: false, why: why.length ? why : ["sync job off"] };
  }

  const cutArmed = bot.active === true;
  const cutWhy: string[] = [];
  if (!cutArmed) {
    if (bot.routines_enabled === false) cutWhy.push("routines disabled");
    else cutWhy.push(`no routine for ${offDays ?? "?"}d`);
    if (run) cutWhy.push(`last run ${fmtD(etDate(run.started_at))}${offDays != null ? `, ${offDays}d ago` : ""}`);
  }
  return { known: true, stop, cut: { armed: cutArmed, why: cutWhy } };
}
