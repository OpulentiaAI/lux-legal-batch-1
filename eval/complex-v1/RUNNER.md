# Paired runner concurrency

`run.mjs` schedules selected task arms in task order, interleaving Harvey and Broad. CLI runs default to `--concurrency 2`; pass `--concurrency 1` for historical sequential execution or a positive safe integer for another bounded limit. Programmatic `executeArms` retains its previous sequential default, while `run` defaults to two workers.

Each arm keeps its own harness invocation, artifacts, attempt and failure status. The runner synchronously writes the atomic checkpoint at every start and finish, and drains all workers before closing the broker. Resume retries failed or interrupted arms, skips completed arms, and rejects changed concurrency or other changed provenance. Use a new output directory for a changed parallelism protocol; label parallel wall time separately from historical sequential runs.
