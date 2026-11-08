"""Canvas of the chat (D124; threat model ``canvas-threat-model.md``): what the person reads,
edits, restores and exports of the documents an agent wrote with the ``textdoc`` tools
(``connectors/textdoc``), and what a turn shows and tells the agent of them.

* **Reading:** a document of the caller's conversation with its versions (who, when, why) and
  its open comments; the text of one version.
* **Editing:** «Guardar versión» and «Restaurar esta versión» write a new version on top of the
  one the person saw (``base``): never over a newer one (409 ``textdoc_conflict``). Nothing is
  deleted: a restore is a new version («Restaurada de v{n}»).
* **Comments:** only the agent writes them (design round 41); the person resolves them.
* **Exporting** (D124 (3)): a ``.md`` (and the code) downloads straight from the browser; a Word
  file is written here (``textdoc_export``), a PDF is that Word file rendered by
  ``Mango-<ns>-RenderDocument`` (D117). Both are files of the chat (D116): recorded in the
  conversation, scanned for malware before anyone downloads them, and announced by a message
  of the conversation with their card (design round 40).
* **The turn:** a turn whose agent called a Canvas tool shows the card of each document it
  wrote (``TurnTextdocs``, event ``textdoc``), and the next turn tells the agent the text the
  person changed since it last saw it (``turn_note``).

Security notes (security-best-practices, FastAPI):
* Every document is read in the caller's partition (row-level security) and Cedar decides
  ``OwnConversation`` with the owner of the conversation's record; someone else's and one that
  does not exist answer the same 404.
* Request bodies are validated by schema, with the size of a version capped as the store caps
  it (256 KiB in UTF-8); responses have explicit models.
* What a document says is never logged nor audited: ids, versions, kinds and sizes only.
* The text is data: the SPA shows it as text or as Markdown without raw HTML, and only the
  second origin runs code (D123). A Word file never carries a live link nor fetches anything.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import re
import threading
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Protocol

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, Path, Response
from pydantic import BaseModel, ConfigDict, Field

from mango_api.audit import AuditLog
from mango_api.chat_files_store import (
    ChatFile,
    ChatFileStore,
    ChatFileStoreUnavailableError,
    FileStatus,
)
from mango_api.code_blocks import CodeFileOut
from mango_api.rate_limits import Limiter, RateLimitUnavailableError
from mango_api.textdoc_export import markdown_to_docx
from mango_api.web import ApiError, Caller, rate_limited
from mango_core import chat_files, knowledge, textdocs
from mango_core.textdocs import (
    TextdocConflictError,
    TextdocError,
    TextdocStore,
    TextdocStoreUnavailableError,
)

logger = logging.getLogger("mango_api.textdocs")

EXPORTS_PER_HOUR = 20
"""Word and PDF files a person asks for: each one is a file of the chat, scanned and stored."""
EDITS_PER_MINUTE = 30
READS_PER_MINUTE = 120
SOURCE_SCAN_SECONDS = 120
"""How long a PDF export waits for the scan of its Word file before it is rendered."""
PDF_SCAN_SECONDS = 180
"""And for the scan of the rendered PDF before it is copied as the file of the chat."""
POLL_SECONDS = 3
_DOCX = "docx"
_PDF = "pdf"
_NAME_RE = re.compile(r"[^\w\- ]")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- Models -------------------------------------------------------------------------------


class TextdocVersionOut(_Strict):
    version: int
    by: Literal["agent", "person"]
    """``person``: «Editado por ti» / «tuya»; ``agent``: «de {agente}»."""
    note: str
    """What the version changed: the agent's words (data, shown as text), or empty."""
    created_at: datetime
    chars: int
    restored_from: int | None = None
    """«Restaurada de v{n}»."""


class TextdocCommentOut(_Strict):
    comment_id: str
    version: int
    quote: str
    """The piece of the text it comments: marked in amber in the document (design round 41)."""
    text: str


class TextdocOut(_Strict):
    textdoc_id: str
    title: str
    kind: Literal["document", "code/python", "code/react", "code/html"]
    latest: int
    versions: list[TextdocVersionOut]
    comments: list[TextdocCommentOut]
    """The ones the person has not resolved."""
    exports: list[Literal["md", "py", "jsx", "html", "docx", "pdf"]]
    """What «Exportar» offers: a document downloads as ``.md`` and is generated as Word and PDF
    (PDF only where the render function is installed); code downloads in its language."""


class TextdocContentOut(_Strict):
    textdoc_id: str
    version: int
    content: str


class TextdocCardOut(_Strict):
    """The card of a document in an answer: opens the Canvas (design round 41)."""

    textdoc_id: str
    title: str
    kind: Literal["document", "code/python", "code/react", "code/html"]
    version: int


class TextdocSaveIn(_Strict):
    content: Annotated[str, Field(max_length=textdocs.MAX_CONTENT_BYTES)]
    base: Annotated[int, Field(ge=1, le=textdocs.MAX_VERSIONS)]
    """The version the person saw: a newer one written since is a conflict."""
    restored_from: Annotated[int, Field(ge=1, le=textdocs.MAX_VERSIONS)] | None = None
    """«Restaurar esta versión»: the content must be that version's."""


class TextdocExportIn(_Strict):
    format: Literal["docx", "pdf"]
    version: Annotated[int, Field(ge=1, le=textdocs.MAX_VERSIONS)]


class TextdocExportOut(_Strict):
    message_id: str
    """The message of the conversation that announces the file (its card)."""
    file: CodeFileOut


class TextdocEmptyIn(_Strict):
    pass


# --- Dependencies -------------------------------------------------------------------------


class ExportMessages(Protocol):
    def __call__(self, user_id: str, conversation_id: str, files: list[dict[str, Any]]) -> str:
        """Append the message that announces exported files; returns its id."""
        ...


@dataclass
class ExportStorage:
    """The chat files bucket and the render function, for the exports (mango-api's own
    credentials; the bucket refuses any object its scan did not clear, D116 (10))."""

    s3: Any
    bucket: str
    lambda_client: Any = None
    render_function: str = ""

    def put(self, key: str, data: bytes, content_type: str) -> None:
        # Never a tag: the scan's tag is the scanner's word (D116 (10)).
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def copy(self, source: str, destination: str, content_type: str) -> int | None:
        """``source`` copied to ``destination`` (without tags, so it is scanned again): its size,
        or ``None`` while the bucket does not let it be read (not scanned yet, or missing)."""
        try:
            # The source's size: readable only once its scan cleared it. The copy is not
            # readable until its own scan does, so it is never asked.
            size = int(self.s3.head_object(Bucket=self.bucket, Key=source).get("ContentLength", 0))
            self.s3.copy_object(
                Bucket=self.bucket,
                Key=destination,
                CopySource={"Bucket": self.bucket, "Key": source},
                ContentType=content_type,
                MetadataDirective="REPLACE",
                # Never the scan's tag of the source: the bucket refuses a copy that brings it.
                TaggingDirective="REPLACE",
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {
                "AccessDenied",
                "NoSuchKey",
                "403",
                "404",
            }:
                return None
            raise
        return size

    def render(self, event: dict[str, Any]) -> dict[str, Any]:
        import json  # noqa: PLC0415 - only the PDF export needs it

        response = self.lambda_client.invoke(
            FunctionName=self.render_function, Payload=json.dumps(event).encode()
        )
        if response.get("FunctionError"):
            raise RuntimeError("the render function failed")
        answer = json.loads(response["Payload"].read())
        if not isinstance(answer, dict):
            raise TypeError("the render function answered something else")
        return answer


@dataclass
class TextdocsDeps:
    stores: Callable[[str], TextdocStore]
    """The Canvas of one person, with their row-level security credentials."""
    audit: AuditLog
    files: ChatFileStore | None = None
    storage: ExportStorage | None = None
    """``None`` until mango-api may use the chat files bucket: no Word nor PDF export."""
    announce: ExportMessages | None = None
    reads: Limiter | None = None
    edits: Limiter | None = None
    exports: Limiter | None = None
    clock: Callable[[], float] = time.time
    sleep: Callable[[float], None] = time.sleep
    background: Callable[[Callable[[], None]], None] | None = None
    """Runs the PDF export after the answer (a thread); tests run it inline."""


def _unavailable(exc: Exception) -> ApiError:
    logger.error("the Canvas could not be reached (%s)", type(exc).__name__)
    return ApiError(503, "textdoc_unavailable", "please try again")


def _limit(limiter: Limiter | None, key: str) -> None:
    if limiter is None:
        return
    try:
        allowed = limiter.allow(key)
    except RateLimitUnavailableError as exc:
        raise ApiError(503, "rate_limit_unavailable", "please try again") from exc
    if not allowed:
        raise rate_limited(limiter.retry_after(key))


def _audit(deps: TextdocsDeps, event: str, caller: Caller, **detail: Any) -> None:
    """Before answering: a change that cannot be audited is not reported as done."""
    try:
        deps.audit.emit(event, caller.user.user_id, detail, caller.user)
    except Exception as exc:
        raise _unavailable(exc) from exc


def _at(seconds: int) -> datetime:
    return datetime.fromtimestamp(seconds, UTC)


def export_formats(kind: str, *, files: bool, pdf: bool) -> list[str]:
    """What «Exportar» offers for a kind (design round 41)."""
    if kind != "document":
        return [textdocs.EXTENSIONS.get(kind, "txt")]
    out = ["md"]
    if files:
        out.append(_DOCX)
        if pdf:
            out.append(_PDF)
    return out


# --- Reading and editing ------------------------------------------------------------------


def textdoc_view(deps: TextdocsDeps, user_id: str, doc: textdocs.Textdoc) -> TextdocOut:
    store = deps.stores(user_id)
    versions = store.versions(doc.conversation_id, doc.textdoc_id)
    comments = store.comments(doc.conversation_id, doc.textdoc_id)
    storage = deps.storage
    return TextdocOut(
        textdoc_id=doc.textdoc_id,
        title=doc.title,
        kind=doc.kind,
        latest=versions[-1].number if versions else doc.latest,
        versions=[
            TextdocVersionOut(
                version=v.number,
                by=v.by,
                note=v.note,
                created_at=_at(v.created_at),
                chars=v.chars,
                restored_from=v.restored_from,
            )
            for v in versions
        ],
        comments=[
            TextdocCommentOut(
                comment_id=c.comment_id, version=c.version, quote=c.quote, text=c.text
            )
            for c in comments
        ],
        exports=export_formats(  # type: ignore[arg-type]
            doc.kind,
            files=storage is not None and deps.files is not None,
            pdf=storage is not None and bool(storage.render_function),
        ),
    )


def save_version(
    deps: TextdocsDeps, caller: Caller, doc: textdocs.Textdoc, body: TextdocSaveIn
) -> TextdocVersionOut:
    """«Guardar versión» or «Restaurar esta versión»: a new version by the person."""
    user_id = caller.user.user_id
    store = deps.stores(user_id)
    note = "Editado por ti"
    if body.restored_from is not None:
        restored = store.version(doc.conversation_id, doc.textdoc_id, body.restored_from)
        if restored is None or restored.content != body.content.replace("\r\n", "\n"):
            raise ApiError(422, "textdoc_invalid", "the content is not that version's")
        note = f"Restaurada de v{body.restored_from}"
    try:
        version = store.add_version(
            doc.conversation_id,
            doc.textdoc_id,
            body.content,
            by="person",
            note=note,
            base=body.base,
            restored_from=body.restored_from,
        )
    except TextdocConflictError:
        raise ApiError(
            409, "textdoc_conflict", "the document has a newer version; open it again"
        ) from None
    except TextdocError as exc:
        status = 413 if exc.code == "too_large" else 422
        raise ApiError(status, f"textdoc_{exc.code}", str(exc)) from None
    _audit(
        deps,
        "textdoc.version",
        caller,
        conversation_id=doc.conversation_id,
        textdoc_id=doc.textdoc_id,
        kind=doc.kind,
        version=version.number,
        restored_from=body.restored_from,
        chars=version.chars,
    )
    return TextdocVersionOut(
        version=version.number,
        by=version.by,
        note=version.note,
        created_at=_at(version.created_at),
        chars=version.chars,
        restored_from=version.restored_from,
    )


def resolve_comment(
    deps: TextdocsDeps, caller: Caller, doc: textdocs.Textdoc, comment_id: str
) -> None:
    if not deps.stores(caller.user.user_id).resolve(
        doc.conversation_id, doc.textdoc_id, comment_id
    ):
        raise HTTPException(status_code=404, detail="not found")
    _audit(
        deps,
        "textdoc.comment_resolved",
        caller,
        conversation_id=doc.conversation_id,
        textdoc_id=doc.textdoc_id,
        comment_id=comment_id,
    )


# --- Exports --------------------------------------------------------------------------------


def export_name(title: str, extension: str) -> str:
    """The file's name from the document's title (the design's ``fileName``): letters, digits,
    ``-``, ``_``; spaces as ``_``."""
    base = "_".join(_NAME_RE.sub("", title).split())[:100].strip("_-") or "documento"
    return chat_files.display_name(f"{base}.{extension}") or f"documento.{extension}"


def export(
    deps: TextdocsDeps, caller: Caller, doc: textdocs.Textdoc, body: TextdocExportIn
) -> TextdocExportOut:
    """A Word or PDF file of one version, as a file of the chat. The Word file is written now;
    a PDF is rendered from it after the answer (``_render_pdf``). Either one is
    «Revisando el archivo…» until its scan says, like any file the agent generates."""
    storage, files, announce = deps.storage, deps.files, deps.announce
    if storage is None or files is None or announce is None:
        raise ApiError(503, "files_unavailable", "please try again")
    if doc.kind != "document":
        raise ApiError(422, "textdoc_not_exportable", "only a document exports as Word or PDF")
    if body.format == _PDF and not storage.render_function:
        raise ApiError(503, "render_unavailable", "PDF export is not available here")
    user_id = caller.user.user_id
    version = deps.stores(user_id).version(doc.conversation_id, doc.textdoc_id, body.version)
    if version is None or version.content is None:
        raise HTTPException(status_code=404, detail="not found")
    _limit(deps.exports, user_id)
    data = markdown_to_docx(version.content, doc.title)
    now = int(deps.clock())
    file_id = knowledge.new_id(now * 1000)
    name = export_name(doc.title, body.format)
    record = ChatFile(
        file_id=file_id,
        conversation_id=doc.conversation_id,
        owner=user_id,
        origin="generated",
        name=name,
        kind=body.format,
        size=len(data) if body.format == _DOCX else 0,
        status=FileStatus.VERIFYING,
        status_at=now,
        created_at=now,
        expires_at=now + chat_files.RETENTION_DAYS * 86400,
    )
    destination = chat_files.owner_key(user_id, doc.conversation_id, file_id)
    source = (
        destination
        if body.format == _DOCX
        else chat_files.owner_key(user_id, doc.conversation_id, knowledge.new_id(now * 1000))
    )
    try:
        files.put_new(user_id, [record])
        storage.put(source, data, chat_files.TYPES[_DOCX].content_type)
    except (ChatFileStoreUnavailableError, ClientError, BotoCoreError) as exc:
        raise _unavailable(exc) from exc
    _audit(
        deps,
        "textdoc.export",
        caller,
        conversation_id=doc.conversation_id,
        textdoc_id=doc.textdoc_id,
        version=version.number,
        format=body.format,
        file_id=file_id,
        size=len(data),
    )
    shown = CodeFileOut(
        file_id=file_id, name=name, kind=body.format, size_bytes=record.size, image=False
    )
    message_id = announce(
        user_id,
        doc.conversation_id,
        [{"file_id": file_id, "name": name, "kind": body.format, "size": record.size}],
    )
    if body.format == _PDF:
        job = _PdfJob(deps, storage, files, record, source)
        if deps.background is not None:
            deps.background(job.run)
        else:
            threading.Thread(target=job.run, name="textdoc-pdf", daemon=True).start()
    return TextdocExportOut(message_id=message_id, file=shown)


@dataclass
class _PdfJob:
    """A PDF of a Canvas document, after the answer: wait for the scan of its Word file, render
    it (``Mango-<ns>-RenderDocument``, D117), wait for the scan of the PDF and copy it as the file
    of the chat, which is then scanned like any other. Any failure leaves the file ``failed``;
    one that never ends (the task stopped) fails after the scan timeout of the files."""

    deps: TextdocsDeps
    storage: ExportStorage
    files: ChatFileStore
    record: ChatFile
    source: str

    def _wait(self, seconds: int, ready: Callable[[], bool]) -> bool:
        deadline = self.deps.clock() + seconds
        while True:
            if ready():
                return True
            if self.deps.clock() >= deadline:
                return False
            self.deps.sleep(POLL_SECONDS)

    def _scanned(self) -> bool | None:
        scan = self.files.scan(self.record.owner, self.source)
        if scan is None:
            return None
        return chat_files.scan_outcome(scan.result) is chat_files.ScanOutcome.CLEAN

    def run(self) -> None:
        try:
            self._run()
        except Exception:
            logger.exception("a PDF export failed")
            self._fail()

    def _fail(self) -> None:
        try:
            self.files.move(self.record, FileStatus.FAILED, now=int(self.deps.clock()))
        except Exception:
            logger.exception("a failed PDF export could not be recorded")

    def _run(self) -> None:
        verdict: list[bool | None] = [None]

        def scanned() -> bool:
            verdict[0] = self._scanned()
            return verdict[0] is not None

        if not self._wait(SOURCE_SCAN_SECONDS, scanned) or not verdict[0]:
            self._fail()
            return
        f = self.record
        prefix = f"{chat_files.OWNER}{f.owner}/conv/{f.conversation_id}/renders/{f.file_id}/"
        answer = self.storage.render(
            {
                "bucket": self.storage.bucket,
                "key_in": self.source,
                "key_out_prefix": prefix,
                "pages_max": 1,
            }
        )
        pdf_key = answer.get("pdf_key")
        if answer.get("status") != "ready" or not isinstance(pdf_key, str):
            logger.info("a PDF export was not rendered (%s)", answer.get("reason", "unknown"))
            self._fail()
            return
        if not pdf_key.startswith(prefix):
            self._fail()
            return
        destination = chat_files.owner_key(f.owner, f.conversation_id, f.file_id)
        size: list[int | None] = [None]

        def copied() -> bool:
            size[0] = self.storage.copy(pdf_key, destination, chat_files.TYPES[_PDF].content_type)
            return size[0] is not None

        if not self._wait(PDF_SCAN_SECONDS, copied) or size[0] is None:
            self._fail()
            return
        # Still «Revisando el archivo…»: the copy is scanned like any file of the chat.
        self.files.move(f, FileStatus.VERIFYING, now=int(self.deps.clock()), size=size[0])


# --- The turn ------------------------------------------------------------------------------


def card(doc: textdocs.Textdoc, version: int | None = None) -> dict[str, Any]:
    return TextdocCardOut(
        textdoc_id=doc.textdoc_id,
        title=doc.title,
        kind=doc.kind,
        version=version or doc.latest,
    ).model_dump(mode="json")


class TurnTextdocs:
    """The documents a turn wrote, in the worker: each change shown once, as a card."""

    def __init__(self, store: TextdocStore, conversation_id: str, turn_id: str) -> None:
        self._store = store
        self._conversation_id = conversation_id
        self._turn_id = turn_id
        self._shown: dict[str, tuple[int, int]] = {}

    def new(self) -> list[dict[str, Any]]:
        """The cards of the documents this turn changed since the last call. A failure to read
        them is logged and shows nothing: the call is still in the stream."""
        try:
            docs = self._store.docs(self._conversation_id)
        except (TextdocStoreUnavailableError, TextdocError):
            logger.exception("the Canvas of a turn could not be read")
            return []
        out: list[dict[str, Any]] = []
        for doc in docs:
            if doc.last_turn != self._turn_id:
                continue
            seen = (doc.latest, doc.updated_at)
            if self._shown.get(doc.textdoc_id) == seen:
                continue
            self._shown[doc.textdoc_id] = seen
            out.append(card(doc))
        return out

    def stored(self) -> list[dict[str, Any]]:
        """What the answer keeps: ids and versions, never a title nor a text."""
        return [{"id": doc, "v": seen[0]} for doc, seen in self._shown.items()]


def stored_of_events(events: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """``textdocs`` of an answer kept from its written events (``interrupt``)."""
    last: dict[str, int] = {}
    for e in events:
        if isinstance(e.get("textdoc_id"), str) and isinstance(e.get("version"), int):
            last[e["textdoc_id"]] = e["version"]
    return [{"id": doc, "v": v} for doc, v in last.items()][: textdocs.MAX_DOCS]


def history_cards(
    store: TextdocStore, conversation_id: str, refs: Sequence[dict[str, Any]]
) -> list[TextdocCardOut]:
    """The cards of a stored answer, with the documents' titles read again."""
    wanted = [
        (r["id"], r["v"])
        for r in refs[: textdocs.MAX_DOCS]
        if isinstance(r, dict) and isinstance(r.get("id"), str) and isinstance(r.get("v"), int)
    ]
    if not wanted:
        return []
    docs = {d.textdoc_id: d for d in store.docs(conversation_id)}
    return [
        TextdocCardOut(textdoc_id=d.textdoc_id, title=d.title, kind=d.kind, version=v)
        for doc_id, v in wanted
        if (d := docs.get(doc_id)) is not None
    ]


def turn_note(store: TextdocStore, conversation_id: str) -> str:
    """What the agent is told of the Canvas before the person's question: its documents and the
    text the person changed since the agent last saw it (``mango_core.textdocs.turn_note``).
    Those versions are then marked as told. Empty without documents, or when they cannot be
    read (the agent then works with what it saw: never a reason to refuse the turn)."""
    try:
        docs = store.docs(conversation_id)
        edited: dict[str, textdocs.Version] = {}
        for doc in docs:
            if doc.latest_by == "person" and doc.told < doc.latest:
                version = store.latest(conversation_id, doc.textdoc_id)
                if version is not None and version.content is not None:
                    edited[doc.textdoc_id] = version
        note = textdocs.turn_note(docs, edited)
        for doc_id, version in edited.items():
            store.mark_told(conversation_id, doc_id, version.number)
    except (TextdocStoreUnavailableError, TextdocError):
        logger.exception("the Canvas of a conversation could not be read for a turn")
        return ""
    return note


# --- Router ----------------------------------------------------------------------------------

OwnConversation = Callable[[Caller, str, str, bool], Awaitable[None]]
ConversationOwner = Callable[[str, str], str | None]


def textdocs_router(
    deps: TextdocsDeps,
    current_user: Callable[..., Awaitable[Caller]],
    own: OwnConversation,
    owner_of: ConversationOwner,
) -> APIRouter:
    router = APIRouter(prefix="/api/conversations")
    ConversationId = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]  # noqa: N806
    TextdocId = Annotated[str, Path(pattern=knowledge.ID_PATTERN)]  # noqa: N806
    CommentId = Annotated[str, Path(pattern=knowledge.ID_PATTERN)]  # noqa: N806
    Number = Annotated[int, Path(ge=1, le=textdocs.MAX_VERSIONS)]  # noqa: N806
    SignedIn = Annotated[Caller, Depends(current_user)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        try:
            return await asyncio.to_thread(fn, *args, **kwargs)
        except TextdocStoreUnavailableError as exc:
            raise _unavailable(exc) from exc

    async def doc_of(
        caller: Caller, conversation_id: str, textdoc_id: str, *, read_only: bool
    ) -> textdocs.Textdoc:
        """A document of the caller's partition, then ``OwnConversation`` with the owner of its
        conversation's record: someone else's and one that does not exist answer the same 404."""
        user_id = caller.user.user_id
        owner = await asyncio.to_thread(owner_of, user_id, conversation_id)
        if owner is None:
            raise HTTPException(status_code=404, detail="not found")
        doc = await run(deps.stores(user_id).doc, conversation_id, textdoc_id)
        if doc is None:
            raise HTTPException(status_code=404, detail="not found")
        await own(caller, conversation_id, owner, read_only)
        return doc

    @router.get("/{conversation_id}/textdocs/{textdoc_id}", response_model=TextdocOut)
    async def get_textdoc(
        conversation_id: ConversationId, textdoc_id: TextdocId, caller: SignedIn
    ) -> TextdocOut:
        """A document of the Canvas: its versions and its open comments, without text."""
        doc = await doc_of(caller, conversation_id, textdoc_id, read_only=True)
        _limit(deps.reads, caller.user.user_id)
        return await run(textdoc_view, deps, caller.user.user_id, doc)

    @router.get(
        "/{conversation_id}/textdocs/{textdoc_id}/versions/{version}",
        response_model=TextdocContentOut,
    )
    async def get_textdoc_version(
        conversation_id: ConversationId, textdoc_id: TextdocId, version: Number, caller: SignedIn
    ) -> TextdocContentOut:
        doc = await doc_of(caller, conversation_id, textdoc_id, read_only=True)
        _limit(deps.reads, caller.user.user_id)
        found = await run(
            deps.stores(caller.user.user_id).version, conversation_id, doc.textdoc_id, version
        )
        if found is None or found.content is None:
            raise HTTPException(status_code=404, detail="not found")
        return TextdocContentOut(textdoc_id=doc.textdoc_id, version=version, content=found.content)

    @router.post(
        "/{conversation_id}/textdocs/{textdoc_id}/versions",
        response_model=TextdocVersionOut,
        status_code=201,
    )
    async def save_textdoc_version(
        conversation_id: ConversationId,
        textdoc_id: TextdocId,
        body: TextdocSaveIn,
        caller: SignedIn,
    ) -> TextdocVersionOut:
        """«Guardar versión» / «Restaurar esta versión» (design round 41)."""
        doc = await doc_of(caller, conversation_id, textdoc_id, read_only=False)
        _limit(deps.edits, caller.user.user_id)
        return await run(save_version, deps, caller, doc, body)

    @router.post(
        "/{conversation_id}/textdocs/{textdoc_id}/comments/{comment_id}/resolve",
        status_code=204,
    )
    async def resolve_textdoc_comment(
        conversation_id: ConversationId,
        textdoc_id: TextdocId,
        comment_id: CommentId,
        _body: TextdocEmptyIn,
        caller: SignedIn,
    ) -> Response:
        """«Resolver»: the comment leaves the view."""
        doc = await doc_of(caller, conversation_id, textdoc_id, read_only=False)
        _limit(deps.edits, caller.user.user_id)
        await run(resolve_comment, deps, caller, doc, comment_id)
        return Response(status_code=204)

    @router.post(
        "/{conversation_id}/textdocs/{textdoc_id}/exports",
        response_model=TextdocExportOut,
        status_code=202,
    )
    async def export_textdoc(
        conversation_id: ConversationId,
        textdoc_id: TextdocId,
        body: TextdocExportIn,
        caller: SignedIn,
    ) -> TextdocExportOut:
        """Word or PDF of a version, as a file of the chat («Generando {tipo}. Aparecerá en la
        conversación.»)."""
        doc = await doc_of(caller, conversation_id, textdoc_id, read_only=False)
        return await run(export, deps, caller, doc, body)

    return router
