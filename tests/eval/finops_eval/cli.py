"""Command line entry point of the FinOps evaluation."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from finops_eval import client, ground_truth, questions, report
from finops_eval.checks import evaluate
from finops_eval.ground_truth import GroundTruthBuilder, Periods, Scope
from finops_eval.model import ChatResult, Evaluation, Question, QuestionResult

if TYPE_CHECKING:
    import httpx

REGION = "us-east-1"
CENTRAL = "central"
CENTRAL_GROUP = "finops-central"
PAYMENT_REQUIRED = 402
TOLERANCE = "±1 % frente a Cost Explorer, o ±0,005 USD cuando el redondeo a 2 decimales es mayor"
DEFAULT_REPORTS = Path(__file__).resolve().parents[1] / "reports"


@dataclass(frozen=True)
class Installation:
    app_url: str
    pool_id: str
    client_id: str
    areas: dict[str, frozenset[str]]
    users: dict[str, str]
    """Profile -> e-mail of its e2e user."""


def _load_installation(args: argparse.Namespace, lab: boto3.Session) -> Installation:
    config = json.loads(args.config.read_text())
    stacks = lab.client("cloudformation").describe_stacks(StackName=args.stack)["Stacks"]
    outputs = {o["OutputKey"]: o["OutputValue"] for o in stacks[0].get("Outputs", [])}
    app_url = (args.app_url or outputs["AppUrl"]).rstrip("/")
    if not app_url.startswith("https://"):
        raise SystemExit("the installation URL must be https (the access token travels in it)")
    areas = {bu: frozenset(ous) for bu, ous in config["businessUnits"].items()}
    users: dict[str, str] = {}
    for user in config["users"]:
        if not user.get("e2e"):
            continue
        groups = set(user["groups"])
        profile = CENTRAL if CENTRAL_GROUP in groups else None
        for area in areas:
            if {"bu-lead", f"bu-{area}"} <= groups:
                profile = area
        if profile:
            users.setdefault(profile, user["email"])
    return Installation(app_url, outputs["UserPoolId"], outputs["WebClientId"], areas, users)


@dataclass(frozen=True)
class Run:
    installation: Installation
    builder: GroundTruthBuilder
    http: httpx.Client
    area: str
    """Business unit asked about in Q4."""

    def scope(self, profile: str) -> Scope:
        if profile == CENTRAL:
            return Scope(CENTRAL, None)
        return ground_truth.area_scope(
            profile, self.builder.accounts, self.installation.areas[profile]
        )

    def question_text(self, question: Question, scope: Scope) -> str:
        if question.kind == "area_cost":
            return question.text.format(area=self.area)
        if question.kind == "out_of_scope":
            account = ground_truth.other_area_account(self.builder, scope)
            return question.text.format(account_name=account.name, account_id=account.account_id)
        return question.text

    def evaluate(self, question: Question, text: str, chat: ChatResult, scope: Scope) -> Evaluation:
        try:
            # Computed right after the answer so both read the same Cost Explorer data.
            truth = ground_truth.build(self.builder, question, scope, self.area)
        except (ClientError, BotoCoreError) as exc:
            return Evaluation(
                "ERROR", notes=[f"No se pudo calcular la referencia: {type(exc).__name__}."]
            )
        return evaluate(text, chat, truth)

    def skipped(self, profile: str, selected: list[Question], reason: str) -> list[QuestionResult]:
        scope = self.scope(profile)
        print(f"{profile}: skipped ({len(selected)} questions)", flush=True)
        return [
            QuestionResult(
                q,
                self.question_text(q, scope),
                ChatResult(status=0, error_code="not_asked"),
                Evaluation("ERROR", notes=[reason]),
            )
            for q in selected
        ]

    def profile(self, profile: str, selected: list[Question], token: str) -> list[QuestionResult]:
        """Ask the questions of one profile. After a 402 the rest are reported as blocked
        without calling the API again."""
        scope = self.scope(profile)
        results: list[QuestionResult] = []
        blocked = False
        for question in selected:
            text = self.question_text(question, scope)
            if blocked:
                chat = ChatResult(status=PAYMENT_REQUIRED, error_code="budget_exceeded")
                evaluation = Evaluation(
                    "BLOCKED", notes=["No se preguntó: presupuesto ya agotado."]
                )
            else:
                chat = client.ask(self.http, self.installation.app_url, token, text)
                evaluation = self.evaluate(question, text, chat, scope)
                blocked = chat.status == PAYMENT_REQUIRED
            results.append(QuestionResult(question, text, chat, evaluation))
            # Progress only: no question, answer or figure goes to the console.
            print(
                f"{question.key:<14} {evaluation.verdict:<8} {chat.total_seconds:6.1f}s "
                f"tools={len(chat.tools) // 2}",
                flush=True,
            )
        return results


def _sign_in(idp: Any, installation: Installation, profile: str, secrets: Path) -> str:
    email = installation.users.get(profile)
    if email is None:
        raise client.SignInError(f"no e2e user for profile {profile} in the configuration")
    return client.sign_in(
        idp,
        installation.pool_id,
        installation.client_id,
        client.load_credentials(secrets, email),
    )


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, help="AWS profile of the Mango account")
    parser.add_argument(
        "--payer-profile", required=True, help="AWS profile of the payer (read-only)"
    )
    parser.add_argument("--secrets", required=True, type=Path, help="e2e secrets file (read only)")
    parser.add_argument("--config", type=Path, default=Path("infra/config/poc.json"))
    parser.add_argument("--stack", default="Mango-poc-Core")
    parser.add_argument("--app-url", help="defaults to the AppUrl output of the stack")
    parser.add_argument("--area", help="business unit asked about in Q4 (default: the last one)")
    parser.add_argument("--only", default="", help="comma separated ids, e.g. Q5,Q11/sandbox")
    parser.add_argument("--profiles", default="", help="comma separated: central,sandbox,security")
    parser.add_argument("--reports-dir", type=Path, default=DEFAULT_REPORTS)
    return parser.parse_args(argv)


def _split(value: str) -> frozenset[str]:
    return frozenset(v.strip() for v in value.split(",") if v.strip())


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    started = datetime.now(UTC)
    periods = Periods(started.date())
    selected = questions.select(_split(args.only), _split(args.profiles))
    if not selected:
        raise SystemExit("no questions selected")

    lab = boto3.Session(profile_name=args.profile, region_name=REGION)
    payer = boto3.Session(profile_name=args.payer_profile, region_name=REGION)
    installation = _load_installation(args, lab)
    area = args.area or sorted(installation.areas)[-1]

    ce: Any = payer.client("ce")
    window = (periods.history_start, periods.tomorrow)
    builder = GroundTruthBuilder(
        ce=ce,
        periods=periods,
        accounts=ground_truth.load_org(payer.client("organizations")),
        areas=installation.areas,
        services=ground_truth.fetch_cube(ce, window, "DIMENSION", "SERVICE"),
        tags=ground_truth.fetch_cube(ce, window, "TAG", ground_truth.TAG_KEY),
    )

    idp = lab.client("cognito-idp")
    results: list[QuestionResult] = []
    with client.http_client() as http:
        run = Run(installation, builder, http, area)
        for profile in dict.fromkeys(q.profile for q in selected):
            mine = [q for q in selected if q.profile == profile]
            try:
                token = _sign_in(idp, installation, profile, args.secrets)
            except (client.SignInError, ClientError, BotoCoreError) as exc:
                # One profile that cannot sign in must not lose the answers of the others.
                reason = str(exc) if isinstance(exc, client.SignInError) else type(exc).__name__
                results += run.skipped(profile, mine, f"No se pudo iniciar sesión: {reason}.")
                continue
            results += run.profile(profile, mine, token)

    info = report.RunInfo(started, installation.app_url, periods.today.isoformat(), TOLERANCE)
    json_path, md_path = report.write(args.reports_dir, info, results)
    print(json.dumps(report.summary(results), ensure_ascii=False))
    print(f"report: {md_path}\nreport: {json_path}")
    return 0 if all(r.evaluation.verdict == "PASS" for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
