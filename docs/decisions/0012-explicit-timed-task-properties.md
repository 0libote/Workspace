# ADR 0012: Explicit timed task properties

- Status: Accepted
- Date: 2026-09-29
- Supersedes: The single-field date-or-datetime presentation in ADR 0011; stored values remain canonical node properties.

## Context

The task defaults currently provide `Start date`, `Due date`, and `Duration`. A property definition has one stable value type, so a date-only field cannot also accept a datetime without weakening typed-property validation. Calendar placement still needs clear all-day and timed values.

## Decision

Keep `Start date` and `Due date` as ISO all-day dates. Add `Start time` and `Due time` as datetime properties. A datetime value is an absolute instant normalized to UTC. When a corresponding time is set, it determines timed placement and the date-only value is ignored for that endpoint. When no timed start exists, a timed due value is the placement instant. `Duration` remains minutes; an explicit timed due value overrides duration when both timed endpoints exist.

The calendar adapter projects these properties into a view. It does not persist separate event records. Moving calendar items must update the canonical properties, preserving the event's span or duration and respecting the workspace timezone.

## Consequences

- Existing all-day dates retain their type and meaning.
- Task editors can expose separate date and time controls with runtime-safe property types.
- Timezone changes affect display and local input conversion only; stored instants are unchanged.
- Date-only spans remain inclusive at the property boundary and use an exclusive end internally.
- If an event has both date and time values, the time value takes precedence for that endpoint.
