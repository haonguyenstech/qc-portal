# Test Cases — [TICKET-ID] [Ticket title]

- **Feature:** [feature / screen under test]
- **Ticket:** [TICKET-ID — link or display id]
- **Environment:** [staging / QA URL]
- **Tested by:** [name]
- **Date:** [YYYY-MM-DD]

## Summary

| Total | High | Medium | Low |
|-------|------|--------|-----|
| [n]   | [n]  | [n]    | [n] |

## Test cases

| No | Test Case ID | Title | Precondition | Steps | Expected result | Priority | Type |
|----|--------------|-------|--------------|-------|-----------------|----------|------|
| 1 | TC-001 | [short, action-oriented title] | [state/data required before starting] | 1. [step]<br>2. [step]<br>3. [step] | [observable outcome — exact message/field/state, one per expectation] | High / Medium / Low | Functional / Validation / Negative / UI / Permission |

## Writing rules

- One test case = one verifiable behavior. Split combined checks into separate rows.
- **Steps** are numbered, concrete actions a tester can follow without guessing
  (name the exact screen, button, and field labels used by the app).
- **Expected result** must be observable (message text, redirect, state change) —
  never "works correctly".
- Cover the main (happy) flow first, then validation/negative cases (empty, invalid,
  boundary values), then permission/role cases when the feature has roles.
- Ground every case in the ticket, the project Knowledge/Memory, or the source code —
  do not invent fields, screens, or messages the app doesn't have.
- Keep IDs sequential (TC-001, TC-002, …) so failures are easy to reference in bug reports.
