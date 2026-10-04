"""Cognito pre sign-up trigger (D20, threat model ``login-threat-model.md`` TM-L4, TM-L7, TM-L12).

The only server-side control over who may create an account: the email domain must be exactly
one of the company domains in ``SIGN_UP_DOMAINS`` (installation parameter). Fail closed:

* The email is taken from the event's user attributes, never from ``clientMetadata`` or
  ``validationData`` (both are attacker controlled and ignored).
* Only plain ASCII addresses with exactly one ``@`` are accepted. Non-ASCII (homoglyphs such
  as a Cyrillic ``a``, U+0430), quotes, whitespace and control characters are rejected.
* The domain is compared lowercased by **exact equality**: subdomains are allowed only if they
  are listed, and ``evilempresa.com`` or ``empresa.com.evil.io`` never match ``empresa.com``.
* ``+`` aliases are allowed: they reach the same mailbox and do not change the domain.
* Federated sign-ups (``PreSignUp_ExternalProvider``) go through the same check; accounts are
  never linked (TM-L7). ``PreSignUp_AdminCreateUser`` is allowed: only IAM principals (IaC or
  an administrator) can call ``AdminCreateUser``.
* The trigger never auto-confirms users or auto-verifies emails.

Nothing from the event is logged except the rejection reason and, for a well-formed address,
its domain (TM-L12).
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from mango_core.mail_domains import is_public_mail_domain

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

SELF_SIGN_UP = "PreSignUp_SignUp"
EXTERNAL_PROVIDER = "PreSignUp_ExternalProvider"
ADMIN_CREATE_USER = "PreSignUp_AdminCreateUser"
CHECKED_TRIGGERS = frozenset({SELF_SIGN_UP, EXTERNAL_PROVIDER})

MAX_EMAIL_LENGTH = 254
MAX_LOCAL_LENGTH = 64
# RFC 5321 dot-atom local part without quoted strings; `+` aliases allowed.
_LOCAL = re.compile(r"^[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+)*$")
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_DOMAIN = re.compile(rf"^(?=.{{1,253}}$)(?:{_LABEL}\.)+[a-z]{{2,63}}$")

REJECTED_MESSAGE = "Sign-up is not allowed for this email address."


class SignUpRejectedError(Exception):
    """Raised to make Cognito reject the sign-up. The message is shown to the caller."""


def allowed_domains(raw: str | None) -> frozenset[str]:
    """Parse the comma-separated allowlist. Invalid entries make the whole list unusable.

    Public mail providers are dropped from it (D28): the list of an installation is a stack
    parameter (D58), so a public domain in it is ignored, never honored. With nothing else
    left, nobody can register. The providers are ``mango_core.mail_domains``, the same list an
    invitation is checked against.
    """
    domains = frozenset(d.strip().lower() for d in (raw or "").split(",") if d.strip())
    if not domains or not all(_DOMAIN.fullmatch(d) for d in domains):
        return frozenset()
    return frozenset(d for d in domains if not is_public_mail_domain(d))


def email_domain(email: object) -> str | None:
    """Lowercased domain of a well-formed plain ASCII address, or None."""
    if not isinstance(email, str):
        return None
    value = email.strip()
    if not value or len(value) > MAX_EMAIL_LENGTH or not value.isascii():
        return None
    if value.count("@") != 1:
        return None
    local, domain = value.split("@")
    if not 0 < len(local) <= MAX_LOCAL_LENGTH or not _LOCAL.fullmatch(local):
        return None
    domain = domain.lower()
    return domain if _DOMAIN.fullmatch(domain) else None


def check_email(email: object, domains: frozenset[str]) -> tuple[bool, str, str | None]:
    """Return ``(allowed, reason, domain)``; ``domain`` only for well-formed addresses."""
    if not domains:
        return False, "allowlist_unavailable", None
    domain = email_domain(email)
    if domain is None:
        return False, "malformed_email", None
    if domain not in domains:
        return False, "domain_not_allowed", domain
    return True, "allowed", domain


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    trigger = event.get("triggerSource")
    response = event.setdefault("response", {})
    # Explicit: this trigger never confirms users or verifies their email.
    response["autoConfirmUser"] = False
    response["autoVerifyEmail"] = False
    response["autoVerifyPhone"] = False

    if trigger == ADMIN_CREATE_USER:
        return event
    if trigger not in CHECKED_TRIGGERS:
        logger.warning("sign-up rejected", extra={"reason": "unknown_trigger"})
        raise SignUpRejectedError(REJECTED_MESSAGE)

    attributes = (event.get("request") or {}).get("userAttributes") or {}
    allowed, reason, domain = check_email(
        attributes.get("email"), allowed_domains(os.environ.get("SIGN_UP_DOMAINS"))
    )
    if not allowed:
        logger.warning(
            "sign-up rejected",
            extra={"reason": reason, "email_domain": domain, "trigger": trigger},
        )
        raise SignUpRejectedError(REJECTED_MESSAGE)
    return event
