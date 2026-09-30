import { useEffect, useMemo, useState } from "react";
import { formatInstantInTimeZone, resolveLocalDateTime } from "./index";
import type { CalendarEvent } from "./index";
import { getPlatform } from "@workspace/platform";

type CalendarMode = "month" | "week" | "day" | "agenda";

function dateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function addDays(date: Date, count: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + count);
  return next;
}

function monday(date: Date): Date {
  return addDays(date, -((date.getUTCDay() + 6) % 7));
}

function localToday(timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
}

function monthLabel(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function CalendarView({ workspaceId, timeZone, csrfToken, editable, collectionId, onOpenNode }: {
  readonly workspaceId: string;
  readonly timeZone: string;
  readonly csrfToken: string;
  readonly editable: boolean;
  readonly collectionId?: string;
  readonly onOpenNode: (node: CalendarEvent["node"]) => void;
}) {
  const [mode, setMode] = useState<CalendarMode>("month");
  const [anchor, setAnchor] = useState(() => localToday(timeZone));
  const [rangeDraft, setRangeDraft] = useState<{ from: string; to: string } | null>(null);
  const [appliedRange, setAppliedRange] = useState<{ from: string; to: string } | null>(null);
  const [events, setEvents] = useState<readonly CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [movingNodeId, setMovingNodeId] = useState("");
  const { from, to, days } = useMemo(() => {
    const day = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()));
    let first: Date;
    let count: number;
    if (appliedRange) {
      first = new Date(`${appliedRange.from}T00:00:00Z`);
      const last = new Date(`${appliedRange.to}T00:00:00Z`);
      count = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
    } else if (mode === "month") {
      first = monday(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)));
      count = 42;
    } else if (mode === "week") { first = monday(day); count = 7; }
    else if (mode === "day") { first = day; count = 1; }
    else { first = day; count = 14; }
    const dates = Array.from({ length: count }, (_, index) => addDays(first, index));
    return { from: dateKey(first), to: dateKey(dates.at(-1)!), days: dates };
  }, [anchor, mode, appliedRange]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ workspaceId, from, to });
    if (collectionId) params.set("collectionId", collectionId);
    void fetch(`/api/calendar?${params}`, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Calendar items could not be loaded.");
        return await response.json() as { readonly events: readonly CalendarEvent[]; readonly truncated: boolean };
      })
      .then((result) => { setEvents(result.events); if (result.truncated) setError("Showing the first 500 scheduled items in this range."); })
      .catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : "Calendar items could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, collectionId, from, to]);

  const eventsByDate = useMemo(() => {
    const result = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const { schedule } = event;
      let firstDate: string;
      let lastDate: string;
      if (schedule.kind === "allDay") { firstDate = schedule.startDate; lastDate = schedule.endDateExclusive; }
      else if (schedule.kind === "timed") {
        firstDate = formatInstantInTimeZone(schedule.startInstant, timeZone).slice(0, 10);
        lastDate = schedule.endInstant ? formatInstantInTimeZone(schedule.endInstant, timeZone).slice(0, 10) : firstDate;
      } else continue;
      for (const day of days) {
        const key = dateKey(day);
        if (key < firstDate || key >= lastDate && key !== firstDate) continue;
        const bucket = result.get(key) ?? [];
        bucket.push(event);
        result.set(key, bucket);
      }
    }
    return result;
  }, [events, days, timeZone]);

  async function moveNode(nodeId: string, targetDate: string): Promise<void> {
    if (!editable || movingNodeId) return;
    const before = events;
    const event = before.find(({ node }) => node.id === nodeId);
    if (!event || event.schedule.kind === "invalid") return;
    let optimistic: CalendarEvent["schedule"];
    if (event.schedule.kind === "allDay") {
      const offset = Math.round((Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${event.schedule.startDate}T00:00:00Z`)) / 86_400_000);
      const end = new Date(Date.parse(`${event.schedule.endDateExclusive}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
      optimistic = { kind: "allDay", startDate: targetDate, endDateExclusive: end };
    } else {
      const localStart = formatInstantInTimeZone(event.schedule.startInstant, timeZone);
      const resolved = resolveLocalDateTime(`${targetDate}T${localStart.slice(11)}`, timeZone);
      if (resolved.kind === "nonexistent") { setError("That local time does not exist because the clock changes. Choose another date."); return; }
      const duration = event.schedule.endInstant ? Date.parse(event.schedule.endInstant) - Date.parse(event.schedule.startInstant) : undefined;
      optimistic = { kind: "timed", startInstant: resolved.instant, ...(duration === undefined ? {} : { endInstant: new Date(Date.parse(resolved.instant) + duration).toISOString() }) };
    }
    setError("");
    setEvents(before.map((item) => item.node.id === nodeId ? { ...item, schedule: optimistic } : item));
    setMovingNodeId(nodeId);
    try {
      const response = await fetch(`/api/calendar/${encodeURIComponent(nodeId)}/move?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ date: targetDate }),
      });
      if (!response.ok) throw new Error(response.status === 400 ? "The event cannot be moved to that local time." : "The date could not be saved.");
      const result = await response.json() as { readonly schedule: CalendarEvent["schedule"] };
      setEvents((current) => current.map((item) => item.node.id === nodeId ? { ...item, schedule: result.schedule } : item));
    } catch (reason) {
      setEvents(before);
      setError(reason instanceof Error ? reason.message : "The date could not be saved.");
    } finally { setMovingNodeId(""); }
  }

  async function exportCalendar() {
    const params = new URLSearchParams({ workspaceId, from, to });
    if (collectionId) params.set("collectionId", collectionId);
    try {
      const response = await fetch(`/api/calendar.ics?${params}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error("Calendar export could not be created.");
      await getPlatform().saveFile(`astryx-calendar-${from}-${to}.ics`, await response.blob(), "text/calendar; charset=utf-8");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Calendar export could not be created.");
    }
  }

  const step = (direction: number) => {
    if (appliedRange) {
      const span = Math.round((Date.parse(`${appliedRange.to}T00:00:00Z`) - Date.parse(`${appliedRange.from}T00:00:00Z`)) / 86_400_000);
      const shift = (date: string) => { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + direction * (span + 1)); return dateKey(value); };
      const next = { from: shift(appliedRange.from), to: shift(appliedRange.to) };
      setAppliedRange(next);
      setRangeDraft(next);
      return;
    }
    setAnchor((current) => {
    const next = new Date(current);
    if (mode === "month") next.setUTCMonth(next.getUTCMonth() + direction);
    else next.setUTCDate(next.getUTCDate() + direction * (mode === "week" ? 7 : mode === "agenda" ? 14 : 1));
    return next;
    });
  };

  return <section className="calendar-view" aria-label="Workspace calendar">
    <div className="calendar-toolbar"><div><div className="eyebrow">CANONICAL NODE DATES</div><h2>{appliedRange ? `${appliedRange.from} – ${appliedRange.to}` : monthLabel(anchor)}</h2></div><div className="calendar-actions">
      <button type="button" aria-label="Previous period" onClick={() => step(-1)}>←</button><button type="button" onClick={() => { setAppliedRange(null); setRangeDraft(null); setAnchor(localToday(timeZone)); }}>Today</button><button type="button" aria-label="Next period" onClick={() => step(1)}>→</button>
      <select aria-label="Calendar view" value={mode} onChange={(event) => setMode(event.target.value as CalendarMode)}><option value="month">Month</option><option value="week">Week</option><option value="day">Day</option><option value="agenda">Agenda</option></select>
      <button type="button" onClick={() => void exportCalendar()} disabled={loading}>Export .ics</button>
    </div></div>
    <form className="calendar-range-form" aria-label="Filter calendar date range" onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const fromDate = formString(form, "from");
      const toDate = formString(form, "to");
      const span = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000;
      if (!isCalendarDate(fromDate) || !isCalendarDate(toDate) || !Number.isInteger(span) || span < 0 || span > 62) {
        setError("Choose a valid date range of up to 63 days.");
        return;
      }
      setError("");
      setRangeDraft({ from: fromDate, to: toDate });
      setAppliedRange({ from: fromDate, to: toDate });
      setMode("agenda");
    }}>
      <label>From <input aria-label="Calendar range start" type="date" name="from" required value={rangeDraft?.from ?? appliedRange?.from ?? from} onChange={(event) => setRangeDraft((current) => ({ from: event.target.value, to: current?.to ?? appliedRange?.to ?? to }))} /></label>
      <label>To <input aria-label="Calendar range end" type="date" name="to" required value={rangeDraft?.to ?? appliedRange?.to ?? to} onChange={(event) => setRangeDraft((current) => ({ from: current?.from ?? appliedRange?.from ?? from, to: event.target.value }))} /></label>
      <button type="submit">Apply range</button>
      {appliedRange && <button type="button" onClick={() => { setAppliedRange(null); setRangeDraft(null); }}>Clear range</button>}
    </form>
    <p className="calendar-zone">Times shown in {timeZone}{loading ? " · Loading…" : ""}</p>
    {error && <output className="notice">{error}</output>}
    <div className={`calendar-grid calendar-grid-${mode}`}>
      {mode === "month" && ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((weekday) => <div className="calendar-weekday" key={weekday}>{weekday}</div>)}
      {days.map((day) => {
        const key = dateKey(day);
        const dayEvents = eventsByDate.get(key) ?? [];
        return <section className="calendar-day" aria-label={new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" }).format(day)} key={key}
          onDragOver={(event) => { if (editable) event.preventDefault(); }}
          onDrop={(event) => { event.preventDefault(); const nodeId = event.dataTransfer.getData("text/plain"); if (editable && nodeId) void moveNode(nodeId, key); }}>
          <h3>{mode === "month" ? day.getUTCDate() : new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }).format(day)}</h3>
          {dayEvents.map((event) => {
            const eventDate = event.schedule.kind === "allDay" ? event.schedule.startDate : event.schedule.kind === "timed" ? formatInstantInTimeZone(event.schedule.startInstant, timeZone).slice(0, 10) : key;
            return <div className="calendar-event-entry" key={event.node.id}>
              <button className="calendar-event" type="button" draggable={editable && movingNodeId !== event.node.id} onDragStart={(dragEvent) => { dragEvent.dataTransfer.setData("text/plain", event.node.id); }} onClick={() => onOpenNode(event.node)}>
                <span>{event.node.title}</span>{event.schedule.kind === "timed" && <small>{formatInstantInTimeZone(event.schedule.startInstant, timeZone).slice(11)}</small>}
              </button>
              {editable && <input className="calendar-move-date" type="date" aria-label={`Move ${event.node.title} to date`} value={eventDate} disabled={movingNodeId === event.node.id} onChange={(changeEvent) => { if (changeEvent.target.value) void moveNode(event.node.id, changeEvent.target.value); }} />}
            </div>;
          })}
        </section>;
      })}
      {!loading && events.length === 0 && <p className="calendar-empty">No scheduled nodes in this range.</p>}
    </div>
  </section>;
}
