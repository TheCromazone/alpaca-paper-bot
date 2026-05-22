"""Audit the bot's recent history for improvement opportunities. Read-only."""
import sqlite3, json
from datetime import datetime, timezone, timedelta

con = sqlite3.connect("data/trading.db")
con.row_factory = sqlite3.Row
c = con.cursor()
now = datetime.now(timezone.utc)
d14 = (now - timedelta(days=14)).isoformat()
d30 = (now - timedelta(days=30)).isoformat()

print("===== LLM RUNS (14d) =====")
runs = c.execute(
    "SELECT routine,status,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,usd_cost,tool_calls,web_search_calls,started_at,finished_at,error FROM llm_runs WHERE started_at>=? ORDER BY started_at DESC",
    (d14,),
).fetchall()
print(f"n={len(runs)}")
if runs:
    by_status, by_routine, hi_tools = {}, {}, []
    cost_in = cost_out = cr = cw = 0
    durations = []
    for r in runs:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
        by_routine[r["routine"]] = by_routine.get(r["routine"], 0) + 1
        cost_in += r["input_tokens"] or 0
        cost_out += r["output_tokens"] or 0
        cr += r["cache_read_tokens"] or 0
        cw += r["cache_write_tokens"] or 0
        if r["tool_calls"] and r["tool_calls"] >= 15:
            hi_tools.append((r["routine"], r["tool_calls"], r["started_at"][:10]))
        if r["finished_at"]:
            try:
                a = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00"))
                b = datetime.fromisoformat(r["finished_at"].replace("Z", "+00:00"))
                durations.append((b - a).total_seconds())
            except Exception:
                pass
    print(f"  status: {by_status}")
    print(f"  routine: {by_routine}")
    total_cost = sum((r["usd_cost"] or 0) for r in runs)
    print(f"  spend 14d: ${total_cost:.2f}")
    if (cr + cost_in):
        print(f"  cache_hit_ratio: {cr/(cr+cost_in):.1%}")
    if cr:
        print(f"  cache_write/read: {cw}/{cr} = {cw/cr:.2f}")
    if durations:
        durations.sort()
        print(f"  duration p50={durations[len(durations)//2]:.1f}s p95={durations[int(len(durations)*0.95)]:.1f}s max={max(durations):.1f}s")
    fails = [r for r in runs if r["status"] != "ok"]
    print(f"  non-ok runs: {len(fails)}")
    for r in fails[:8]:
        err = (r["error"] or "")[:100].replace("\n", " ")
        print(f"    {r['started_at'][:16]}  {r['routine']:14}  {r['status']:12}  {err}")
    print(f"  hi-tool runs (>=15): {len(hi_tools)} -> {hi_tools[:5]}")

print("\n===== TRADES (14d) =====")
tr = c.execute(
    "SELECT id,ticker,side,qty,price,notional,status,submitted_at,filled_at FROM trades WHERE submitted_at>=? ORDER BY submitted_at DESC",
    (d14,),
).fetchall()
print(f"n={len(tr)}")
buys = [t for t in tr if t["side"] == "buy"]
sells = [t for t in tr if t["side"] == "sell"]
dry = [t for t in tr if t["status"] == "dry_run"]
print(f"  buys={len(buys)}  sells={len(sells)}  dry_run={len(dry)}")
by_ticker = {}
for t in tr:
    by_ticker[t["ticker"]] = by_ticker.get(t["ticker"], 0) + 1
print(f"  unique tickers: {len(by_ticker)}")
print(f"  top tickers: {sorted(by_ticker.items(), key=lambda x: -x[1])[:8]}")
ticker_buys, ticker_sells = {}, {}
for t in tr:
    d = ticker_buys if t["side"] == "buy" else ticker_sells
    d.setdefault(t["ticker"], []).append(t)
closed = []
for tk in ticker_sells:
    if tk in ticker_buys and ticker_buys[tk] and ticker_sells[tk]:
        avg_buy = sum((b["price"] or 0) * (b["qty"] or 0) for b in ticker_buys[tk]) / max(sum(b["qty"] or 0 for b in ticker_buys[tk]), 1)
        avg_sell = sum((s["price"] or 0) * (s["qty"] or 0) for s in ticker_sells[tk]) / max(sum(s["qty"] or 0 for s in ticker_sells[tk]), 1)
        if avg_buy and avg_sell:
            pnl_pct = (avg_sell / avg_buy - 1) * 100
            closed.append((tk, pnl_pct))
if closed:
    closed.sort(key=lambda x: x[1])
    wins = [x for x in closed if x[1] > 0]
    print(f"  paired round-trips: {len(closed)}  win_rate={len(wins)/len(closed):.0%}  avg={sum(x[1] for x in closed)/len(closed):+.2f}%")
    print(f"  worst: {closed[:3]}")
    print(f"  best:  {closed[-3:]}")

print("\n===== JOB FAILURES (14d) =====")
jf = c.execute(
    "SELECT job_name,status,message,started_at FROM job_runs WHERE started_at>=? AND status!='ok' ORDER BY started_at DESC",
    (d14,),
).fetchall()
print(f"n={len(jf)}")
by_job = {}
for j in jf:
    by_job[j["job_name"]] = by_job.get(j["job_name"], 0) + 1
print(f"  by_job: {by_job}")
for j in jf[:5]:
    print(f"    {j['started_at'][:16]}  {j['job_name']:24}  {(j['message'] or '')[:80]}")

print("\n===== EQUITY VS SPY (30d) =====")
hist = c.execute(
    "SELECT at,equity,spy_close FROM portfolio_snapshots WHERE at>=? AND spy_close IS NOT NULL ORDER BY at ASC",
    (d30,),
).fetchall()
if len(hist) >= 2:
    f, l = hist[0], hist[-1]
    eq_ret = (l["equity"] / f["equity"] - 1) * 100
    spy_ret = (l["spy_close"] / f["spy_close"] - 1) * 100
    print(f"  snapshots={len(hist)}  span={f['at'][:10]} -> {l['at'][:10]}")
    print(f"  equity: ${f['equity']:,.0f} -> ${l['equity']:,.0f}  ({eq_ret:+.2f}%)")
    print(f"  SPY:    ${f['spy_close']:.2f} -> ${l['spy_close']:.2f}  ({spy_ret:+.2f}%)")
    print(f"  alpha:  {eq_ret-spy_ret:+.2f}pp")
    peak = mdd = 0
    for h in hist:
        peak = max(peak, h["equity"])
        if peak:
            dd = (peak - h["equity"]) / peak * 100
            mdd = max(mdd, dd)
    print(f"  max_drawdown: {mdd:.2f}%")

print("\n===== POSITIONS NOW =====")
pos = c.execute(
    "SELECT ticker,qty,avg_cost,market_price,market_value,unrealized_pnl,opened_at,peak_price,stop_order_id FROM positions"
).fetchall()
def pct(p):
    return ((p["market_price"] or 0) / (p["avg_cost"] or 1) - 1) if p["avg_cost"] else 0.0
pos = sorted(pos, key=pct, reverse=True)
print(f"n={len(pos)}")
no_stop = [p for p in pos if not p["stop_order_id"]]
print(f"  WITHOUT trailing stop: {len(no_stop)}/{len(pos)}")
for p in no_stop:
    print(f"    {p['ticker']:6}  pct={pct(p)*100:+.2f}%  qty={(p['qty'] or 0):.2f}  opened={(p['opened_at'] or '')[:10]}")
ages = []
for p in pos:
    if p["opened_at"]:
        try:
            o = datetime.fromisoformat(p["opened_at"].replace("Z", "+00:00"))
            ages.append((now - o).days)
        except Exception:
            pass
if ages:
    ages.sort()
    print(f"  age_days: min={min(ages)} median={ages[len(ages)//2]} max={max(ages)}")
losers = [p for p in pos if pct(p) < -0.05]
winners = [p for p in pos if pct(p) > 0.05]
print(f"  losers <-5%: {len(losers)}  winners >+5%: {len(winners)}")
worst5 = sorted(pos, key=pct)[:5]
print("  worst5: " + ", ".join(f"{p['ticker']} {pct(p)*100:+.1f}%" for p in worst5))

print("\n===== REJECTED TRADES (14d) =====")
rej = c.execute(
    "SELECT ticker,side,qty,notional,submitted_at FROM trades WHERE status='rejected' AND submitted_at>=? ORDER BY submitted_at DESC",
    (d14,),
).fetchall()
print(f"n={len(rej)}")
by_t = {}
for r in rej:
    by_t[r["ticker"]] = by_t.get(r["ticker"], 0) + 1
print(f"  top rejected: {sorted(by_t.items(), key=lambda x:-x[1])[:5]}")
print(f"  rejection_rate: {len(rej) / (len(rej) + len([t for t in tr if t['status']=='submitted'])) :.1%}" if (len(rej) + len([t for t in tr if t['status']=='submitted'])) else "")
# Same-day same-ticker buy+sell
import collections
buckets = collections.defaultdict(lambda: {'buy':0, 'sell':0})
for t in tr:
    if not t["submitted_at"]: continue
    key = (t["submitted_at"][:10], t["ticker"])
    buckets[key][t["side"]] += 1
churn = [(k, v) for k,v in buckets.items() if v['buy']>0 and v['sell']>0]
print(f"  same-day buy+sell same ticker (last 14d): {len(churn)}")
for k,v in churn[:5]:
    print(f"    {k[0]} {k[1]}  buys={v['buy']} sells={v['sell']}")

print("\n===== TOOL_TRACE (last 50 runs) =====")
recent = c.execute("SELECT tool_trace FROM llm_runs WHERE tool_trace IS NOT NULL ORDER BY started_at DESC LIMIT 50").fetchall()
tool_counter, err_counter = {}, {}
for row in recent:
    try:
        trace = json.loads(row["tool_trace"]) if isinstance(row["tool_trace"], str) else row["tool_trace"]
        for t in (trace or []):
            n = t.get("name") if isinstance(t, dict) else None
            if n:
                tool_counter[n] = tool_counter.get(n, 0) + 1
                if not t.get("ok", True):
                    err_counter[n] = err_counter.get(n, 0) + 1
    except Exception:
        pass
print(f"  top: {sorted(tool_counter.items(), key=lambda x:-x[1])[:10]}")
print(f"  errors: {err_counter}")

print("\n===== DECISIONS / THESIS QUALITY (14d) =====")
decs = c.execute(
    "SELECT ticker,action,reason,at FROM decisions WHERE at>=? AND reason IS NOT NULL AND action IN ('buy','sell','manual_buy','manual_sell') ORDER BY at DESC",
    (d14,),
).fetchall()
print(f"n={len(decs)}")
short = [d for d in decs if len(d["reason"] or "") < 80]
long_ = [d for d in decs if len(d["reason"] or "") >= 200]
print(f"  short(<80): {len(short)}  long(>=200): {len(long_)}")
for d in decs[:8]:
    r = (d["reason"] or "")[:140].replace("\n", " ")
    print(f"    {d['at'][:10]} {d['action']:12} {d['ticker']:6}  '{r}'")
