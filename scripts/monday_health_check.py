"""Monday-morning health check for the trading bot.

Fired by Windows Task Scheduler at 07:00 PT on Mon 2026-05-04 (= 10:00 ET,
~30 min after the execute routine completes). Writes a plain-text report to
``logs/monday_health_<date>.txt`` and pops a Windows toast notification with
a one-line summary.

What it checks:
  1. API /health (port 8765) and dashboard (port 3001) respond 200
  2. Today's LLMRun rows — premarket and execute both completed status='ok'
  3. Recent trades — count of fills today + a list with ticker/side/qty/price
  4. Recent JobRun rows — any failed jobs in the last 4 hours?
  5. Today's spend vs budget (LLMRun.usd_cost sum vs LLM_DAILY_USD_BUDGET)
  6. Cache-hit ratio (should be > 60% — drops below indicate prompt churn)
  7. Latest memory/research_log.md entry exists for today

Exits 0 always — failures go to the report, not the exit code, so Task
Scheduler doesn't endlessly retry. The toast color is the alert signal:
green = all good, amber = warnings, red = something failed.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# --- Make the bot package importable when run directly ---
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)


def _http_status(url: str, timeout: float = 5.0) -> int | str:
    """Return the HTTP status code for ``url`` or a short error string."""
    import urllib.request
    import urllib.error

    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception as exc:
        return f"down ({type(exc).__name__})"


def _today_window() -> tuple[datetime, datetime]:
    """Return the [start, end) UTC window covering 'today' in America/New_York.

    The bot's routines are anchored to America/New_York, so 'today' from the
    LLMRun timestamps' perspective is the ET calendar day.
    """
    try:
        from zoneinfo import ZoneInfo
        et = ZoneInfo("America/New_York")
    except Exception:
        # Fallback: UTC - 4h (EDT). Close enough for May 2026.
        et = timezone(timedelta(hours=-4))
    now_et = datetime.now(et)
    start_et = now_et.replace(hour=0, minute=0, second=0, microsecond=0)
    end_et = start_et + timedelta(days=1)
    return start_et.astimezone(timezone.utc), end_et.astimezone(timezone.utc)


def _toast(title: str, msg: str, color: str) -> None:
    """Best-effort Windows toast via PowerShell. Never raises."""
    import subprocess

    ps = (
        f'$ErrorActionPreference="SilentlyContinue"; '
        f'[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null; '
        f'$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); '
        f'$t.GetElementsByTagName("text")[0].AppendChild($t.CreateTextNode("{title}")) | Out-Null; '
        f'$t.GetElementsByTagName("text")[1].AppendChild($t.CreateTextNode("{msg}")) | Out-Null; '
        f'[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("AlpacaBot").Show([Windows.UI.Notifications.ToastNotification]::new($t))'
    )
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
            timeout=10,
            check=False,
        )
    except Exception:
        pass  # toast is nice-to-have; never block the report


def main() -> int:
    started = datetime.now(timezone.utc)
    started_local = started.astimezone()
    today_start, today_end = _today_window()
    lines: list[str] = []
    issues: list[str] = []

    def section(title: str) -> None:
        lines.append("")
        lines.append(f"=== {title} ===")

    lines.append(f"Monday health check — {started_local.isoformat(timespec='seconds')}")
    lines.append(f"ET window: {today_start.isoformat()} → {today_end.isoformat()}")

    # 1. Service ports
    section("Service health")
    api = _http_status("http://127.0.0.1:8765/health")
    dash = _http_status("http://127.0.0.1:3001/")
    lines.append(f"API     :8765  → {api}")
    lines.append(f"Dashboard :3001 → {dash}")
    if api != 200:
        issues.append(f"API down ({api})")
    if dash != 200:
        issues.append(f"Dashboard down ({dash})")

    # 2/4/5/6. LLMRun + JobRun + budget — uses the bot's DB layer
    try:
        from sqlalchemy import desc, select
        from bot.config import settings
        from bot.db import JobRun, LLMRun, Trade, SessionLocal
    except Exception as exc:
        section("DB import")
        lines.append(f"FAILED to import bot DB layer: {exc}")
        issues.append("DB import failed")
        report_path = _write_report(lines)
        _toast("Bot health: import failed", str(exc)[:120], "red")
        print(f"report: {report_path}")
        return 0

    section("LLM routines today")
    with SessionLocal() as s:
        runs = s.scalars(
            select(LLMRun)
            .where(LLMRun.started_at >= today_start)
            .where(LLMRun.started_at < today_end)
            .order_by(LLMRun.started_at.asc())
        ).all()
        if not runs:
            lines.append("(no LLMRun rows for today yet)")
            issues.append("no LLM routines fired today")
        else:
            for r in runs:
                t = r.started_at.isoformat(timespec="seconds") if r.started_at else "?"
                lines.append(
                    f"  {t}  {r.routine:14s} status={r.status:11s} "
                    f"tools={r.tool_calls:>2d}  ${r.usd_cost:.3f}"
                )
                if r.status not in ("ok", "running"):
                    issues.append(f"{r.routine} status={r.status}")
                if r.error:
                    lines.append(f"        error: {r.error[:200]}")

        # Premarket + execute — the two we specifically expect by 10:00 ET.
        seen_routines = {r.routine: r for r in runs}
        for expected in ("premarket", "execute"):
            if expected not in seen_routines:
                issues.append(f"{expected} did not fire today")
            elif seen_routines[expected].status not in ("ok",):
                issues.append(
                    f"{expected} status={seen_routines[expected].status}"
                )

        section("Today's trades")
        todays_trades = s.scalars(
            select(Trade)
            .where(Trade.submitted_at >= today_start)
            .where(Trade.submitted_at < today_end)
            .order_by(Trade.submitted_at.asc())
        ).all()
        if not todays_trades:
            lines.append("(none)")
        else:
            for t in todays_trades:
                ts = t.submitted_at.isoformat(timespec="seconds") if t.submitted_at else "?"
                lines.append(
                    f"  {ts}  {t.side.upper():4s} {t.ticker:6s} "
                    f"qty={t.qty:>9.4f} @ ${t.price:.2f}  notional=${t.notional:.2f}  "
                    f"status={t.status}{' DRY' if t.dry_run else ''}"
                )

        section("Failed jobs in last 4h")
        cutoff = datetime.now(timezone.utc) - timedelta(hours=4)
        failed = s.scalars(
            select(JobRun)
            .where(JobRun.started_at >= cutoff)
            .where(JobRun.status == "failed")
            .order_by(desc(JobRun.started_at))
            .limit(20)
        ).all()
        if not failed:
            lines.append("(none)")
        else:
            for j in failed:
                lines.append(
                    f"  {j.started_at.isoformat(timespec='seconds')}  {j.job_name}  → {j.message[:160] if j.message else ''}"
                )
                issues.append(f"{j.job_name} failed")

        section("Spend & cache")
        usd_today = sum(r.usd_cost for r in runs)
        cr = sum(r.cache_read_tokens for r in runs)
        cw = sum(r.cache_write_tokens for r in runs)
        cache_hit = cr / (cr + cw) if (cr + cw) else None
        lines.append(
            f"  spend today  ${usd_today:.3f} / ${settings.llm_daily_usd_budget:.2f} "
            f"({usd_today / max(settings.llm_daily_usd_budget, 0.01) * 100:.0f}%)"
        )
        if cache_hit is not None:
            lines.append(f"  cache hit    {cache_hit*100:.1f}% (read={cr} write={cw})")
            if cache_hit < 0.6:
                issues.append(f"cache hit {cache_hit*100:.0f}% < 60%")
        else:
            lines.append("  cache hit    n/a (no cached input yet)")
        if usd_today > settings.llm_daily_usd_budget:
            issues.append(
                f"over budget: ${usd_today:.2f} > ${settings.llm_daily_usd_budget:.2f}"
            )

    # 7. research_log.md latest day
    section("Research log")
    rl = ROOT / "memory" / "research_log.md"
    if rl.exists():
        text = rl.read_text(encoding="utf-8", errors="ignore")
        today_iso = today_start.astimezone().date().isoformat()
        if f"## {today_iso}" in text:
            lines.append(f"OK — research_log.md has today's section ## {today_iso}")
        else:
            lines.append(f"WARNING — no ## {today_iso} section in research_log.md")
            issues.append("research_log missing today's section")
    else:
        lines.append("research_log.md not found")
        issues.append("research_log.md missing")

    # ---- Summary ----
    section("Summary")
    if not issues:
        verdict = "ALL GOOD"
        color = "green"
        toast_msg = (
            f"premarket+execute ok · "
            f"{len(todays_trades) if 'todays_trades' in dir() else '?'} trades · "
            f"${usd_today:.2f} spent"
        )
    else:
        verdict = f"{len(issues)} ISSUE(S)"
        color = "amber" if api == 200 and dash == 200 else "red"
        toast_msg = " · ".join(issues[:2])[:120]
    lines.append(f"Verdict: {verdict}")
    if issues:
        for i in issues:
            lines.append(f"  - {i}")

    report_path = _write_report(lines)
    _toast(f"Bot Monday check: {verdict}", toast_msg, color)
    print(f"report: {report_path}")
    print(f"verdict: {verdict}")
    return 0


def _write_report(lines: list[str]) -> Path:
    logs = ROOT / "logs"
    logs.mkdir(exist_ok=True)
    name = f"monday_health_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    path = logs / name
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


if __name__ == "__main__":
    raise SystemExit(main())
