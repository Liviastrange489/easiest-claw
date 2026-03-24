# @easiest-claw/master-agent

Self-developed orchestration-only Master agent package.

## Responsibilities

1. Build coordinator prompts for kickoff, progress review, and stall handling.
2. Enforce role-domain assignment guardrails.
3. Provide a stable API for future provider-agnostic orchestration.

## Non-goals

1. Do not execute implementation tasks.
2. Do not call tools.
3. Do not write files directly.

## Public API

Import from `@master-agent`:

1. `createMasterEngine()`
2. `MasterEngine`
3. `MasterTaskDomain` and helper types
