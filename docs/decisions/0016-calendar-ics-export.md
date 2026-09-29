# ADR 0016: Calendar ICS export

## Status

Accepted

## Context

Users need scheduling data in a broadly supported, portable format. Calendar events are projections of canonical node date properties; the export must preserve those dates without adding a second event store or relying on incomplete timezone data.

## Decision

Export the currently requested calendar date range as RFC 5545 iCalendar (`text/calendar`). All-day events use `VALUE=DATE`, with `DTEND` equal to the canonical schedule's exclusive end date. Timed events use UTC `DATE-TIME` values. Each event includes its stable node UID and the export generation time as `DTSTAMP`. Escape text values and fold long content lines at UTF-8 character boundaries to no more than 75 octets. Keep node IDs in `X-ASTRYX-NODE-ID` fields. Apply the existing workspace read authorization and calendar range limit.

## Alternatives considered

- Emit local times with a `TZID` parameter: rejected for v1 because a correct standalone file needs matching `VTIMEZONE` transition definitions.
- Store a separate calendar event record: rejected because scheduling already derives from canonical node properties.
- Export all workspace events at once: rejected because the existing bounded range query provides predictable response size and mirrors the displayed calendar.

## Consequences

- Timed events retain the same instant across calendar applications, while each recipient controls local display time.
- All-day date spans retain their intended inclusive visible dates through exclusive `DTEND` semantics.
- The export includes only events in the requested bounded range; recurring rules and ICS import remain future work.
