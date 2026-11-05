"""Scoring one case with AgentCore Evaluations (D110 (1), (8)).

mango-api asks for one case at a time: the runtime session of its turn, the expected answer and
the judge model. The evaluator is Mango's own (``CreateEvaluator`` in the release, one per judge
model of the installation, with instructions that treat the turn as untrusted data and a
PASS/FAIL scale). What goes back is the label, whether it passed and the tokens of the judge:
never its explanation (it may quote the answer or the data a tool returned), never the answer.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_eval_judge import spans
from mango_eval_judge.config import Settings

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore import BedrockAgentCoreClient
    from mypy_boto3_logs import CloudWatchLogsClient

logger = logging.getLogger(__name__)

PASS_LABEL = "PASS"  # noqa: S105 - a label of the scale
MAX_OUTPUT_TOKENS = 512
"""``maxTokens`` of the evaluators of the release (``infra/lib/constructs/evals.ts``)."""
ESTIMATED_INPUT_TOKENS = 6000
"""What a reservation counts for the judge's input: the instructions, the context of one turn
and the expected answer. The real tokens come back from ``Evaluate`` and are charged."""
MAX_EXPECTED_CHARS = 1000
"""The longest expected answer a case may have (``mango_core.evals``)."""


@dataclass(frozen=True)
class Verdict:
    status: str
    """``scored``, ``no_trace`` (the session has no telemetry yet), ``too_large`` or
    ``failed`` (the service did not score it)."""
    passed: bool = False
    label: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    evaluations: int = 0
    """Evaluations the service billed (it charges per evaluation for a custom evaluator)."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "passed": self.passed,
            "label": self.label,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "evaluations": self.evaluations,
        }


def score(
    settings: Settings,
    logs: CloudWatchLogsClient,
    agentcore: BedrockAgentCoreClient,
    *,
    groups: tuple[str, ...],
    session_id: str,
    expected: str,
    judge_model: str,
    start_ms: int,
    end_ms: int,
) -> Verdict:
    evaluator = settings.evaluators.get(judge_model)
    if evaluator is None:
        raise ValueError("not a judge model of this installation")
    if not expected.strip() or len(expected) > MAX_EXPECTED_CHARS:
        raise ValueError("invalid expected answer")
    try:
        found = spans.session_spans(logs, groups, session_id, start_ms, end_ms)
    except spans.TooManySpansError:
        return Verdict("too_large")
    traces = spans.trace_ids(found)
    if not traces:
        return Verdict("no_trace")
    last = traces[-1]
    try:
        response = agentcore.evaluate(
            evaluatorId=evaluator,
            evaluationInput={"sessionSpans": found},
            evaluationTarget={"traceIds": [last]},
            evaluationReferenceInputs=[
                {
                    "context": {"spanContext": {"sessionId": session_id, "traceId": last}},
                    "expectedResponse": {"text": expected},
                }
            ],
        )
    except (ClientError, BotoCoreError) as exc:
        # The error never carries the spans; only its type is logged.
        logger.error("evaluate failed: %s", type(exc).__name__)  # noqa: TRY400 - no spans
        return Verdict("failed")
    results = [r for r in response.get("evaluationResults", []) if isinstance(r, dict)]
    usage = [r.get("tokenUsage") or {} for r in results]
    tokens_in = sum(int(u.get("inputTokens", 0) or 0) for u in usage)
    tokens_out = sum(int(u.get("outputTokens", 0) or 0) for u in usage)
    scored = [r for r in results if not r.get("errorCode")]
    if not scored:
        return Verdict(
            "failed", input_tokens=tokens_in, output_tokens=tokens_out, evaluations=len(results)
        )
    label = str(scored[-1].get("label", ""))[:40]
    # Only the exact label of the scale passes: anything else the judge says is a failure
    # (TM-EV2: an answer that talks the judge into another label does not pass).
    return Verdict(
        "scored",
        passed=label == PASS_LABEL,
        label=label if label in (PASS_LABEL, "FAIL") else "OTHER",
        input_tokens=tokens_in,
        output_tokens=tokens_out,
        evaluations=len(results),
    )
