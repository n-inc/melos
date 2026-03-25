# Melos Workflow Runtime Spec

## Purpose

This document only records behavior that is easy to misunderstand, easy to accidentally change, or not obvious from a quick code read.

Code-level structure, field names, and straightforward type definitions are intentionally not duplicated here.

## Core Model

- Melos is workflow-first.
- A route executes as a sequential phase state machine.
- The unit of execution is a **phase execution**, not a legacy “one big loop”.
- Backward compatibility with the old top-level loop shape is intentionally removed.

## Sources of Truth

- Execution entrypoint: `melos run --route` or `melos run --prompt`
- Event truth: `.melos/events.jsonl`
- Final result truth: `.melos/final-report.json` when reporting is enabled

Prompt text is never the source of truth for stopping or branching.

## Global Runtime Semantics

- `limit` is a **global phase execution cap** across the whole workflow, not a per-phase retry limit.
- `limits.timeoutMs` is a route-level wall-clock timeout for the whole run.
- `run.timeoutMs` is an engine-call timeout for one phase execution.
- Workflow execution is strictly sequential in v1.
- No parallelism, joins, fan-out, or nested workflows are part of the contract.

## Phase Categories

There are only two valid phase categories:

- Action phase: executes work, then follows `next`
- Evaluator phase: evaluates result, then branches via `on`

Contract:

- Action phase requires `next`
- Evaluator phase requires `on`
- Runtime phases may not define `evaluate` without `policy`, or `policy` without `evaluate`

## Transition Semantics

Allowed workflow transitions are:

- `repeat`
- `stop`
- `goto:<phase>`

Important semantic rules:

- `continue` from policy means “take the retry/fail transition”, not “stop unsuccessfully”
- `stop(success: false)` is terminal failure for the whole run
- `stop(success: false)` does **not** fall through to `on.fail`
- `ask` requires `on.ask` if the route is expected to continue
- `rollback` requires `on.rollback` if the route is expected to continue

## Produce Semantics

`produce` is the structured state handoff mechanism between phases.

Supported modes:

- Parse assistant output as JSON
- Read a JSON file after phase execution

Contract:

- Invalid JSON is a hard failure
- Missing file is a hard failure
- Output is stored in `state.outputs[phaseName]`
- Re-running the same phase overwrites that phase’s previous output
- Historical per-phase output versions are not retained in workflow state

## Workflow State Contract

These workflow state concepts are part of the behavioral contract:

- `outputs` stores the latest structured output per phase
- `phaseCounts` counts how many times each phase actually ran
- `history` stores the executed transition history, not just raw policy decisions
- resolved ask answers become part of future prompt context

The intended continuity model is structured state, not conversational memory.

## Thread / Memory Semantics

Workflow phase executions are treated as fresh engine turns.

The workflow runtime does not rely on carrying a long-lived conversation thread across phases. Cross-phase continuity is expected to come from:

- workflow outputs
- workflow history
- resolved questions
- explicit prompt/context construction

## Ask Semantics

Ask resolution order is:

1. Agent-first resolution when ask mode allows it
2. User resolution if agent resolution fails and user asking is enabled

If the question is resolved:

- the answer is appended to resolved question history
- future prompts can see that resolved history
- workflow continuation follows `on.ask`

If the question cannot be resolved:

- the run fails

## Checkpoint / Rollback Semantics

If checkpointing is enabled:

- a checkpoint is created before each phase execution
- rollback is applied only when a phase returns `rollback`
- successful terminal completion may call checkpoint keep logic

If a phase returns `rollback` and no checkpoint exists, the route fails.

## Artifact Cleanup Semantics

Before a new run:

- stale default runtime artifacts are deleted from `.melos`
- configured `produce.from.file` artifacts are also deleted

Important rule:

- relative file-produce artifact paths are resolved from the **effective phase cwd**, not blindly from the route cwd

This matters for workflows where phases run in subdirectories.

## Reporting Semantics

Reporting is a separate end-of-run phase, not the final line of the main workflow.

Defaults:

- report path defaults to `.melos/final-report.json`
- report stdout defaults to `true`
- prompt-mode one-shot execution disables report stdout by default

Report evidence may include:

- shell checks
- pass criteria
- final metrics
- workflow outputs
- workflow phase counts
- workflow history

If the reporting pass fails or returns invalid JSON:

- Melos emits a degraded fallback report
- the run summary records that the report was degraded

## Prompt Mode Contract

`--prompt` is not a separate runtime model.

It is compiled into a one-phase workflow with a terminal stop.

That means prompt mode and route mode share the same workflow runtime semantics.

## Event Log Contract

The event log is append-only JSONL.

For workflow runs, consumers should treat the following as stable concepts:

- `iteration` means phase execution count
- workflow-aware payloads may include `phase` and `phaseExecution`
- `phase_transitioned` is the event that records actual control-flow movement

If a downstream consumer wants to reconstruct the workflow path, `events.jsonl` is the intended source.

## Explicit Non-Goals

The following are intentionally out of scope for the current workflow runtime:

- parallel node execution
- joins / synchronization
- nested workflow graphs
- schema-validated outputs beyond “must be valid JSON”
- backward compatibility with the removed legacy route shape
