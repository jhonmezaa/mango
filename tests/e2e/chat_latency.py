"""Chat latency against a deployed lab installation: what the user sees and when (D39).

For each turn it records when every kind of SSE event first arrives, counted from the moment
the request is sent: ``conversation``, the first ``status`` (live progress, if the deployed
version sends it), the first ``tool`` and the first ``delta`` (the first block of the answer the
guardrail released). It also groups the text into the blocks the guardrail released together.
Run it before and after a deployment to compare; it creates nothing but the conversations of
the e2e user, and each turn spends that user's AI budget like any other turn.

Uses only lab e2e users (config ``e2e: true``), like ``smoke.py``.

Run:
  uv run --no-project --with boto3 --with pycognito --with pyotp --with httpx \
    python tests/e2e/chat_latency.py --profile mango-sandbox --secrets <path> --user <email> \
    [--turns 5] [--follow-up] [--question "…"] [--agent <id>]
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path
from typing import Any

import boto3
import httpx
from smoke import load_secrets, save_secrets, sign_in, stack_outputs

DEFAULT_QUESTION = "¿Cuánto gastamos este mes en AWS? Resume los tres servicios principales."
FOLLOW_UP_QUESTION = "¿Y el mes pasado?"
BLOCK_GAP_SECONDS = 0.25
"""Deltas closer than this were released together by the guardrail."""


def measure_turn(
    app_url: str, token: str, question: str, conversation_id: str | None, agent_id: str | None
) -> dict[str, Any]:
    body: dict[str, Any] = {"message": question}
    if conversation_id:
        body["conversation_id"] = conversation_id
    elif agent_id:
        body["agent_id"] = agent_id
    first: dict[str, float] = {}
    timeline: list[dict[str, Any]] = []
    blocks: list[dict[str, Any]] = []
    turn: dict[str, Any] = {"question": question, "first": first, "progress": timeline}
    started = time.monotonic()
    with httpx.stream(
        "POST",
        f"{app_url}/api/chat",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
        timeout=httpx.Timeout(30.0, read=180.0),
    ) as resp:
        turn["status"] = resp.status_code
        first["headers"] = round(time.monotonic() - started, 2)
        if resp.status_code != 200:
            turn["error"] = resp.read().decode()[:200]
            return turn
        event = None
        last_delta = 0.0
        for line in resp.iter_lines():
            if line.startswith("event: "):
                event = line[7:]
                continue
            if not line.startswith("data: ") or not event:
                continue
            at = time.monotonic() - started
            data = json.loads(line[6:])
            first.setdefault(event, round(at, 2))
            if event == "delta":
                if not blocks or at - last_delta > BLOCK_GAP_SECONDS:
                    blocks.append({"at": round(at, 2), "chars": 0})
                blocks[-1]["chars"] += len(data["text"])
                last_delta = at
            elif event == "status":
                timeline.append({"at": round(at, 2), **data})
            elif event == "tool":
                timeline.append({"at": round(at, 2), "tool": data["name"], "state": data["status"]})
            elif event == "conversation":
                turn["conversation_id"] = data["conversation_id"]
            elif event in {"done", "error"}:
                turn[event] = data
    turn["total"] = round(time.monotonic() - started, 2)
    turn["blocks"] = blocks
    return turn


def summarize(turns: list[dict[str, Any]]) -> dict[str, Any]:
    """Median and worst case of the first arrival of each event, over the turns that ran."""
    summary: dict[str, Any] = {"turns": len(turns)}
    for event in ("headers", "conversation", "status", "tool", "delta"):
        values = [t["first"][event] for t in turns if event in t["first"]]
        if values:
            summary[f"first_{event}_s"] = {
                "p50": round(statistics.median(values), 2),
                "max": max(values),
                "n": len(values),
            }
    totals = [t["total"] for t in turns if "total" in t]
    if totals:
        summary["total_s"] = {"p50": round(statistics.median(totals), 2), "max": max(totals)}
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--stack", default="Mango-poc-Core")
    parser.add_argument("--secrets", required=True, type=Path)
    parser.add_argument("--user", required=True)
    parser.add_argument("--question", default=DEFAULT_QUESTION)
    parser.add_argument("--agent", default=None, help="agent id (default: the release agent)")
    parser.add_argument("--turns", type=int, default=5, help="new conversations to measure")
    parser.add_argument(
        "--follow-up",
        action="store_true",
        help="also send a second message in each conversation (runtime session reused)",
    )
    args = parser.parse_args()

    session = boto3.Session(profile_name=args.profile, region_name="us-east-1")
    outputs = stack_outputs(session, args.stack)
    store = load_secrets(args.secrets)
    try:
        token = sign_in(
            session.client("cognito-idp"),
            outputs["UserPoolId"],
            outputs["WebClientId"],
            args.user,
            store,
        )
    finally:
        save_secrets(args.secrets, store)

    app_url = outputs["AppUrl"]
    new_turns: list[dict[str, Any]] = []
    follow_ups: list[dict[str, Any]] = []
    for _ in range(args.turns):
        turn = measure_turn(app_url, token, args.question, None, args.agent)
        print(json.dumps(turn, ensure_ascii=False))
        new_turns.append(turn)
        if args.follow_up and turn.get("conversation_id") and "done" in turn:
            follow_up = measure_turn(
                app_url, token, FOLLOW_UP_QUESTION, turn["conversation_id"], None
            )
            print(json.dumps(follow_up, ensure_ascii=False))
            follow_ups.append(follow_up)
    report = {"new_conversation": summarize(new_turns)}
    if follow_ups:
        report["follow_up"] = summarize(follow_ups)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.stdout.flush()
    if any(t.get("status") != 200 or "error" in t for t in new_turns + follow_ups):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
