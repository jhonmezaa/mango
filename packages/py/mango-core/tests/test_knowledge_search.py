"""One search over the knowledge bases a person may use (D88 (14), (27))."""

from __future__ import annotations

from typing import Any

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from mango_core.knowledge import usable
from mango_core.knowledge_search import (
    MAX_FRAGMENT_CHARS,
    Searchable,
    SearchThrottledError,
    SearchUnavailableError,
    query_tokens,
    retrieval_filter,
    search,
)

KB_A = "01JABCDEFGHJKMNPQRSTVWXYZ0"
KB_B = "01JABCDEFGHJKMNPQRSTVWXYZ1"


class Retrieve:
    def __init__(self, results: list[dict[str, Any]] | None = None, error: Exception | None = None):
        self.results = results or []
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return {"retrievalResults": self.results}


def _result(
    kb_id: str, doc_id: str = "DOC1", text: str = "texto", **metadata: Any
) -> dict[str, Any]:
    return {
        "content": {"text": text},
        "score": 0.5,
        "metadata": {"kb_id": kb_id, "doc_id": doc_id, **metadata},
    }


def test_the_filter_names_the_bases_and_their_areas() -> None:
    bases = [Searchable(KB_B, "finanzas"), Searchable(KB_A, "all"), Searchable(KB_B, "finanzas")]
    assert retrieval_filter(bases) == {
        "andAll": [
            {"in": {"key": "kb_id", "value": [KB_A, KB_B]}},
            {"in": {"key": "business_unit", "value": ["all", "finanzas"]}},
        ]
    }


def test_there_is_never_an_empty_filter() -> None:
    with pytest.raises(ValueError, match="at least one"):
        retrieval_filter([])


def test_with_no_base_retrieve_is_not_called() -> None:
    # Bedrock refuses an empty `in` (D88 (27)); a search without the filter would read
    # every base of the installation.
    retrieve = Retrieve([_result(KB_A)])
    assert search(retrieve, knowledge_base_id="KB", query="vacaciones", bases=[]) == []
    assert retrieve.calls == []


def test_a_search_is_filtered_and_bounded() -> None:
    retrieve = Retrieve(
        [
            _result(
                KB_A, text="x" * (MAX_FRAGMENT_CHARS + 50), **{"x-amz-bedrock-kb-chunk-id": "c1"}
            ),
            _result(KB_A, "DOC2", **{"x-amz-bedrock-kb-document-page-number": 3.0}),
        ]
    )
    fragments = search(
        retrieve, knowledge_base_id="KB", query="vacaciones", bases=[Searchable(KB_A, "all")]
    )
    [call] = retrieve.calls
    assert call["knowledgeBaseId"] == "KB"
    assert call["retrievalQuery"] == {"text": "vacaciones"}
    vector = call["retrievalConfiguration"]["vectorSearchConfiguration"]
    assert vector["numberOfResults"] == 8
    assert vector["filter"] == retrieval_filter([Searchable(KB_A, "all")])
    assert [(f.doc_id, len(f.text), f.page, f.fragment_id) for f in fragments] == [
        ("DOC1", MAX_FRAGMENT_CHARS, None, "c1"),
        ("DOC2", 5, 3, ""),
    ]


def test_a_fragment_of_a_base_not_searched_is_dropped(caplog: pytest.LogCaptureFixture) -> None:
    # Whatever Bedrock returns: only fragments of the bases that were searched.
    retrieve = Retrieve(
        [
            _result(KB_B),
            _result(KB_A),
            {"content": {"text": "sin metadatos"}},
            _result(KB_A, text=""),
        ]
    )
    fragments = search(retrieve, knowledge_base_id="KB", query="q", bases=[Searchable(KB_A, "all")])
    assert [f.kb_id for f in fragments] == [KB_A]
    assert caplog.text.count("a fragment of a base not searched") == 1


@pytest.mark.parametrize("query", ["", "x" * 1001])
def test_a_query_must_fit(query: str) -> None:
    with pytest.raises(ValueError, match="invalid search"):
        search(Retrieve(), knowledge_base_id="KB", query=query, bases=[Searchable(KB_A, "all")])


def _client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "secreto"}}, "Retrieve")


def test_throttling_and_other_failures_say_only_their_code(
    caplog: pytest.LogCaptureFixture,
) -> None:
    bases = [Searchable(KB_A, "all")]
    with pytest.raises(SearchThrottledError):
        search(
            Retrieve(error=_client_error("ThrottlingException")),
            knowledge_base_id="KB",
            query="q",
            bases=bases,
        )
    with pytest.raises(SearchUnavailableError):
        search(
            Retrieve(error=_client_error("ValidationException")),
            knowledge_base_id="KB",
            query="q",
            bases=bases,
        )
    with pytest.raises(SearchUnavailableError):
        search(
            Retrieve(error=EndpointConnectionError(endpoint_url="https://bedrock.example")),
            knowledge_base_id="KB",
            query="q",
            bases=bases,
        )
    assert "secreto" not in caplog.text
    assert "ValidationException" in caplog.text


def test_query_tokens_are_estimated_by_length() -> None:
    assert query_tokens("x" * 1000) == 250
    assert query_tokens("abc") == 1


def test_a_base_answers_whoever_is_in_one_of_its_groups() -> None:
    assert usable({"hr", "ops"}, {"ops"})
    assert not usable({"hr"}, {"ops", "mango-admins"})
    assert not usable(set(), {"ops"})
