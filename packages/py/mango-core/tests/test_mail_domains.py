import re

import pytest

from mango_core.mail_domains import (
    PUBLIC_MAIL_DOMAINS,
    PUBLIC_MAIL_FAMILIES,
    is_public_mail_domain,
)

_DOMAIN = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
_LABEL = re.compile(r"^[a-z0-9]+$")


@pytest.mark.parametrize(
    "domain",
    [
        # Microsoft
        "outlook.com",
        "outlook.es",
        "outlook.com.ar",
        "outlook.co.uk",
        "hotmail.com",
        "hotmail.es",
        "hotmail.co.uk",
        "hotmail.com.mx",
        "live.com",
        "live.com.mx",
        "live.nl",
        "live.co.uk",
        "msn.com",
        # Yahoo
        "yahoo.com",
        "yahoo.es",
        "yahoo.co.uk",
        "yahoo.com.mx",
        "yahoo.co.jp",
        "ymail.com",
        "rocketmail.com",
        # Google
        "gmail.com",
        "googlemail.com",
        # Apple
        "icloud.com",
        "me.com",
        "mac.com",
        "privaterelay.appleid.com",
        # Others
        "aol.com",
        "aol.de",
        "proton.me",
        "pm.me",
        "protonmail.com",
        "protonmail.ch",
        "gmx.com",
        "gmx.de",
        "gmx.co.uk",
        "mail.com",
        "yandex.com",
        "yandex.ru",
        "yandex.com.tr",
        "zoho.com",
        "zohomail.eu",
        "tutanota.com",
        "tutanota.de",
        "tuta.io",
        "fastmail.com",
        "fastmail.fm",
        "fastmail.com.au",
        # Disposable
        "mailinator.com",
        "yopmail.com",
        "yopmail.fr",
        "guerrillamail.com",
        "guerrillamail.de",
        "10minutemail.net",
        "sharklasers.com",
        "temp-mail.org",
        "maildrop.cc",
    ],
)
def test_public_providers_and_their_country_variants(domain: str) -> None:
    assert is_public_mail_domain(domain)


@pytest.mark.parametrize(
    "domain", ["GMAIL.com", "Outlook.ES", " yahoo.co.uk ", "mail.yahoo.co.uk", "x.mailinator.com"]
)
def test_case_spaces_and_subdomains_do_not_hide_a_public_provider(domain: str) -> None:
    assert is_public_mail_domain(domain)


@pytest.mark.parametrize(
    "domain",
    [
        "empresa.com",
        "example.com",
        "socio.example.org",
        # A brand as a subdomain or inside another name is a company's own domain.
        "outlook.empresa.com",
        "yahoo.empresa.com.mx",
        "notgmail.com",
        "gmail.com.empresa.io",
        "myoutlook.es",
        "live-events.com",
        # Not a country second level.
        "yahoo.empresa.es",
        "localhost",
        "",
    ],
)
def test_company_domains_are_not_public(domain: str) -> None:
    assert not is_public_mail_domain(domain)


def test_the_data_is_well_formed() -> None:
    assert all(_DOMAIN.fullmatch(d) for d in PUBLIC_MAIL_DOMAINS)
    assert all(_LABEL.fullmatch(f) for f in PUBLIC_MAIL_FAMILIES)
    # Reserved for documentation and tests (RFC 2606, RFC 6761): never public providers.
    assert not any(is_public_mail_domain(d) for d in ("example.com", "example.org", "a.invalid"))
