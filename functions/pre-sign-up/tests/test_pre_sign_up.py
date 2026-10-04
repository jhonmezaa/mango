import logging
from typing import Any

import pytest

from mango_pre_sign_up import handler
from mango_pre_sign_up.handler import (
    SignUpRejectedError,
    allowed_domains,
    check_email,
    email_domain,
    lambda_handler,
)

DOMAINS = frozenset({"empresa.com", "ventas.empresa.com"})


def _event(email: object, trigger: str = "PreSignUp_SignUp", **extra: Any) -> dict[str, Any]:
    return {
        "version": "1",
        "triggerSource": trigger,
        "userName": "ignored",
        "request": {"userAttributes": {"email": email}, **extra},
        "response": {},
    }


@pytest.mark.parametrize(
    "email",
    [
        "usuario1@empresa.com",
        "Usuario1@EMPRESA.COM",
        "  usuario1@empresa.com  ",
        "usuario1+mango@empresa.com",
        "nombre.apellido@empresa.com",
        "usuario1@ventas.empresa.com",
    ],
)
def test_allowed(email: str) -> None:
    assert check_email(email, DOMAINS)[0]


@pytest.mark.parametrize(
    ("email", "reason"),
    [
        ("x@evilempresa.com", "domain_not_allowed"),
        ("x@empresa.com.evil.io", "domain_not_allowed"),
        ("x@otro.empresa.com", "domain_not_allowed"),  # subdomains only if listed
        ("x@empresa.co", "domain_not_allowed"),
        ("x@empres\u0430.com", "malformed_email"),  # Cyrillic a (U+0430)
        ("x@EMPRESA.COM.", "malformed_email"),
        ("usu\u0430rio@empresa.com", "malformed_email"),  # non-ASCII local part
        ("x@empresa.com@evil.io", "malformed_email"),
        ('"x@evil.io"@empresa.com', "malformed_email"),
        ("x y@empresa.com", "malformed_email"),
        ("x\n@empresa.com", "malformed_email"),
        ("@empresa.com", "malformed_email"),
        ("x@", "malformed_email"),
        ("x", "malformed_email"),
        (".x@empresa.com", "malformed_email"),
        ("x..y@empresa.com", "malformed_email"),
        ("a" * 65 + "@empresa.com", "malformed_email"),
        ("x@" + "a" * 250 + ".com", "malformed_email"),
        ("x@-empresa.com", "malformed_email"),
        ("", "malformed_email"),
        (None, "malformed_email"),
        (42, "malformed_email"),
    ],
)
def test_rejected(email: object, reason: str) -> None:
    allowed, got, _ = check_email(email, DOMAINS)
    assert not allowed
    assert got == reason


def test_domain_is_normalized() -> None:
    assert email_domain(" Ana@Empresa.COM ") == "empresa.com"


@pytest.mark.parametrize("raw", [None, "", " , ", "empresa.com,not a domain", "*.empresa.com"])
def test_invalid_allowlist_fails_closed(raw: str | None) -> None:
    assert allowed_domains(raw) == frozenset()
    assert check_email("usuario1@empresa.com", allowed_domains(raw)) == (
        False,
        "allowlist_unavailable",
        None,
    )


def test_public_mail_domains_are_never_allowed() -> None:
    # The list is a stack parameter (D58): a public provider in it is ignored.
    assert allowed_domains("empresa.com,gmail.com,Outlook.com") == frozenset({"empresa.com"})
    assert allowed_domains("gmail.com") == frozenset()
    # Country variants and disposable inboxes are public providers too.
    variants = "empresa.com,outlook.es,yahoo.co.uk,live.com.mx,mailinator.com"
    assert allowed_domains(variants) == frozenset({"empresa.com"})
    rejected = (False, "allowlist_unavailable", None)
    assert check_email("anyone@gmail.com", allowed_domains("gmail.com")) == rejected


def test_allowlist_is_lowercased() -> None:
    assert allowed_domains("Empresa.com, ventas.empresa.com") == DOMAINS


@pytest.fixture
def allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SIGN_UP_DOMAINS", "empresa.com")


@pytest.mark.usefixtures("allowlist")
@pytest.mark.parametrize("trigger", ["PreSignUp_SignUp", "PreSignUp_ExternalProvider"])
def test_handler_accepts_company_domain_without_auto_confirming(trigger: str) -> None:
    result = lambda_handler(_event("usuario1@empresa.com", trigger), None)
    assert result["response"] == {
        "autoConfirmUser": False,
        "autoVerifyEmail": False,
        "autoVerifyPhone": False,
    }


@pytest.mark.usefixtures("allowlist")
@pytest.mark.parametrize("trigger", ["PreSignUp_SignUp", "PreSignUp_ExternalProvider"])
def test_handler_rejects_other_domains(trigger: str) -> None:
    with pytest.raises(SignUpRejectedError):
        lambda_handler(_event("x@evil.io", trigger), None)


@pytest.mark.usefixtures("allowlist")
def test_handler_ignores_client_metadata_and_validation_data() -> None:
    event = _event(
        "x@evil.io",
        clientMetadata={"email": "usuario1@empresa.com"},
        validationData={"email": "usuario1@empresa.com"},
    )
    with pytest.raises(SignUpRejectedError):
        lambda_handler(event, None)


@pytest.mark.usefixtures("allowlist")
def test_handler_never_honors_auto_confirm_from_the_event() -> None:
    event = _event("usuario1@empresa.com")
    event["response"] = {"autoConfirmUser": True, "autoVerifyEmail": True}
    result = lambda_handler(event, None)
    assert result["response"]["autoConfirmUser"] is False
    assert result["response"]["autoVerifyEmail"] is False


@pytest.mark.usefixtures("allowlist")
def test_admin_create_user_is_allowed() -> None:
    lambda_handler(_event("x@other.example", "PreSignUp_AdminCreateUser"), None)


@pytest.mark.usefixtures("allowlist")
@pytest.mark.parametrize("trigger", [None, "PreSignUp_Other", "PostConfirmation_ConfirmSignUp"])
def test_unknown_trigger_is_rejected(trigger: str | None) -> None:
    event = _event("usuario1@empresa.com")
    event["triggerSource"] = trigger
    with pytest.raises(SignUpRejectedError):
        lambda_handler(event, None)


def test_missing_allowlist_rejects(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SIGN_UP_DOMAINS", raising=False)
    with pytest.raises(SignUpRejectedError):
        lambda_handler(_event("usuario1@empresa.com"), None)


@pytest.mark.usefixtures("allowlist")
def test_logs_never_contain_the_address_or_event(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger=handler.__name__)
    with pytest.raises(SignUpRejectedError):
        lambda_handler(_event("secret.person@evil.io", clientMetadata={"k": "v"}), None)
    records = caplog.records
    assert records
    for record in records:
        text = f"{record.getMessage()} {record.__dict__}"
        assert "secret.person" not in text
        assert "clientMetadata" not in text
    assert records[0].__dict__["email_domain"] == "evil.io"
    assert records[0].__dict__["reason"] == "domain_not_allowed"
