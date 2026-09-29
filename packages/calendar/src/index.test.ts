import { describe, expect, test } from "bun:test";
import { createNode, type NodeId, type NodeType, type UserId, type WorkspaceId } from "@workspace/domain";
import { formatInstantInTimeZone, projectNodeSchedule, resolveLocalDateTime, serializeCalendarIcs } from "./index";

describe("workspace time zone conversion", () => {
  test("formats the same instant on the correct local calendar date", () => {
    expect(formatInstantInTimeZone("2026-01-01T01:30:00.000Z", "America/Los_Angeles")).toBe("2025-12-31T17:30");
  });

  test("resolves ordinary local times to an absolute instant", () => {
    expect(resolveLocalDateTime("2026-02-10T09:15", "Europe/London")).toEqual({
      kind: "exact",
      instant: "2026-02-10T09:15:00.000Z",
    });
  });

  test("chooses the earlier instant for a repeated wall time", () => {
    expect(resolveLocalDateTime("2026-11-01T01:30", "America/New_York")).toEqual({
      kind: "ambiguous",
      instant: "2026-11-01T05:30:00.000Z",
    });
  });

  test("rejects daylight-saving gaps and impossible dates", () => {
    expect(resolveLocalDateTime("2026-03-08T02:30", "America/New_York")).toEqual({ kind: "nonexistent" });
    expect(resolveLocalDateTime("2026-02-30T10:00", "UTC")).toEqual({ kind: "nonexistent" });
  });
});

describe("canonical node scheduling", () => {
  test("keeps all-day date values as inclusive calendar spans", () => {
    expect(projectNodeSchedule({
      start: { type: "date", value: "2026-12-30" },
      due: { type: "date", value: "2027-01-01" },
    })).toEqual({ kind: "allDay", startDate: "2026-12-30", endDateExclusive: "2027-01-02" });
  });

  test("uses a due-only date as a single all-day entry", () => {
    expect(projectNodeSchedule({ start: null, due: { type: "date", value: "2026-10-04" } }))
      .toEqual({ kind: "allDay", startDate: "2026-10-04", endDateExclusive: "2026-10-05" });
  });

  test("uses an explicit timed due instant before duration and otherwise applies duration minutes", () => {
    const start = { type: "dateTime" as const, value: "2026-10-09T09:00:00-04:00" };
    expect(projectNodeSchedule({ start, due: null, durationMinutes: 45 })).toEqual({
      kind: "timed", startInstant: "2026-10-09T13:00:00.000Z", endInstant: "2026-10-09T13:45:00.000Z",
    });
    expect(projectNodeSchedule({
      start,
      due: { type: "dateTime", value: "2026-10-09T14:30:00Z" },
      durationMinutes: 45,
    })).toEqual({ kind: "timed", startInstant: "2026-10-09T13:00:00.000Z", endInstant: "2026-10-09T14:30:00.000Z" });
  });

  test("prefers timed placement when a node has both date-only and datetime values", () => {
    expect(projectNodeSchedule({
      start: { type: "date", value: "2026-10-09" },
      due: { type: "dateTime", value: "2026-10-09T09:00:00Z" },
      durationMinutes: 30,
    })).toEqual({ kind: "timed", startInstant: "2026-10-09T09:00:00.000Z", endInstant: "2026-10-09T09:30:00.000Z" });
  });

  test("reports invalid ranges and leaves unscheduled nodes out", () => {
    expect(projectNodeSchedule({
      start: { type: "date", value: "2026-10-10" },
      due: { type: "date", value: "2026-10-09" },
    })).toEqual({ kind: "invalid", reason: "endBeforeStart" });
    expect(projectNodeSchedule({ start: null, due: null })).toBeNull();
  });
});

describe("portable calendar export", () => {
  test("serializes all-day and UTC timed events with escaped, folded text", () => {
    const node = createNode({
      id: "00000000-0000-4000-8000-000000000001" as NodeId,
      workspaceId: "00000000-0000-4000-8000-000000000002" as WorkspaceId,
      actorId: "00000000-0000-4000-8000-000000000003" as UserId,
      type: "task" as NodeType,
      title: `Planning, review;\n${"🗓️".repeat(30)}`,
      now: "2026-09-29T10:00:00.000Z",
    });
    const calendar = serializeCalendarIcs([
      { node, schedule: { kind: "allDay", startDate: "2026-10-09", endDateExclusive: "2026-10-11" } },
      { node: { ...node, id: "00000000-0000-4000-8000-000000000004" as NodeId, title: "Planning meeting" }, schedule: { kind: "timed", startInstant: "2026-10-09T14:30:00.000Z", endInstant: "2026-10-09T15:00:00.000Z" } },
    ], "2026-09-29T10:00:00.000Z");
    expect(calendar).toContain("DTSTAMP:20260929T100000Z");
    expect(calendar).toContain("SUMMARY:Planning\\, review\\;\\n");
    expect(calendar).toContain("DTSTART;VALUE=DATE:20261009\r\nDTEND;VALUE=DATE:20261011");
    expect(calendar).toContain("DTSTART:20261009T143000Z\r\nDTEND:20261009T150000Z");
    for (const line of calendar.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
});
