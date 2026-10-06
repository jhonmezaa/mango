#!/usr/bin/env python3
"""How many people the Bedrock quotas of this account let chat at once.

The chat of an installation is capped by the Bedrock quotas of the AWS account long before
mango-api runs out of anything: every chat turn is at least one model call, and one more for
each round of tools. An account can have a quota far below the AWS default (10 requests per
minute where the default is 10,000, seen on a new account), and then five people chatting at
once already wait or fail.

For each model, reads the quota **applied** to the account (requests and tokens per minute),
compares it with the AWS default and says what it is enough for. Read-only.

Usage, with the credentials of whoever installs, in the account and Region of Mango:

    check-bedrock-quotas.py                      # before installing: the models of the release
    check-bedrock-quotas.py --namespace <ns>     # after: the enabled models of the installation
    check-bedrock-quotas.py --model <id> ...     # any inference profile or model id

Exit status: 0 when every quota is at least the AWS default, 1 when one is below it or could
not be read. Standard library and ``aws`` only.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

RELEASE_DEFAULTS = Path(__file__).resolve().parent.parent / "release-defaults.json"
SERVICE = "bedrock"
MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:_-]{0,199}$")
NAMESPACE = re.compile(r"^[a-z0-9]{3,8}$")
# An inference profile is the model id behind the name of the geography it routes in.
PROFILE = re.compile(r"^(global|[a-z]{2,6}(?:-[a-z]+)?)\.(.+\..+)$")

ACTIVE_PEOPLE = 300
"""People active at once that two mango-api tasks were measured to serve with room to spare
(D70, 2026-10-06), each sending one chat turn a minute."""
TOKENS_PER_TURN = 3300
"""Tokens of one measured turn of an agent that used no tools (3,030 in, 250 out)."""

Run = Callable[[Sequence[str]], str]


class QuotaError(Exception):
    """The quotas could not be read."""


@dataclass(frozen=True)
class Limit:
    code: str
    name: str
    applied: float
    default: float | None


@dataclass(frozen=True)
class Report:
    model: str
    requests: Limit | None
    tokens: Limit | None
    problem: str = ""

    @property
    def turns_per_minute(self) -> int | None:
        if self.requests is None:
            return None
        turns = self.requests.applied
        if self.tokens is not None:
            turns = min(turns, self.tokens.applied / TOKENS_PER_TURN)
        return int(turns)

    @property
    def below_default(self) -> list[Limit]:
        return [
            limit
            for limit in (self.requests, self.tokens)
            if limit is not None and limit.default is not None and limit.applied < limit.default
        ]

    @property
    def needs_action(self) -> bool:
        return self.requests is None or bool(self.below_default)


def aws(arguments: Sequence[str]) -> str:
    result = subprocess.run(  # noqa: S603 - fixed command, arguments validated, no shell
        ["aws", *arguments, "--output", "json"],  # noqa: S607
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        lines = result.stderr.strip().splitlines()
        raise QuotaError(lines[-1] if lines else f"aws {arguments[0]} failed")
    return result.stdout


def kind_and_base(model: str) -> tuple[str, str]:
    """How Service Quotas words the quota of this id, and the base model id behind it."""
    match = PROFILE.match(model)
    if match is None:
        return "On-demand", model
    return ("Global cross-region" if match.group(1) == "global" else "Cross-region"), match.group(2)


def _plain(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9. ]", " ", text.lower())).strip()


def _model_part(quota_name: str, provider: str) -> str:
    """The model a quota name ends with, without the provider and without a version suffix."""
    part = _plain(quota_name.rsplit(" for ", 1)[-1])
    provider = _plain(provider)
    if part.startswith(provider + " "):
        part = part[len(provider) + 1 :]
    return re.sub(r" v\d+$", "", part)


def find_quota(
    quotas: list[dict[str, object]], kind: str, unit: str, provider: str, name: str
) -> dict[str, object] | None:
    """The quota of ``kind`` for this model, by its name: Service Quotas does not carry the
    model id. Exactly one must match; anything else is reported, never guessed."""
    prefix = _plain(f"{kind} model inference {unit} per minute for ")
    wanted = re.sub(r" v\d+$", "", _plain(name))
    found = [
        quota
        for quota in quotas
        if _plain(str(quota.get("QuotaName", "")).rsplit(" for ", 1)[0] + " for ") == prefix
        and _model_part(str(quota.get("QuotaName", "")), provider) == wanted
    ]
    return found[0] if len(found) == 1 else None


def models_of_release(path: Path = RELEASE_DEFAULTS) -> list[str]:
    return list(dict.fromkeys(json.loads(path.read_text())["models"].values()))


def models_of_installation(run: Run, namespace: str, region: str) -> list[str]:
    """Enabled models of the catalog of an installation (item MODELS/CATALOG of Settings)."""
    out = run(
        [
            "dynamodb",
            "get-item",
            "--region",
            region,
            "--table-name",
            f"Mango-{namespace}-Settings",
            "--key",
            '{"PK":{"S":"MODELS"},"SK":{"S":"CATALOG"}}',
            "--projection-expression",
            "models",
        ]
    )
    try:
        catalog = json.loads(json.loads(out)["Item"]["models"]["S"])
        return [str(m["id"]) for m in catalog if m.get("enabled")]
    except (KeyError, TypeError, ValueError) as error:
        raise QuotaError(f"no model catalog in Mango-{namespace}-Settings") from error


def check(run: Run, models: Sequence[str], region: str) -> list[Report]:
    listed = json.loads(run(["bedrock", "list-foundation-models", "--region", region]))
    known = {
        str(m["modelId"]): (str(m.get("providerName", "")), str(m.get("modelName", "")))
        for m in listed.get("modelSummaries", [])
    }
    listing = ["service-quotas", "list-service-quotas", "--service-code", SERVICE]
    quotas = json.loads(run([*listing, "--region", region])).get("Quotas", [])

    def default_of(code: str) -> float | None:
        try:
            out = run(
                [
                    "service-quotas",
                    "get-aws-default-service-quota",
                    "--service-code",
                    SERVICE,
                    "--quota-code",
                    code,
                    "--region",
                    region,
                ]
            )
            return float(json.loads(out)["Quota"]["Value"])
        except (QuotaError, KeyError, TypeError, ValueError):
            return None

    def limit(kind: str, unit: str, provider: str, name: str) -> Limit | None:
        quota = find_quota(quotas, kind, unit, provider, name)
        if quota is None:
            return None
        code = str(quota["QuotaCode"])
        return Limit(code, str(quota["QuotaName"]), float(str(quota["Value"])), default_of(code))

    reports = []
    for model in models:
        kind, base = kind_and_base(model)
        if base not in known:
            reports.append(Report(model, None, None, "Bedrock does not list this model here"))
            continue
        provider, name = known[base]
        requests = limit(kind, "requests", provider, name)
        reports.append(
            Report(
                model,
                requests,
                limit(kind, "tokens", provider, name),
                ""
                if requests
                else f'no single "{kind} model inference requests per minute" quota named '
                f"after {provider} {name}",
            )
        )
    return reports


def _number(value: float) -> str:
    return f"{int(value):,}"


def render(reports: Sequence[Report], region: str) -> str:
    lines = [f"Bedrock quotas applied to this account in {region}", ""]
    for report in reports:
        lines.append(report.model)
        if report.requests is None:
            lines += [
                f"  NOT READ: {report.problem}.",
                "  Look it up in Service Quotas > Amazon Bedrock, under the name of the model.",
                "",
            ]
            continue
        for label, limit in (("requests", report.requests), ("tokens", report.tokens)):
            if limit is None:
                lines.append(f"  {label} per minute: not found")
                continue
            default = "unknown" if limit.default is None else _number(limit.default)
            lines.append(
                f"  {label} per minute: {_number(limit.applied)} applied, AWS default {default}"
                f" ({limit.code})"
            )
        turns = report.turns_per_minute or 0
        lines.append(
            f"  Enough for about {_number(turns)} chat turns a minute: {_number(turns)} people"
            " active at once at a turn a minute each if the agent uses no tools, about"
            f" {_number(turns / 2)} with one round of tools per turn (each round is one more call)."
        )
        if turns < ACTIVE_PEOPLE:
            lines.append(
                f"  LOW: two mango-api tasks serve about {ACTIVE_PEOPLE} active people; with this"
                " quota the model is the ceiling, and people over it wait or get a failed turn."
            )
        if report.below_default:
            codes = ", ".join(limit.code for limit in report.below_default)
            lines += [
                f"  BELOW THE AWS DEFAULT ({codes}). Service Quotas refuses an increase request"
                " for a value at or under the default, so it cannot be raised from there:",
                "  open a case in the Support Center console (Create case > Service limit"
                " increase > Amazon Bedrock) and ask for the default value to be restored.",
                "  The Basic support plan allows that case; its API does not.",
            ]
        elif turns < ACTIVE_PEOPLE:
            lines.append(
                "  To raise it: Service Quotas > Amazon Bedrock > the quota above > Request"
                " increase at account level."
            )
        lines.append("")
    if any(report.needs_action for report in reports):
        lines.append("ACTION NEEDED: a quota is below the AWS default or could not be read.")
    else:
        lines.append("OK: every quota is at least the AWS default.")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None, run: Run = aws) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n", 1)[0])
    parser.add_argument("--namespace", help="read the enabled models of this installation")
    parser.add_argument("--model", action="append", default=[], help="a model or profile id")
    parser.add_argument("--region", default="us-east-1")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[a-z]{2}(-[a-z]+)+-\d", args.region):
        parser.error("--region is not a Region name")
    if args.namespace is not None and not NAMESPACE.fullmatch(args.namespace):
        parser.error("--namespace is 3 to 8 lowercase letters or digits")
    if any(not MODEL_ID.fullmatch(model) for model in args.model):
        parser.error("--model is not a model id")
    try:
        models = list(args.model)
        if args.namespace:
            models += models_of_installation(run, args.namespace, args.region)
        elif not models:
            models = models_of_release()
        reports = check(run, list(dict.fromkeys(models)), args.region)
    except (QuotaError, OSError, ValueError, KeyError) as error:
        print(f"NOT CHECKED: {error}", file=sys.stderr)
        return 1
    print(render(reports, args.region))
    return 1 if any(report.needs_action for report in reports) else 0


if __name__ == "__main__":
    sys.exit(main())
