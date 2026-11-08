"""A stand-in for the Code Interpreter's Python kernel: one process per session, each request
run in its ``__main__`` (state persists), with its stdout and stderr captured.

Protocol on stdin/stdout: one JSON line per request (``{"code": …}``), one JSON line back
(``{"stdout", "stderr", "error"}``). Started by ``conftest.FakeAgentCore``; never shipped.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import traceback


def main() -> None:
    real_out = sys.stdout
    namespace = sys.modules["__main__"].__dict__
    for line in sys.stdin:
        request = json.loads(line)
        out, err = io.StringIO(), io.StringIO()
        failed = False
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                exec(compile(request["code"], "<kernel>", "exec"), namespace)  # noqa: S102
            except BaseException:  # noqa: BLE001
                failed = True
                traceback.print_exc()
        real_out.write(
            json.dumps({"stdout": out.getvalue(), "stderr": err.getvalue(), "error": failed}) + "\n"
        )
        real_out.flush()


if __name__ == "__main__":
    main()
