"""Public mail providers: the one list behind sign-up and invitations (D28, D61, TM-P17).

An account of a public provider is a personal account, not one of a company, so neither the
open sign-up (``functions/pre-sign-up``) nor an invitation (``mango_api.people``) accepts it.
The data lives in ``public_mail_domains.json``, next to this module, so the installation
parameters (``infra/lib/config/schema.ts``) read the same file:

* ``families``: providers that serve one brand under many country domains (``outlook.es``,
  ``yahoo.co.uk``, ``live.com.mx``). A domain is theirs when the brand is the registered name:
  ``<brand>.<tld>`` or ``<brand>.<second level>.<two-letter country>``.
* ``domains``: providers, mailbox services of internet providers, disposable inboxes and
  alias relays known by an exact domain.

A subdomain of a public domain is public too (``mail.yahoo.co.uk``). A company subdomain that
only starts with a brand is not (``outlook.empresa.com``).

This is a closed list: a provider nobody listed is not recognized. It lowers the chance of
giving access to a personal account; it does not prove an address belongs to a company.
Standard library only: the pre sign-up trigger imports it and nothing else of this package.
"""

from __future__ import annotations

import json
from importlib import resources

_COUNTRY_LENGTH = 2
_BRAND_TLD = 2  # <brand>.<tld>
_BRAND_SECOND_LEVEL = 3  # <brand>.<second level>.<country>


def _load() -> tuple[frozenset[str], frozenset[str], frozenset[str]]:
    raw = json.loads(
        resources.files(__package__).joinpath("public_mail_domains.json").read_text("utf-8")
    )
    return (
        frozenset(raw["families"]),
        frozenset(raw["secondLevels"]),
        frozenset(raw["domains"]),
    )


PUBLIC_MAIL_FAMILIES, _SECOND_LEVELS, PUBLIC_MAIL_DOMAINS = _load()


def _is_family(labels: list[str]) -> bool:
    if labels[0] not in PUBLIC_MAIL_FAMILIES:
        return False
    if len(labels) == _BRAND_TLD:
        return True
    return (
        len(labels) == _BRAND_SECOND_LEVEL
        and labels[1] in _SECOND_LEVELS
        and len(labels[2]) == _COUNTRY_LENGTH
    )


def is_public_mail_domain(domain: str) -> bool:
    """Whether ``domain``, or a domain it is under, belongs to a public mail provider."""
    labels = domain.strip().lower().rstrip(".").split(".")
    for start in range(len(labels) - 1):
        suffix = labels[start:]
        if ".".join(suffix) in PUBLIC_MAIL_DOMAINS or _is_family(suffix):
            return True
    return False
