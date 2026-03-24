# Master Agent Implementation Plan

Updated: 2026-03-22

## Conversation Digest

The current A2A flow works, but the same pain points keep appearing:

1. Coordinator sometimes executes work instead of orchestration.
2. Worker role boundaries are not strict enough in real usage.
3. Group/direct session context can leak in edge cases.
4. Delegation visibility is still too implicit when relay fails.
5. Future goal is provider-agnostic multi-agent collaboration, not OpenClaw-only.

## Target State

Build a provider-agnostic multi-agent platform where:

1. A self-developed Master agent is orchestration-only.
2. Worker agents execute tasks only within domain boundaries.
3. Team state is shared through a normalized event/task model.
4. A2A relay and progress are observable in timeline/board views.
5. New providers can be plugged in without rewriting orchestration.

## Architecture Direction

1. `MasterAgent` package: planning, assignment policy, monitor prompts, guardrails.
2. `AgentAdapter` layer: normalize provider APIs (`send/stream/cancel/capabilities/health`).
3. `SessionBus` + `EventStore`: shared context and strict conversation isolation.
4. `TaskBoard` state machine: claim/approve/in-progress/blocked/done transitions.
5. `Orchestration UI`: timeline, graph edges, stall panel, grouped board.

## Delivery Phases

### Phase 1 (now)

1. Extract self-developed Master logic into an independent package.
2. Wire existing A2A kickoff and policy checks to the package.
3. Keep behavior backward-compatible.

### Phase 2

1. Add internal `masterMode` in A2A groups (`embedded-master` vs `agent-coordinator`).
2. Use internal Master engine as default orchestrator for A2A groups.
3. Keep OpenClaw coordinator path as fallback.

### Phase 3

1. Add `ProviderRegistry` and first `OpenClawAdapter`.
2. Route worker execution via adapter API.
3. Start second provider integration with a minimal adapter.

### Phase 4

1. Introduce `SessionBus` and per-agent cursor checkpoints.
2. Enforce runId-conversation binding and idempotent event writes.
3. Remove remaining session mixing paths.

### Phase 5

1. Upgrade task board: priority, due date, dependency graph, by-agent swimlanes.
2. Add automatic closure parser (`done/blocked`) and retry/escalation policy.
3. Add SLA watchdog for stalled tasks and coordinator heartbeat.

### Phase 6

1. Add A2A adapter boundary for external interoperability.
2. Keep internal event protocol stable and map to external schema.

## Acceptance Checklist

1. Master never executes worker tasks.
2. Worker cannot claim/update tasks outside ownership.
3. A2A relay failures are visible and actionable.
4. Group and direct chat history never cross.
5. At least two providers can collaborate in one group run.

## Risk Controls

1. Strangler migration: no full rewrite, replace by layers.
2. Feature flags for each major switch path.
3. Replayable orchestration logs for debugging and recovery.
