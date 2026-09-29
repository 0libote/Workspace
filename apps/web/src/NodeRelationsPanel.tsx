import { useEffect, useState, type FormEvent } from "react";
import { AppButton } from "@workspace/ui";
import { formatInstantInTimeZone } from "@workspace/calendar";
import { apiRequest, type NodeProperty, type NodeRelation, type PropertyDefinition, type RelationDefinition, type WorkspaceNode } from "./api";

export function NodeRelationsPanel({
  node,
  nodes,
  workspaceId,
  timeZone,
  csrfToken,
  editable,
  onOpen,
}: {
  readonly node: WorkspaceNode;
  readonly nodes: readonly WorkspaceNode[];
  readonly workspaceId: string;
  readonly timeZone: string;
  readonly csrfToken: string;
  readonly editable: boolean;
  readonly onOpen: (node: WorkspaceNode) => void;
}) {
  const [definitions, setDefinitions] = useState<readonly RelationDefinition[]>([]);
  const [outgoing, setOutgoing] = useState<readonly NodeRelation[]>([]);
  const [incoming, setIncoming] = useState<readonly NodeRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [definitionDialog, setDefinitionDialog] = useState(false);
  const [scheduleByNodeId, setScheduleByNodeId] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void Promise.all([
      apiRequest<readonly RelationDefinition[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/relations`, { signal: controller.signal }),
      apiRequest<readonly NodeRelation[]>(`/api/nodes/${node.id}/relations?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal }),
      apiRequest<readonly NodeRelation[]>(`/api/nodes/${node.id}/backlinks?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal }),
    ]).then(([nextDefinitions, nextOutgoing, nextIncoming]) => {
      setDefinitions(nextDefinitions);
      setOutgoing(nextOutgoing);
      setIncoming(nextIncoming);
    }).catch(() => {
      if (!controller.signal.aborted) setError("Could not load connections for this item.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [node.id, workspaceId]);

  const relatedNodeIds = [...new Set([...outgoing.map(({ toNodeId }) => toNodeId), ...incoming.map(({ fromNodeId }) => fromNodeId)])].sort();
  const relatedNodeIdsKey = relatedNodeIds.join(",");
  useEffect(() => {
    if (!relatedNodeIdsKey) { setScheduleByNodeId({}); return; }
    let active = true;
    const ids = relatedNodeIdsKey.split(",");
    void Promise.all([
      apiRequest<readonly PropertyDefinition[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/properties`),
      ...ids.map((id) => apiRequest<readonly NodeProperty[]>(`/api/nodes/${encodeURIComponent(id)}/properties?workspaceId=${encodeURIComponent(workspaceId)}`)),
    ]).then(([definitions, ...propertyGroups]) => {
      if (!active) return;
      const nameByDefinitionId = new Map((definitions as readonly PropertyDefinition[]).map(({ id, name }) => [id, name]));
      const next: Record<string, string> = {};
      ids.forEach((id, index) => {
        const values = propertyGroups[index] as readonly NodeProperty[] | undefined;
        const byName = new Map((values ?? []).map((property) => [nameByDefinitionId.get(property.definitionId), property.value]));
        const start = byName.get("Start time") ?? byName.get("Start date");
        const due = byName.get("Due time") ?? byName.get("Due date");
        const formatValue = (value: typeof start) => {
          if (value?.type === "dateTime") return formatInstantInTimeZone(value.value, timeZone).replace("T", " ");
          return value?.type === "date" ? value.value : undefined;
        };
        const startText = formatValue(start);
        const dueText = formatValue(due);
        if (startText || dueText) next[id] = `${startText ? `Starts ${startText}` : "Scheduled"}${dueText ? ` · due ${dueText}` : ""}`;
      });
      setScheduleByNodeId(next);
    }).catch(() => { if (active) setScheduleByNodeId({}); });
    return () => { active = false; };
  }, [relatedNodeIdsKey, workspaceId, timeZone]);

  function findNode(id: string) {
    return nodes.find((item) => item.id === id);
  }

  async function createDefinition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || saving) return;
    const form = new FormData(event.currentTarget);
    const type = String(form.get("type") ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    const fromLabel = String(form.get("fromLabel") ?? "").trim();
    const toLabel = String(form.get("toLabel") ?? "").trim();
    setSaving(true);
    setError("");
    try {
      const definition = await apiRequest<RelationDefinition>(`/api/workspaces/${encodeURIComponent(workspaceId)}/relations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ type, fromLabel, toLabel }),
      });
      setDefinitions((current) => [...current, definition]);
      setDefinitionDialog(false);
    } catch {
      setError("Could not create this connection type. Use a unique type with letters, numbers, hyphens, or underscores.");
    } finally {
      setSaving(false);
    }
  }

  async function createLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || saving) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const toNodeId = String(form.get("toNodeId") ?? "");
    const type = String(form.get("type") ?? "");
    if (!toNodeId || !type) return;
    setSaving(true);
    setError("");
    try {
      const relation = await apiRequest<NodeRelation>(`/api/nodes/${node.id}/relations?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ toNodeId, type }),
      });
      setOutgoing((current) => [...current, relation]);
      formElement.reset();
    } catch {
      setError("Could not connect these items. Refresh and try again.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="node-relations" aria-labelledby={`connections-${node.id}`}>
    <div className="node-relations-heading"><div><div className="eyebrow">SHARED NODES</div><h2 id={`connections-${node.id}`}>Connections</h2></div>{editable && <AppButton label="＋ Connection type" variant="ghost" size="sm" onClick={() => setDefinitionDialog(true)} />}</div>
    {error && !definitionDialog && <p className="notice" role="alert">{error}</p>}
    {loading ? <p className="loading" role="status">Loading connections…</p> : <>
      {editable && definitions.length > 0 && nodes.some((item) => item.id !== node.id && !item.archivedAt) && <form className="relation-create-form" onSubmit={(event) => void createLink(event)}>
        <label><span>Connection</span><select name="type" aria-label="Connection type" required defaultValue={definitions[0]?.type}>{definitions.map((definition) => <option value={definition.type} key={definition.id}>{definition.fromLabel}</option>)}</select></label>
        <label><span>Item</span><select name="toNodeId" aria-label="Connect to item" required defaultValue=""><option value="" disabled>Choose an item</option>{nodes.filter((item) => item.id !== node.id && !item.archivedAt).map((item) => <option value={item.id} key={item.id}>{item.title} · {item.type}</option>)}</select></label>
        <AppButton label="Connect" variant="primary" size="sm" type="submit" isLoading={saving} />
      </form>}
      {outgoing.length === 0 && incoming.length === 0 ? <p className="quiet-empty">No connections yet. Connect this item to another node to keep related work together.</p> : <ul className="relation-list">
        {outgoing.map((relation) => {
          const target = findNode(relation.toNodeId);
          const definition = definitions.find((item) => item.type === relation.type);
          return target && <li key={relation.id}><span className="relation-label">{definition?.fromLabel ?? relation.type}</span><button type="button" className="relation-node-link" onClick={() => onOpen(target)}>{target.title}<span>{target.type}</span>{scheduleByNodeId[target.id] && <small className="relation-node-schedule">{scheduleByNodeId[target.id]}</small>}</button></li>;
        })}
        {incoming.map((relation) => {
          const source = findNode(relation.fromNodeId);
          const definition = definitions.find((item) => item.type === relation.type);
          return source && <li key={relation.id}><span className="relation-label">{definition?.toLabel ?? relation.type}</span><button type="button" className="relation-node-link" onClick={() => onOpen(source)}>{source.title}<span>{source.type}</span>{scheduleByNodeId[source.id] && <small className="relation-node-schedule">{scheduleByNodeId[source.id]}</small>}</button></li>;
        })}
      </ul>}
    </>}
    {definitionDialog && <div className="workspace-dialog-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setDefinitionDialog(false); }}><section className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby={`connection-dialog-title-${node.id}`}><div className="eyebrow">WORKSPACE RELATION</div><h2 id={`connection-dialog-title-${node.id}`}>Add a connection type</h2><form onSubmit={(event) => void createDefinition(event)}><label htmlFor={`relation-type-${node.id}`}>Type key</label><input id={`relation-type-${node.id}`} name="type" required maxLength={80} pattern="[a-zA-Z][a-zA-Z0-9 _-]*" placeholder="e.g. supports" /><label htmlFor={`relation-from-${node.id}`}>Label from this item</label><input id={`relation-from-${node.id}`} name="fromLabel" required maxLength={120} placeholder="e.g. supports" /><label htmlFor={`relation-to-${node.id}`}>Inverse label</label><input id={`relation-to-${node.id}`} name="toLabel" required maxLength={120} placeholder="e.g. is supported by" />{error && <p className="notice" role="alert">{error}</p>}<div className="workspace-dialog-actions"><AppButton label="Cancel" variant="ghost" type="button" onClick={() => setDefinitionDialog(false)} /><AppButton label="Add connection type" variant="primary" type="submit" isLoading={saving} /></div></form></section></div>}
  </section>;
}
