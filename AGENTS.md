# AGENTS.md

This repository has one non-negotiable product rule:

## Bridge safety rule

Never introduce code, review feedback, or "reliability" changes that block a real user from bridging only because history, Redis, API persistence, or any other database write is unavailable.

For this codebase:

- The bridge transaction path is the priority.
- History/persistence is important, but it is secondary to letting the user complete the bridge.
- Saving the burn transaction hash, attestation, mint transaction hash, and resumable state must be best-effort and non-blocking from the user's perspective.
- If durable storage fails, the UI must still preserve enough local state for the user to resume or complete the transfer.
- Do not gate `depositForBurn`, attestation polling, minting, or manual claim behind database health checks.
- Do not turn bridge persistence warnings into hard failures for the bridge flow.
- Do not require Redis/database success before allowing the user to continue.
- Do not suggest removing local fallback persistence unless you replace it with something equally non-blocking and equally resumable.

## Review rules for bridge-related changes

When reviewing or modifying bridge code in:

- [client/src/pages/Bridge.tsx](client/src/pages/Bridge.tsx)
- [client/src/lib/bridge-transfers.ts](client/src/lib/bridge-transfers.ts)
- [api/bridge-transfers.js](api/bridge-transfers.js)

follow these rules:

1. Preserve the current design where bridge persistence failures do not stop bridging.
2. Prefer local-first or UI-first state updates for resumability, then attempt server persistence.
3. Treat burn tx hash capture as critical. Once the burn succeeds, do not lose the hash even if persistence fails.
4. Treat attestation capture as critical. If minting fails, keep the transfer resumable.
5. Treat server/database writes as best-effort unless the change is explicitly about back-office/admin correctness rather than user bridge execution.
6. If a change makes persistence stricter, explicitly prove that it still cannot block user bridging.
7. If a change modifies deletion/pruning logic, verify it is bounded and cannot wipe unrelated transfer records.

## What not to suggest in review

Do not suggest:

- blocking the bridge UI until Redis/database health is confirmed
- rejecting a valid bridge flow because history could not be saved
- converting persistence warnings into thrown errors on the user path
- requiring the user to retry the whole bridge because a save/update endpoint returned degraded status
- asking the maintainer to "check env vars" as a default response

Environment variables for this project should be assumed to be intentionally configured unless a task explicitly says otherwise. Focus review on code paths, error propagation, persistence strategy, and user safety instead of defaulting to env-var advice.

## Database safety expectations

Changes to persistence must be conservative:

- No broad deletes.
- No schema-wipe behavior.
- No cleanup logic that can remove more than the intended wallet-scoped or transfer-scoped records.
- Keep retention/pruning bounded and explicit.
- Prefer degraded operation over destructive recovery behavior.

## Decision rule

If there is a tradeoff between:

- perfect bridge history persistence
- and not blocking a legitimate user bridge

the bridge must continue, and persistence should degrade gracefully.
