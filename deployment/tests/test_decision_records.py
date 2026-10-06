"""The decision register stays in step: one file per decision and one index line for each.

The index is the table of §8 of the reference architecture; the files live in
`docs/architecture/decisions/`. How a decision is recorded: the README of that folder.
"""

import re
from pathlib import Path

import pytest

REPO = Path(__file__).parents[2]
ARCHITECTURE = REPO / "docs" / "architecture" / "reference-architecture.md"
DECISIONS = ARCHITECTURE.parent / "decisions"
README = DECISIONS / "README.md"
FILES = sorted(DECISIONS.glob("D*.md"))

FILE_NAME = re.compile(r"D(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.md")
INDEX_ROW = re.compile(r"^\| D(\d+) \| (.+) \| (.+) \| (.+) \| \[(.+)\]\(decisions/(.+)\) \|$")
STATES = ("propuesta", "vigente", "parcial", "pendiente")
SUPERSEDED = re.compile(r"reemplazada por D(\d+)")
FIELDS = ("Estado", "Fecha", "Precisa / reemplaza a", "Precisada por")
# `[text](target)`, outside code spans; targets with a scheme are not files of the repository.
LINK = re.compile(r"\[[^\]\n]*\]\(([^)\s]+)\)")
CODE = re.compile(r"```.*?```|`[^`\n]*`", re.DOTALL)


def _index() -> dict[int, dict[str, str]]:
    text = ARCHITECTURE.read_text()
    section = text.split("\n## 8. Registro de decisiones\n", 1)[1].split("\n## ", 1)[0]
    rows: dict[int, dict[str, str]] = {}
    for line in section.splitlines():
        if not line.startswith("| D"):
            continue
        match = INDEX_ROW.match(line)
        assert match is not None, f"index line with another shape: {line[:80]}"
        number = int(match[1])
        assert number not in rows, f"D{number} is twice in the index"
        assert match[5] == match[6], f"D{number}: the link text is not its target"
        rows[number] = {"title": match[2], "state": match[3], "date": match[4], "file": match[6]}
    return rows


def _record(path: Path) -> dict[str, str]:
    lines = path.read_text().splitlines()
    title = re.fullmatch(r"# D(\d+) · (.+)", lines[0])
    assert title is not None, f"{path.name}: the first line is not «# Dn · tema»"
    fields = {"number": title[1], "title": title[2]}
    for line in lines[1:]:
        field = re.match(r"- \*\*(.+?):\*\* (.+)", line)
        if field is not None:
            fields.setdefault(field[1], field[2])
    return fields


def _state(value: str) -> str:
    """The state without the note that may follow it («parcial. Falta …»)."""
    superseded = SUPERSEDED.match(value)
    return superseded[0] if superseded is not None else value.split(".", 1)[0]


def _targets(path: Path) -> list[str]:
    text = CODE.sub("", path.read_text())
    return [target for target in LINK.findall(text) if "://" not in target]


def test_there_are_decisions_to_check() -> None:
    assert len(FILES) >= 68
    assert _index()


def test_every_file_is_named_after_its_number() -> None:
    numbers: list[int] = []
    for path in FILES:
        name = FILE_NAME.fullmatch(path.name)
        assert name is not None, f"{path.name}: not «D<three digits>-<slug>.md»"
        assert int(_record(path)["number"]) == int(name[1]), f"{path.name}: title of another number"
        numbers.append(int(name[1]))
    assert len(numbers) == len(set(numbers)), "two files share a number"
    # Numbers are never reused or skipped: a gap would be a decision that went missing.
    assert numbers == list(range(1, len(numbers) + 1))


def test_index_and_files_name_the_same_decisions() -> None:
    index = _index()
    assert sorted(index) == [int(_record(path)["number"]) for path in FILES]
    assert {row["file"] for row in index.values()} == {path.name for path in FILES}


@pytest.mark.parametrize("path", FILES, ids=lambda path: path.name[:4])
def test_a_file_says_what_its_index_line_says(path: Path) -> None:
    record = _record(path)
    for field in FIELDS:
        assert field in record, f"{path.name}: no «{field}» line"
    row = _index()[int(record["number"])]
    assert row["file"] == path.name
    assert row["title"] == record["title"]
    assert row["state"] == _state(record["Estado"])
    assert row["date"] == record["Fecha"]


@pytest.mark.parametrize("path", FILES, ids=lambda path: path.name[:4])
def test_the_state_is_one_of_the_register(path: Path) -> None:
    state = _state(_record(path)["Estado"])
    superseded = SUPERSEDED.fullmatch(state)
    if superseded is None:
        assert state in STATES, f"{path.name}: «{state}» is not a state of the register"
    else:
        assert list(DECISIONS.glob(f"D{int(superseded[1]):03d}-*.md")), f"{path.name}: {state}"


@pytest.mark.parametrize("path", [*FILES, README], ids=lambda path: path.name[:6])
def test_links_between_decisions_exist(path: Path) -> None:
    for target in _targets(path):
        file = target.split("#", 1)[0]
        assert (path.parent / file).is_file(), f"{path.name}: link to {target}, which is not there"


@pytest.mark.parametrize(
    ("line", "ok"),
    [
        ("| D7 | Soporte | pendiente | 2026-09-28 | [D007-s.md](decisions/D007-s.md) |", True),
        ("| D7 | Soporte | pendiente | 2026-09-28 |", False),
        ("| D7 | Soporte | La decisión entera, como antes | 2026-09-28 |", False),
    ],
)
def test_an_index_line_is_one_short_row_with_its_link(line: str, ok: bool) -> None:
    assert (INDEX_ROW.match(line) is not None) is ok


@pytest.mark.parametrize(
    ("value", "state"),
    [
        ("vigente", "vigente"),
        ("parcial. Falta el punto (2).", "parcial"),
        ("reemplazada por D20. El login lo reemplaza D20.", "reemplazada por D20"),
        ("casi vigente", "casi vigente"),
    ],
)
def test_the_state_is_read_without_its_note(value: str, state: str) -> None:
    assert _state(value) == state
