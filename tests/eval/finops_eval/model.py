"""Data model shared by the runner: questions, expectations, results."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal

from finops_eval.figures import Kind

Verdict = Literal["PASS", "FAIL", "BLOCKED", "ERROR"]
Profile = Literal["central", "sandbox", "security"]
CheckKind = Literal[
    "cost_vs_previous",  # Q1
    "top_services",  # Q2
    "by_account",  # Q3
    "area_cost",  # Q4
    "forecast",  # Q5
    "anomalies",  # Q6
    "by_tag",  # Q7
    "not_available",  # Q8
    "sp_recommendation",  # Q9
    "sp_coverage",  # Q10
    "out_of_scope",  # Q11
    "injection",  # Q12
]


@dataclass(frozen=True)
class Question:
    qid: str
    profile: Profile
    kind: CheckKind
    text: str
    """May use ``{area}``, ``{account_name}`` and ``{account_id}``; filled in at run time so
    no account id is versioned (spec §11)."""

    @property
    def key(self) -> str:
        return f"{self.qid}/{self.profile}"


@dataclass(frozen=True)
class Expected:
    """A figure the answer must contain; ``values`` are equally acceptable readings."""

    label: str
    values: tuple[Decimal, ...]
    kind: Kind = "money"
    required: bool = True


@dataclass(frozen=True)
class Scenario:
    """One acceptable reading of the question (e.g. which period the agent chose)."""

    name: str
    expected: tuple[Expected, ...] = ()
    phrases: tuple[str, ...] = ()
    """Phrase groups that must all be present (e.g. ``no_anomalies``)."""
    tools: tuple[str, ...] = ()
    """At least one of these tools must have completed (evidence of the query)."""
    ranked: bool = False
    """The required figures are a ranking: they must appear from highest to lowest."""


@dataclass(frozen=True)
class GroundTruth:
    scenarios: tuple[Scenario, ...]
    forbidden: tuple[Expected, ...] = ()
    """Figures of accounts outside the user's scope: none may appear in the answer."""
    forbidden_ids: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()
    max_amounts: int | None = None
    """Upper bound of amounts allowed in the answer (0 for answers that must not quote any)."""
    allowed_amounts: tuple[Decimal, ...] = ()
    """Real figures that do not count towards ``max_amounts`` (context the tools did return,
    e.g. the on-demand spend quoted to explain why there is no recommendation)."""


@dataclass
class ChatResult:
    status: int
    text: str = ""
    tools: list[str] = field(default_factory=list)
    """``name:status`` in stream order."""
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: Decimal = Decimal(0)
    stop_reason: str = ""
    first_token_seconds: float | None = None
    total_seconds: float = 0.0
    error_code: str | None = None


@dataclass
class CheckLine:
    label: str
    ok: bool
    expected: str
    found: str
    required: bool = True
    position: int | None = None
    """Where the matched figure appears in the answer; ``None`` when no figure matched."""


@dataclass
class Evaluation:
    verdict: Verdict
    scenario: str = ""
    checks: list[CheckLine] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class QuestionResult:
    question: Question
    text: str
    """The question as asked (placeholders filled in)."""
    chat: ChatResult
    evaluation: Evaluation
