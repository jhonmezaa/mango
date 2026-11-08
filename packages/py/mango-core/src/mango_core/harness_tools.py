"""How an agent's tools are named inside its AgentCore harness (D13, D33).

Every tool is reached through the Mango Gateway, registered in the harness as one MCP server.
The Gateway exposes a tool as ``<target>___<tool>``; the harness allow-list addresses it as
``@<server>/<target>___<tool>``. The provisioner stores these names in the harness and
mango-api sends the same ones on each invocation, so both sides must build them here.
"""

from __future__ import annotations

GATEWAY_MCP_SERVER = "mango"
"""Name of the Gateway MCP server in a harness (``remote_mcp`` tool)."""
_TARGET_SEPARATOR = "___"

KNOWLEDGE_TARGET = "knowledge"
"""Gateway target of the ``knowledge-retrieve`` tool (D88 (14)): a Mango connector."""
KNOWLEDGE_TOOL = "retrieve"
"""The one tool of that target. A version with knowledge bases has it, and only such a
version: nobody adds it by hand, it follows from ``knowledge_bases``."""


def gateway_tool_name(target: str, tool: str) -> str:
    """Name of a tool as the Gateway exposes it."""
    return f"{target}{_TARGET_SEPARATOR}{tool}"


def allowed_tool(target: str, tool: str) -> str:
    """``allowedTools`` entry for exactly one Gateway tool (no globs)."""
    return f"@{GATEWAY_MCP_SERVER}/{gateway_tool_name(target, tool)}"


def allowed_inline_tool(name: str) -> str:
    """``allowedTools`` entry for exactly one ``inline_function`` tool (D87 (3)).

    The harness addresses an inline function as its own server: ``@<name>/<name>``. A plain
    name matches only built-in tools, so the harness would drop the inline function before
    the model sees it (seen in an installation on 2026-10-19).
    """
    return f"@{name}/{name}"


def knowledge_gateway_tool() -> str:
    """Gateway name of the knowledge search tool (``knowledge___retrieve``)."""
    return gateway_tool_name(KNOWLEDGE_TARGET, KNOWLEDGE_TOOL)


def knowledge_allowed_tool() -> str:
    """``allowedTools`` entry of the knowledge search tool."""
    return allowed_tool(KNOWLEDGE_TARGET, KNOWLEDGE_TOOL)


CODE_TARGET = "code"
"""Gateway target of the code connector (D114 (1)): a Mango connector over the installation's
Code Interpreter. A version with the ``code_interpreter`` capability has its tools, and only
such a version."""
CODE_RUN_TOOL = "run_python"
CODE_RENDER_TOOL = "render_document"
"""Renders a Word, Excel or PowerPoint file of the conversation to PDF and PNG pages, back into
the sandbox (D117, D119): the step "look" of the loop of the document skills."""
CODE_TOOLS = (CODE_RUN_TOOL, "list_files", "read_file", CODE_RENDER_TOOL)
"""The tools of that target (D114 (5)); no ``run_shell`` in this version."""


def code_gateway_tools() -> tuple[str, ...]:
    """Gateway names of the code tools (``code___run_python``…)."""
    return tuple(gateway_tool_name(CODE_TARGET, tool) for tool in CODE_TOOLS)


def code_allowed_tools() -> tuple[str, ...]:
    """``allowedTools`` entries of the code tools."""
    return tuple(allowed_tool(CODE_TARGET, tool) for tool in CODE_TOOLS)


SKILLS_TOOL = "skills"
"""Built-in tool of the harness that loads the instructions of one of its skills (D92): the
``AgentSkills`` plugin of Strands, which the harness runs. A version with skills has it, and
only such a version."""


def skills_allowed_tool() -> str:
    """``allowedTools`` entry of the skills tool: a plain name, as built-in tools are matched
    (``shell``, ``file_operations``; seen in an installation on 2026-10-19)."""
    return SKILLS_TOOL
