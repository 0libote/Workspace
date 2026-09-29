# 0011 — Calendar uses node date properties and workspace time zones

- Status: Accepted
- Date: 2026-09-29

## Context

Tasks already use canonical `Start date`, `Due date`, and `Duration` node properties. The property model distinguishes date-only values, date-time values, and durations, but workspaces do not yet have a time zone. A calendar must project those properties without copying schedule data into a calendar-owned table.

## Decision

- `date` property values are ISO `YYYY-MM-DD` calendar dates and remain unchanged across time zones. Start and due dates form an inclusive all-day span; a missing endpoint collapses to the supplied date.
- `dateTime` property values are absolute instants stored as ISO timestamps with an offset and normalized to UTC. `Duration` is a non-negative number of minutes. For timed entries, a due instant takes precedence as the end; otherwise duration can supply the end. A start with neither remains a point event.
- A workspace stores an IANA time-zone identifier, defaulting to `UTC`. Calendar day boundaries, captions, and timed-event placement use that zone. Changing it changes only the view; node property values are preserved.
- If both date-only and date-time scheduling values are present, date-time values define the timed placement and date-only values are ignored for that node. A due value earlier than start is shown as an invalid schedule state, not silently reordered.
- Recurrence, external calendars, CalDAV, and separate event records are out of scope for the initial calendar.

## Alternatives considered

- Store calendar events and copies of task dates separately: rejected because changes would drift from canonical node properties.
- Interpret date-only values at UTC midnight: rejected because it shifts all-day entries to another local date in many time zones.
- Use the browser's current time zone implicitly: rejected because collaborators would see different day boundaries for one workspace.

## Consequences

Workspace time zone is a versioned database field and validated setting. Calendar queries return node identity and property-derived schedule data; they do not persist event rows. Local wall-time input must be interpreted in the workspace zone and handle daylight-saving gaps and overlaps explicitly. Repeating events remain unsupported until recurrence semantics have a separate design.
