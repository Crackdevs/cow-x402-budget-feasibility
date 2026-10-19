# Historical evidence

All files under `historical/` are preserved byte-for-byte from the 15 October 2026 recovery archive. They have not been rerun or rewritten for this public-sharing package. Raw failure logs may contain the original execution directory in stack traces; these paths are historical output, not setup requirements.

- `recovery-tests.tap`: final recovery run, 28 tests/subtests passed.
- `baseline-compat-tests.tap`: separate derivative regression run, 45 tests/subtests passed.
- `recovery-independent-review.tap` and `baseline-independent-review.tap`: filenames retained from additional automated review reruns. These are not a third-party professional security audit.
- `first-run-fixture-mismatch.tap`: initial unsuccessful fixture configuration, intentionally retained. The deposit multiplier initially conflicted with the intended fixture deposit; the final suite corrected that setup. This file is not a successful run.
- `continued-after-crash.json`: recorded continuation example.
- `ORIGINAL-SHA256SUMS`: the earlier original manifest; three entries became stale when the report/review evidence was updated. It is retained only for provenance and must not be used to validate this public package.
- `ORIGINAL-deliverable-sha256.json`: the later original manifest. All 20 listed hashes matched the original archive during the 19 October packaging check. Some files described by it are intentionally absent or replaced in this presentation package.

The original archive remains unchanged. Its SHA-256 is `8ea8dc82acb845b68a8740433c00c4397aac6677fc8cbf3691929c9807b6eac5`.

For this directory, use the new root `SHA256SUMS`. Source, package and test files were copied without changes. Environment-specific instructions, broad research assessments, raw upstream-source snapshots and the source diff are omitted from this public presentation; the original archive retains them.
