"use client";

/**
 * RISK — full page: return vs SPY with the underwater drawdown (MARS), the
 * daily return distribution with VaR/CVaR (DIST), and the guard console in
 * page variant (tiles, wide guard table, sector load, position weights).
 */
import { ReturnDist, RiskCurve, RiskPanel } from "@/components/term/RiskPanel";
import s from "@/components/term/RiskPanel.module.css";

export default function RiskPage() {
  return (
    <div className={s.pageGrid}>
      <RiskCurve />
      <ReturnDist />
      <RiskPanel variant="page" />
    </div>
  );
}
