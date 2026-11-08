# code-interpreter

Tools `code___run_python`, `code___list_files` and `code___read_file` of the Mango Gateway (D114): the model's Python runs in the installation's Code Interpreter (`Mango_<ns>_sandbox`, VPC mode without egress nor DNS, no execution role, D114 (11)).

- No `manifest.json`: it is not in the tool catalog. A version with the `code_interpreter` capability has these tools, and only such a version (`mango_core.harness_tools`).
- The conversation and the turn come from the invocation mango-api signs (`mango_core.invocation`, claims `conv` and `turn`), forwarded by the Gateway interceptor in `_mango_ctx`; the person, from the verified token, which must be the subject of that signature (TM-CI2).
- One sandbox session per (person, conversation), in the person's partition of `Conversations` (row-level security), with its `sessionId` sealed with the data key of Core (`alias/Mango-<ns>-data`) and `purpose = code-session`, the person and the conversation as encryption context. It never leaves the function (TM-CI1).
- Every new session gets Mango's module `_mango` (`sandbox_helper.py`: `display_table`, `display_chart`, the cell runner) and `matplotlib.use("Agg")`; every cell runs through it with a cutoff of 300 s, and its open figures are saved with `savefig`.
- After each cell the files it wrote of an allowed type (`outputs.TYPES`, checked by their bytes) go to `owner/<sub>/conv/<conversation>/<run>/<file id>` in the chat files bucket; the cell's result for the chat and its metered use go to `CODE#TURN#<turn>#RUN#<run>` (`mango_core.code_sandbox`), which mango-api settles the turn with (D115).
- `code.execute` is audited before answering, without code, output nor file names; 30 calls per person per minute, 20 new sessions per person per hour, 8 cells per turn (table `RateLimits`).
