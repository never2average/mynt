---
name: state-machine
description: |
  Use when designing explicit state-machine behavior for systems with multiple
  modes (idle/loading/success/error, draft/submitted/approved,
  connected/disconnected/reconnecting), boolean-flag explosion where isLoading,
  isError and isSuccess drift out of sync, forms, wizards, auth flows, network
  protocols, embedded controllers, workflow engines, or any code/bug report where
  "impossible states" appear. Agent-facing design workflow: model states, events,
  transitions, guards, actions, and impossible states before implementation.
  Provides implementation references for TypeScript discriminated unions, XState
  v5, React useReducer, Svelte 5 runes, C, Java, and Rust. NOT for installing
  tools, single-boolean toggles, pure server-cache concerns better handled by
  TanStack Query or SWR, or stateless pure transformations.
---

# State Machine

Model behavior as a finite state machine to eliminate impossible states and make
every transition explicit.

## Agent contract

This skill is for state-machine design, not tool installation. Model first; choose
tools later only when the model needs them.

Before changing code, produce or hold in working context:

1. Finite states with one-line meaning.
2. Events that can occur.
3. Transition table: current state, event, optional guard, actions, next state.
4. Impossible states the model prevents.
5. Smallest implementation shape that preserves the model.

Inspect the repository first. Reuse existing state patterns and dependencies. Do
not introduce a visualization tool or runtime library just because this skill
triggered.

## When to use

- Two or more `isXxx` booleans gate behavior and can drift out of sync
- A flow has visible idle / pending / success / error / retry phases
- A form, wizard, auth flow or protocol has order-dependent steps
- A bug report says "stuck loading", "showing both states", or "shouldn't be possible"
- An embedded controller or workflow engine is being designed

## When NOT to use

- Single boolean toggle with no side effects
- Pure server cache (use TanStack Query or SWR; their internal FSM is enough)
- Stateless pure transformations
- Existing code whose states already contradict each other across components:
  run the `state-audit` skill first; it hands its target back here

## Output contract

Prefer explicit, reviewable artifacts:

| Situation | Output |
|---|---|
| Design or review request | State list, event list, transition table, impossible states |
| Human review needed | Mermaid `stateDiagram-v2` plus the transition table |
| Simple TypeScript state | Discriminated union and transition function |
| React local UI state | `useReducer` state/event reducer |
| Complex app logic | XState only when hierarchy, parallel regions, history, actors, or inspection justify it |
| Rust | Typestate or `statig`, matching repo style |
| Embedded C/C++ | Explicit transition table or QP/QM if already part of the stack |

Load only the implementation reference that matches the selected stack.

## Human review gate

Pause for human review before implementation when:

- The machine has more than about seven states.
- Transitions cross multiple user or business workflows.
- Guards encode business policy.
- States are hierarchical, parallel, historical, or actor-based.
- The implementation would add a new runtime dependency.
- The model affects persisted state, auth, payments, delivery, or irreversible actions.

For review, use a text-first Mermaid diagram. Do not install visual tools unless
the user explicitly asks for them.

## The 5 components

| Component | Definition |
|---|---|
| **State** | Distinct mode the system can occupy (idle, loading, success...) |
| **Event** | Trigger for a transition (click, submit, response, timeout) |
| **Transition** | In state A, on event E, go to state B (optional guard / action) |
| **Action** | Side effect run on transition, entry, or exit (fetch, log, toast) |
| **Guard** | Boolean condition that must hold for the transition to fire |

Full glossary with citations: `references/concepts.md`

## Modeling checklist

1. Enumerate states. Start with the happy path.
2. Enumerate events.
3. Draw transitions. Every non-final state needs an exit.
4. List impossible state combinations and confirm they are unrepresentable.
5. Add guards only where a transition is conditional.
6. Define entry / exit actions only where side effects are required.
7. Sketch Mermaid `stateDiagram-v2` only when it improves review. See `references/visual-notation.md`.

Worked example: `references/modeling-process.md`

## Verify the model

Before implementing a machine with more than a few states, parallel regions, or
several processes, write its rules as invariants and check them on the model:
a breadth-first walk over the transition function for one finite machine,
`xstate/graph` when the machine is already XState, Quint when several processes
interleave. Templates and pitfalls live in the `state-audit` skill,
`references/verify.md`.

## Pick an implementation

| Stack | Reference |
|---|---|
| TypeScript, no lib | `references/implementations/typescript-discriminated-unions.md` |
| React, no lib | `references/implementations/react-usereducer.md` |
| Svelte 5 runes | `references/implementations/svelte5-runes.md` |
| XState v5 (cross-framework, statecharts) | `references/implementations/xstate.md` |
| C (embedded, kernel) | `references/implementations/c.md` |
| Java (backend, workflows) | `references/implementations/java.md` |
| Rust (typestate, embedded) | `references/implementations/rust.md` |

Validation manifest and rerunner: `config/validation/manifest.json` and
`scripts/validate-references.sh`.

Reach for a statechart library (XState, statig, QP, Spring StateMachine) when a
flat reducer becomes hard to audit or needs hierarchy, parallel regions, or
history. See `references/statecharts-extensions.md`.

## Common patterns

Form, data fetching with retry, auth, multi-step wizard, toggle with optimistic
UI, network protocol handshake. Diagrams and implementation sketches in
`references/patterns.md`.

## Don't

`references/anti-patterns.md` covers boolean explosion, isLoading flags, syncing
derivable state, dead-end states, and switch-FSM without a typed table.

## Further reading

`references/further-reading.md` curates Harel 1987, the W3C SCXML 1.0
recommendation, statecharts.dev, Samek's PSiCC2, Khourshid talks, and Wuyts'
state-machine blog series.
