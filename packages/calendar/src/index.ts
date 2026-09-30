import type { WorkspaceNode } from "@workspace/domain";

export type LocalDateTimeResolution =
  | { readonly kind: "exact"; readonly instant: string }
  | { readonly kind: "ambiguous"; readonly instant: string }
  | { readonly kind: "nonexistent" };

export type ScheduleDateValue =
  | { readonly type: "date"; readonly value: string }
  | { readonly type: "dateTime"; readonly value: string };

export type NodeSchedule =
  | { readonly kind: "allDay"; readonly startDate: string; readonly endDateExclusive: string }
  | { readonly kind: "timed"; readonly startInstant: string; readonly endInstant?: string }
  | { readonly kind: "invalid"; readonly reason: "invalidDate" | "invalidInstant" | "invalidDuration" | "endBeforeStart" };

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function nextCalendarDate(value: string): string {
  const next = new Date(`${value}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Projects canonical Start date, Due date, and Duration properties into a display-only schedule. */
export function projectNodeSchedule(input: {
  readonly start: ScheduleDateValue | null;
  readonly due: ScheduleDateValue | null;
  readonly durationMinutes?: number | null;
}): NodeSchedule | null {
  const hasTimedValue = input.start?.type === "dateTime" || input.due?.type === "dateTime";
  if (input.durationMinutes !== undefined && input.durationMinutes !== null &&
      (!Number.isFinite(input.durationMinutes) || input.durationMinutes < 0)) {
    return { kind: "invalid", reason: "invalidDuration" };
  }

  if (hasTimedValue) {
    let startInstantValue: string | null = null;
    if (input.start?.type === "dateTime") startInstantValue = input.start.value;
    else if (input.due?.type === "dateTime") startInstantValue = input.due.value;
    if (startInstantValue === null) return null;
    const start = Date.parse(startInstantValue);
    if (!Number.isFinite(start)) return { kind: "invalid", reason: "invalidInstant" };
    // A timed due value is an end only when a timed start exists. If it is
    // the only timed value, it is the placement instant and duration applies.
    const dueInstantValue = input.start?.type === "dateTime" && input.due?.type === "dateTime"
      ? input.due.value
      : undefined;
    const due = dueInstantValue === undefined ? undefined : Date.parse(dueInstantValue);
    if (dueInstantValue !== undefined && !Number.isFinite(due)) return { kind: "invalid", reason: "invalidInstant" };
    if (due !== undefined && due < start) return { kind: "invalid", reason: "endBeforeStart" };
    const end = due ?? (input.durationMinutes === undefined || input.durationMinutes === null
      ? undefined
      : start + input.durationMinutes * 60_000);
    return {
      kind: "timed",
      startInstant: new Date(start).toISOString(),
      ...(end === undefined ? {} : { endInstant: new Date(end).toISOString() }),
    };
  }

  const startDate = input.start?.type === "date" ? input.start.value : undefined;
  const dueDate = input.due?.type === "date" ? input.due.value : undefined;
  const firstDate = startDate ?? dueDate;
  if (!firstDate) return null;
  if (!isIsoCalendarDate(firstDate) || startDate !== undefined && !isIsoCalendarDate(startDate) || dueDate !== undefined && !isIsoCalendarDate(dueDate)) {
    return { kind: "invalid", reason: "invalidDate" };
  }
  const inclusiveEnd = dueDate ?? firstDate;
  if (inclusiveEnd < firstDate) return { kind: "invalid", reason: "endBeforeStart" };
  return { kind: "allDay", startDate: firstDate, endDateExclusive: nextCalendarDate(inclusiveEnd) };
}

function partsForInstant(instant: number, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
}

export function formatInstantInTimeZone(instant: string, timeZone: string): string {
  const timestamp = Date.parse(instant);
  if (!Number.isFinite(timestamp)) throw new RangeError("Expected a valid date-time instant.");
  const parts = partsForInstant(timestamp, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function parseLocalDateTime(value: string): { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number; readonly asUtc: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(asUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  return { year, month, day, hour, minute, asUtc };
}

export function resolveLocalDateTime(value: string, timeZone: string): LocalDateTimeResolution {
  const local = parseLocalDateTime(value);
  if (!local) return { kind: "nonexistent" };

  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = local.asUtc + hours * 60 * 60 * 1_000;
    const parts = partsForInstant(sample, timeZone);
    const displayedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    offsets.add(displayedAsUtc - Math.floor(sample / 60_000) * 60_000);
  }

  const candidates = [...offsets]
    .map((offset) => local.asUtc - offset)
    .filter((candidate) => {
      const parts = partsForInstant(candidate, timeZone);
      return Number(parts.year) === local.year && Number(parts.month) === local.month && Number(parts.day) === local.day &&
        Number(parts.hour) === local.hour && Number(parts.minute) === local.minute;
    })
    .sort((left, right) => left - right);

  if (candidates.length === 0) return { kind: "nonexistent" };
  return {
    kind: candidates.length > 1 ? "ambiguous" : "exact",
    // If the clock repeats at the end of daylight saving time, choose its earlier occurrence.
    instant: new Date(candidates[0]!).toISOString(),
  };
}

export function startOfLocalDate(date: string, timeZone: string): string {
  if (!isIsoCalendarDate(date)) throw new RangeError("Expected an ISO calendar date.");
  for (let minute = 0; minute < 240; minute += 1) {
    const hour = String(Math.floor(minute / 60)).padStart(2, "0");
    const remainder = String(minute % 60).padStart(2, "0");
    const resolution = resolveLocalDateTime(`${date}T${hour}:${remainder}`, timeZone);
    if (resolution.kind !== "nonexistent") return resolution.instant;
  }
  throw new RangeError("No local time exists at the start of this calendar date.");
}
export interface CalendarEvent {
  readonly node: WorkspaceNode;
  readonly schedule: NodeSchedule;
}

function escapeCalendarText(value: string): string {
  return value.replaceAll(/\\/g, String.raw`\\`).replaceAll(/\r\n|\r|\n/g, String.raw`\n`).replaceAll(/,/g, String.raw`\,`).replaceAll(/;/g, String.raw`\;`);
}

const utf8Encoder = new TextEncoder();

function foldCalendarLine(line: string): string {
  const chunks: string[] = [];
  let chunk = "";
  let octets = 0;
  for (const character of line) {
    const size = utf8Encoder.encode(character).length;
    if (octets + size > 75) {
      chunks.push(chunk);
      chunk = ` ${character}`;
      octets = 1 + size;
    } else {
      chunk += character;
      octets += size;
    }
  }
  chunks.push(chunk);
  return chunks.join("\r\n");
}

function compactUtcDateTime(instant: string): string {
  const timestamp = Date.parse(instant);
  if (!Number.isFinite(timestamp)) throw new RangeError("Calendar event contains an invalid instant.");
  return new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function compactCalendarDate(date: string): string {
  if (!isIsoCalendarDate(date)) throw new RangeError("Calendar event contains an invalid date.");
  return date.replaceAll(/-/g, "");
}

/** Serializes canonical scheduled nodes as RFC 5545 iCalendar data. */
export function serializeCalendarIcs(events: readonly CalendarEvent[], exportedAt = new Date().toISOString()): string {
  const dtstamp = compactUtcDateTime(exportedAt);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Astryx//Workspace Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const { node, schedule } of events) {
    if (schedule.kind === "invalid") continue;
    lines.push("BEGIN:VEVENT", `UID:${node.id}@astryx`, `DTSTAMP:${dtstamp}`, `SUMMARY:${escapeCalendarText(node.title)}`, `X-ASTRYX-NODE-ID:${node.id}`, `X-ASTRYX-NODE-TYPE:${escapeCalendarText(node.type)}`);
    if (schedule.kind === "allDay") {
      lines.push(`DTSTART;VALUE=DATE:${compactCalendarDate(schedule.startDate)}`, `DTEND;VALUE=DATE:${compactCalendarDate(schedule.endDateExclusive)}`);
    } else {
      lines.push(`DTSTART:${compactUtcDateTime(schedule.startInstant)}`);
      if (schedule.endInstant && Date.parse(schedule.endInstant) > Date.parse(schedule.startInstant)) {
        lines.push(`DTEND:${compactUtcDateTime(schedule.endInstant)}`);
      }
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldCalendarLine).join("\r\n")}\r\n`;
}
