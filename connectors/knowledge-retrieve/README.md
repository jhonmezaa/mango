# knowledge-retrieve

Tool `knowledge___retrieve` of the Mango Gateway (D88 (14)): searches the knowledge bases of the agent version in use that the asking person may read, with the filter of `mango_core.knowledge_search`.

- No `manifest.json`: it is not in the tool catalog. A version with `knowledge_bases` has the tool, and only such a version (`mango_core.harness_tools`).
- The knowledge bases come from the invocation mango-api signs (`mango_core.invocation`, claim `kbs`), forwarded by the Gateway interceptor in `_mango_ctx`; the groups, from the verified token; the groups of each base, from the registry on every call.
- With nothing to search it does not call `Retrieve`.
- `kb.retrieve` is audited before answering; 60 searches per person per minute (table `RateLimits`).
