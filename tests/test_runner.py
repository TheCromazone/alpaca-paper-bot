"""Routine runner + Codex adapter: failures must be recorded, never silent,
and the runner's per-routine tool gate is defence in depth for the
registry filter."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import select

from bot.config import settings
from bot.db import LLMRun, SessionLocal, Trade
from bot.llm import runner
from bot.llm.anthropic_client import Turn
from tests.conftest import utcnow
from tests.test_tools_trust_boundary import THESIS


class ScriptedClient:
    """Replays a list of Turns; records the messages it was sent."""

    def __init__(self, turns):
        self.turns = list(turns)
        self.sent: list[list[dict]] = []

    def create_turn(self, *, system, messages, tools, enable_web_search=False, **_):
        self.sent.append([dict(m) for m in messages])
        self.tool_names = {t["name"] for t in tools}
        return self.turns.pop(0)


def tool_turn(name, args, tid="t1"):
    return Turn(stop_reason="tool_use",
                content=[{"type": "tool_use", "id": tid, "name": name, "input": args}],
                input_tokens=10, output_tokens=5)


def text_turn(text="done"):
    return Turn(stop_reason="end_turn", content=[{"type": "text", "text": text}],
                input_tokens=10, output_tokens=5)


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(runner.time, "sleep", lambda *_: None)


def install(monkeypatch, client):
    monkeypatch.setattr(runner, "AnthropicClient", lambda **_: client)
    return client


def run_row(run_id):
    with SessionLocal() as s:
        return s.get(LLMRun, run_id)


def test_premarket_cannot_place_buy_even_if_model_asks(monkeypatch, fake):
    fake.quotes["AAPL"] = 100.0
    client = install(monkeypatch, ScriptedClient([
        tool_turn("place_buy", {"symbol": "AAPL", "notional_usd": 1000, "thesis": THESIS}),
        text_turn(),
    ]))
    run_id = runner.run_routine("premarket")
    assert "place_buy" not in client.tool_names           # never advertised
    result = client.sent[1][-1]["content"][0]             # tool_result fed back
    assert result["is_error"] is True and "not available in routine" in result["content"]
    assert fake.mutations() == []
    row = run_row(run_id)
    assert row.status == "ok"
    assert row.tool_trace[0]["name"] == "place_buy" and row.tool_trace[0]["ok"] is False


def test_execute_dry_run_end_to_end(monkeypatch, fake):
    monkeypatch.setattr(settings, "dry_run", True)
    fake.quotes["AAPL"] = 100.0
    install(monkeypatch, ScriptedClient([
        tool_turn("place_buy", {"symbol": "AAPL", "notional_usd": 1000, "thesis": THESIS}),
        text_turn("bought AAPL"),
    ]))
    row = run_row(runner.run_routine("execute"))
    assert row.status == "ok" and row.tool_calls == 1 and row.tool_trace[0]["ok"]
    assert fake.mutations() == []
    with SessionLocal() as s:
        (t,) = s.scalars(select(Trade)).all()
    assert t.status == "dry_run"


def test_setup_failure_is_recorded_not_left_running(monkeypatch):
    # e.g. codex_auth can't refresh its OAuth token: the client constructor
    # raises. This used to escape run_routine with the row stuck 'running'.
    def boom(**_):
        raise RuntimeError("oauth token refresh failed")
    monkeypatch.setattr(runner, "AnthropicClient", boom)
    row = run_row(runner.run_routine("execute"))
    assert row.status == "failed"
    assert "oauth token refresh failed" in row.error
    assert row.finished_at is not None


def test_empty_response_is_a_failure(monkeypatch):
    install(monkeypatch, ScriptedClient([Turn(stop_reason="end_turn", content=[])]))
    row = run_row(runner.run_routine("close"))
    assert row.status == "failed" and "empty response" in row.error


def test_malformed_tool_args_do_not_crash_the_routine(monkeypatch, fake):
    install(monkeypatch, ScriptedClient([
        Turn(stop_reason="tool_use",
             content=[{"type": "tool_use", "id": "t1", "name": "read_memory", "input": ["strategy"]}]),
        text_turn(),
    ]))
    row = run_row(runner.run_routine("close"))
    assert row.status == "ok"
    assert row.tool_trace[0]["ok"] is False


def test_daily_budget_exhausted_skips_routine(monkeypatch):
    with SessionLocal.begin() as s:
        s.add(LLMRun(routine="premarket", started_at=utcnow(), model="m",
                     status="ok", usd_cost=settings.llm_daily_usd_budget + 1))

    def must_not_construct(**_):
        raise AssertionError("client constructed despite exhausted budget")
    monkeypatch.setattr(runner, "AnthropicClient", must_not_construct)
    assert runner.run_routine("execute") == -1


def test_rate_limit_is_retried_then_succeeds(monkeypatch):
    calls = {"n": 0}

    class Flaky(ScriptedClient):
        def create_turn(self, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("codex stream failed — rate_limit_exceeded: slow down")
            return super().create_turn(**kw)

    install(monkeypatch, Flaky([text_turn()]))
    row = run_row(runner.run_routine("close"))
    assert row.status == "ok" and calls["n"] == 2


# ---------------------------------------------------------------------------
# Codex stream adapter
# ---------------------------------------------------------------------------


def _codex(events):
    from bot.llm.openai_client import CodexClient

    c = CodexClient.__new__(CodexClient)   # skip OAuth-backed __init__
    c.model = "test-model"
    c.client = SimpleNamespace(responses=SimpleNamespace(create=lambda **_: iter(events)))
    return c


def test_codex_failed_stream_raises_with_code():
    ev = SimpleNamespace(type="response.failed", response=SimpleNamespace(
        error=SimpleNamespace(code="rate_limit_exceeded", message="usage limit reached")))
    with pytest.raises(RuntimeError, match="rate_limit_exceeded"):
        _codex([ev]).create_turn(system=[], messages=[], tools=[])


def test_codex_error_event_raises():
    ev = SimpleNamespace(type="error", code="server_error", message="boom")
    with pytest.raises(RuntimeError, match="server_error"):
        _codex([ev]).create_turn(system=[], messages=[], tools=[])


def test_codex_stream_without_completion_raises():
    with pytest.raises(RuntimeError, match="without a completed response"):
        _codex([]).create_turn(system=[], messages=[], tools=[])


def test_codex_tool_call_parsed():
    item = SimpleNamespace(type="function_call", call_id="c1", name="get_portfolio", arguments="{}")
    usage = SimpleNamespace(input_tokens=12, output_tokens=3, output_tokens_details=None)
    events = [
        SimpleNamespace(type="response.output_item.done", item=item),
        SimpleNamespace(type="response.completed", response=SimpleNamespace(usage=usage)),
    ]
    turn = _codex(events).create_turn(system=[], messages=[], tools=[])
    assert turn.stop_reason == "tool_use"
    assert turn.content == [{"type": "tool_use", "id": "c1", "name": "get_portfolio", "input": {}}]
    assert (turn.input_tokens, turn.output_tokens) == (12, 3)


# ---------------------------------------------------------------------------
# run_routine on the live backend (codex_oauth), real CodexClient, fake transport
# ---------------------------------------------------------------------------


class _FakeResponses:
    """OpenAI Responses API stand-in: one scripted event stream per call."""

    def __init__(self, scripts):
        self.scripts = list(scripts)
        self.requests: list[dict] = []

    def create(self, **kwargs):
        self.requests.append(kwargs)
        return iter(self.scripts.pop(0))


def _usage(i=50, o=10):
    return SimpleNamespace(input_tokens=i, output_tokens=o, output_tokens_details=None)


def test_run_routine_on_codex_backend_places_dry_run_buy(monkeypatch, fake):
    import json

    from bot.llm import openai_client

    monkeypatch.setattr(settings, "llm_provider", "codex_oauth")
    monkeypatch.setattr(settings, "dry_run", True)
    fake.quotes["AAPL"] = 100.0
    call = SimpleNamespace(type="function_call", call_id="call_1", name="place_buy",
                           arguments=json.dumps({"symbol": "AAPL", "notional_usd": 1000, "thesis": THESIS}))
    msg = SimpleNamespace(type="message", content=[SimpleNamespace(type="output_text", text="Bought AAPL.")])
    responses = _FakeResponses([
        [SimpleNamespace(type="response.output_item.done", item=call),
         SimpleNamespace(type="response.completed", response=SimpleNamespace(usage=_usage()))],
        [SimpleNamespace(type="response.output_item.done", item=msg),
         SimpleNamespace(type="response.completed", response=SimpleNamespace(usage=_usage()))],
    ])
    monkeypatch.setattr(openai_client, "OpenAI", lambda: SimpleNamespace(responses=responses))

    row = run_row(runner.run_routine("execute"))

    assert row.status == "ok", row.error
    assert row.model == settings.llm_model_codex and row.usd_cost == 0.0
    assert row.summary == "Bought AAPL." and row.tool_trace[0]["ok"] is True
    assert row.input_tokens == 100
    # Turn 2 replayed the call and its output in Responses-API shape.
    second = responses.requests[1]["input"]
    assert {"type": "function_call", "call_id": "call_1", "name": "place_buy",
            "arguments": call.arguments} in second
    out = next(i for i in second if i.get("type") == "function_call_output")
    assert out["call_id"] == "call_1" and '"status": "dry_run"' in out["output"]
    assert {t["name"] for t in responses.requests[0]["tools"]} >= {"place_buy", "get_portfolio"}
    assert fake.mutations() == []
    with SessionLocal() as s:
        (t,) = s.scalars(select(Trade)).all()
    assert t.status == "dry_run"


def test_run_routine_on_codex_backend_records_stream_failure(monkeypatch):
    from bot.llm import openai_client

    monkeypatch.setattr(settings, "llm_provider", "codex_oauth")
    failed = SimpleNamespace(type="response.failed", response=SimpleNamespace(
        error=SimpleNamespace(code="server_error", message="upstream exploded")))
    responses = _FakeResponses([[failed]])
    monkeypatch.setattr(openai_client, "OpenAI", lambda: SimpleNamespace(responses=responses))
    row = run_row(runner.run_routine("close"))
    assert row.status == "failed" and "server_error" in row.error
