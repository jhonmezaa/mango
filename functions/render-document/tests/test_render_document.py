"""render-document (D117, TM-CI8): the event contract, the closed list of types read from the
bytes, the profile of LibreOffice and what is written back to S3. No network and no AWS.

LibreOffice itself runs only where it is installed (the image): the conversion test is skipped
elsewhere; it runs inside the image (`functions/render-document/README.md`).
"""

from __future__ import annotations

import io
import shutil
import subprocess
import time
import zipfile
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_render_document import convert, handler, ooxml

BUCKET = "mango-ns-chat-files-example"
SUB = "0b8c4f2e-1d2a-4c5b-9e7f-112233445566"
CONVERSATION = "0123456789abcdef0123456789abcdef"
KEY_IN = f"owner/{SUB}/conv/{CONVERSATION}/01JFILE0000000000000000000"
PREFIX = f"owner/{SUB}/conv/{CONVERSATION}/renders/01JRENDER00000000000000000/"

WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
EXCEL = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"


def ooxml_package(main_type: str = WORD, extra: dict[str, bytes] | None = None) -> bytes:
    """The smallest Word document LibreOffice opens, built here: no file, no network."""
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" '
        'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        f'<Override PartName="/word/document.xml" ContentType="{main_type}"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        'relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    )
    paragraphs = "".join(
        f"<w:p><w:r><w:t>Mango render {n}</w:t></w:r></w:p>"
        + ('<w:p><w:r><w:br w:type="page"/></w:r></w:p>' if n < 3 else "")
        for n in range(1, 4)
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{paragraphs}</w:body></w:document>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", content_types)
        package.writestr("_rels/.rels", rels)
        package.writestr("word/document.xml", document)
        for name, data in (extra or {}).items():
            package.writestr(name, data)
    return buffer.getvalue()


def _file(tmp_path: Path, data: bytes) -> Path:
    path = tmp_path / "source"
    path.write_bytes(data)
    return path


# --- Types, from the bytes ---------------------------------------------------------------------


def test_a_word_package_is_a_docx_whatever_its_name(tmp_path: Path) -> None:
    kind = ooxml.classify(_file(tmp_path, ooxml_package()))
    assert (kind.name, kind.extension, kind.import_filter) == ("docx", ".docx", "MS Word 2007 XML")


def test_a_spreadsheet_package_is_an_xlsx(tmp_path: Path) -> None:
    assert ooxml.classify(_file(tmp_path, ooxml_package(EXCEL))).name == "xlsx"


@pytest.mark.parametrize(
    ("data", "reason"),
    [
        (b"%PDF-1.7\n", "type"),
        (b"{\\rtf1 not a package}", "type"),
        (ooxml_package("application/vnd.ms-word.document.macroEnabled.main+xml"), "macros"),
        (ooxml_package(extra={"word/vbaProject.bin": b"\0" * 16}), "macros"),
        (ooxml_package(extra={"word/activeX/activeX1.xml": b"<x/>"}), "macros"),
        (ooxml_package("application/vnd.oasis.opendocument.text"), "type"),
    ],
)
def test_anything_else_is_refused_before_libreoffice_opens_it(
    tmp_path: Path, data: bytes, reason: str
) -> None:
    with pytest.raises(ooxml.NotRenderable) as refused:
        ooxml.classify(_file(tmp_path, data))
    assert refused.value.reason == reason


def _rewrite_content_types(data: bytes, old: bytes, new: bytes) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as source, zipfile.ZipFile(buffer, "w") as target:
        for item in source.infolist():
            part = source.read(item)
            if item.filename == ooxml.CONTENT_TYPES:
                part = part.replace(old, new)
            target.writestr(item, part)
    return buffer.getvalue()


@pytest.mark.parametrize(
    ("old", "new"),
    [
        # Two main parts: which one LibreOffice would open is not for the file to decide.
        (
            b"</Types>",
            f'<Override PartName="/xl/workbook.xml" ContentType="{EXCEL}"/></Types>'.encode(),
        ),
        # A DOCTYPE (entities): refused, never parsed.
        (b"<Types", b'<!DOCTYPE t [<!ENTITY a "a">]><Types'),
    ],
)
def test_two_main_parts_or_a_doctype_are_refused(tmp_path: Path, old: bytes, new: bytes) -> None:
    data = _rewrite_content_types(ooxml_package(), old, new)
    with pytest.raises(ooxml.NotRenderable) as refused:
        ooxml.classify(_file(tmp_path, data))
    assert refused.value.reason == "type"


def test_a_zip_bomb_is_refused_from_its_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(ooxml, "MAX_UNCOMPRESSED_BYTES", 1024)
    data = ooxml_package(extra={"word/media/big.bin": b"\0" * 4096})
    with pytest.raises(ooxml.NotRenderable) as refused:
        ooxml.classify(_file(tmp_path, data))
    assert refused.value.reason == "size"


# --- The profile and the processes -------------------------------------------------------------


def test_the_profile_turns_macros_links_and_the_network_off() -> None:
    xml = convert.profile_xml()
    settings = {(path, name): value for path, name, _kind, value in convert.PROFILE_SETTINGS}
    scripting = "/org.openoffice.Office.Common/Security/Scripting"
    assert settings[(scripting, "DisableMacrosExecution")] == "true"
    assert settings[(scripting, "MacroSecurityLevel")] == "3"
    assert settings[("/org.openoffice.Office.Writer/Content/Update", "Link")] == "0"
    assert settings[("/org.openoffice.Office.Calc/Content/Update", "Link")] == "1"
    assert settings[("/org.openoffice.Inet/Settings", "ooInetProxyType")] == "1"
    assert settings[("/org.openoffice.Inet/Settings", "ooInetHTTPSProxyPort")] == "9"
    assert xml.count("<item ") == len(convert.PROFILE_SETTINGS)


def test_the_programs_never_see_the_credentials_of_the_function(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "token")
    env = convert.environment(tmp_path)
    assert not [name for name in env if name.startswith("AWS_")]
    assert env["https_proxy"] == env["HTTPS_PROXY"] == convert.DEAD_PROXY
    assert env["no_proxy"] == ""
    assert env["HOME"] == str(tmp_path)


def test_libreoffice_runs_with_a_profile_of_its_own_and_the_filter_of_the_bytes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seen: list[list[str]] = []

    def fake_run(
        command: list[str], work: Path, seconds: int
    ) -> subprocess.CompletedProcess[bytes]:
        seen.append(command)
        (work / "out" / "document.pdf").write_bytes(b"%PDF-1.7 fake")
        return subprocess.CompletedProcess(command, 0, b"", b"")

    monkeypatch.setattr(convert, "_run", fake_run)
    source = _file(tmp_path, ooxml_package())
    work = tmp_path / "work"
    work.mkdir()
    pdf = convert.to_pdf(source, ooxml.classify(source), work)
    assert pdf == work / "out" / "document.pdf"
    command = seen[0]
    assert f"-env:UserInstallation={(work / 'profile').as_uri()}" in command
    assert "--infilter=MS Word 2007 XML" in command
    assert {"--headless", "--norestore", "--nolockcheck"} <= set(command)
    profile = (work / "profile" / "user" / "registrymodifications.xcu").read_text()
    assert "DisableMacrosExecution" in profile


def test_a_conversion_past_its_time_kills_its_session(tmp_path: Path) -> None:
    started = time.monotonic()
    with pytest.raises(convert.ConversionError) as failed:
        convert._run(["/bin/sh", "-c", "sleep 30 & sleep 30"], tmp_path, 1)
    assert failed.value.reason == "timeout"
    assert time.monotonic() - started < 10


@pytest.mark.skipif(shutil.which("soffice") is None, reason="LibreOffice is only in the image")
def test_libreoffice_renders_a_word_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(convert, "SOFFICE", shutil.which("soffice") or "")
    monkeypatch.setattr(convert, "PDFTOPPM", shutil.which("pdftoppm") or "")
    monkeypatch.setattr(convert, "PDFINFO", shutil.which("pdfinfo") or "")
    source = _file(tmp_path, ooxml_package())
    work = tmp_path / "work"
    work.mkdir()
    pages = convert.render(source, ooxml.classify(source), work, 2)
    assert pages.total == 3
    assert [p.name for p in pages.pngs] == ["page-001.png", "page-002.png"]
    assert all(p.read_bytes().startswith(b"\x89PNG") for p in pages.pngs)


# --- The handler -------------------------------------------------------------------------------


class Body(io.BytesIO):
    pass


class FakeS3:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = dict(objects)
        self.puts: list[dict[str, Any]] = []

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        assert Bucket == BUCKET
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")
        data = self.objects[Key]
        return {"Body": Body(data), "ContentLength": len(data)}

    def put_object(self, **request: Any) -> dict[str, Any]:
        assert request["Bucket"] == BUCKET
        assert request["IfNoneMatch"] == "*"
        if request["Key"] in self.objects:
            raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")
        self.objects[request["Key"]] = request["Body"]
        self.puts.append(request)
        return {}


def _event(**changes: Any) -> dict[str, Any]:
    return {"bucket": BUCKET, "key_in": KEY_IN, "key_out_prefix": PREFIX, "pages_max": 2} | changes


@pytest.fixture
def fake_render(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[Path]:
    """LibreOffice and Poppler as the image runs them, without the image."""
    works: list[Path] = []

    def render(source: Path, kind: ooxml.Kind, work: Path, pages_max: int) -> convert.Pages:
        works.append(work)
        pdf = work / "document.pdf"
        pdf.write_bytes(b"%PDF-1.7")
        pngs = []
        for n in range(1, min(3, pages_max) + 1):
            pngs.append(work / f"page-{n:03d}.png")
            pngs[-1].write_bytes(b"\x89PNG")
        return convert.Pages(pdf=pdf, pngs=pngs, total=3)

    monkeypatch.setattr(handler, "render", render)
    monkeypatch.setattr(handler, "WORK_ROOT", tmp_path)
    return works


def test_a_document_comes_back_as_a_pdf_and_its_first_pages(fake_render: list[Path]) -> None:
    s3 = FakeS3({KEY_IN: ooxml_package()})
    answer = handler.Renderer(s3, BUCKET).handle(_event())  # type: ignore[arg-type]
    assert answer == {
        "status": "ready",
        "kind": "docx",
        "pdf_key": f"{PREFIX}document.pdf",
        "page_keys": [f"{PREFIX}page-001.png", f"{PREFIX}page-002.png"],
        "pages_total": 3,
        "pages_rendered": 2,
        "truncated": True,
    }
    assert [p["ContentType"] for p in s3.puts] == ["application/pdf", "image/png", "image/png"]
    # Nothing of the document stays in the container for the next invocation.
    assert not fake_render[0].exists()


@pytest.mark.parametrize(
    "changes",
    [
        {"bucket": "another-bucket"},
        {"key_in": f"uploads/{SUB}/01JFILE"},
        {"key_in": f"owner/{SUB}/conv/{CONVERSATION}/../other/01JFILE"},
        # The layout of the chat files is `owner/<sub>/conv/<conversation>/<file>` (U1).
        {"key_in": f"owner/{SUB}/{CONVERSATION}/01JFILE0000000000000000000"},
        {"key_out_prefix": f"owner/{SUB}/{CONVERSATION}/renders/01JR/"},
        # Another person's render prefix, or another conversation.
        {"key_out_prefix": PREFIX.replace(SUB, SUB.replace("0b8c", "ffff"))},
        {"key_out_prefix": f"owner/{SUB}/conv/fedcba9876543210fedcba9876543210/renders/01JR/"},
        # Outside `renders/`: it would replace a file of the person.
        {"key_out_prefix": f"owner/{SUB}/conv/{CONVERSATION}/"},
        {"pages_max": 0},
        {"pages_max": 51},
        {"pages_max": True},
        {"pages_max": "2"},
        {"extra": "field"},
    ],
)
def test_an_event_outside_the_contract_is_refused(
    fake_render: list[Path], changes: dict[str, Any]
) -> None:
    s3 = FakeS3({KEY_IN: ooxml_package()})
    answer = handler.Renderer(s3, BUCKET).handle(_event(**changes))  # type: ignore[arg-type]
    assert answer == {"status": "refused", "reason": "event"}
    assert s3.puts == []


def test_an_object_that_is_not_there_or_not_scanned_is_not_found(fake_render: list[Path]) -> None:
    answer = handler.Renderer(FakeS3({}), BUCKET).handle(_event())  # type: ignore[arg-type]
    assert answer == {"status": "refused", "reason": "not_found"}


def test_a_file_larger_than_a_chat_file_is_not_read(
    fake_render: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(handler, "MAX_INPUT_BYTES", 10)
    s3 = FakeS3({KEY_IN: ooxml_package()})
    answer = handler.Renderer(s3, BUCKET).handle(_event())  # type: ignore[arg-type]
    assert answer == {"status": "refused", "reason": "size"}


def test_a_macro_document_is_refused_and_nothing_is_written(fake_render: list[Path]) -> None:
    s3 = FakeS3({KEY_IN: ooxml_package(extra={"word/vbaProject.bin": b"\0"})})
    answer = handler.Renderer(s3, BUCKET).handle(_event())  # type: ignore[arg-type]
    assert answer == {"status": "refused", "reason": "macros"}
    assert s3.puts == []
    assert fake_render == []


def test_a_failed_conversion_is_answered_with_its_code(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def render(*_: Any) -> convert.Pages:
        raise convert.ConversionError("timeout")

    monkeypatch.setattr(handler, "render", render)
    monkeypatch.setattr(handler, "WORK_ROOT", tmp_path)
    s3 = FakeS3({KEY_IN: ooxml_package()})
    answer = handler.Renderer(s3, BUCKET).handle(_event())  # type: ignore[arg-type]
    assert answer == {"status": "failed", "reason": "timeout"}
    assert list(tmp_path.iterdir()) == []


def test_a_render_never_replaces_an_object(fake_render: list[Path]) -> None:
    s3 = FakeS3({KEY_IN: ooxml_package(), f"{PREFIX}document.pdf": b"earlier"})
    with pytest.raises(ClientError):
        handler.Renderer(s3, BUCKET).handle(_event())  # type: ignore[arg-type]
    assert s3.objects[f"{PREFIX}document.pdf"] == b"earlier"
