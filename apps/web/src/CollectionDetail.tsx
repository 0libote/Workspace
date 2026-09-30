import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppButton } from "@workspace/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatInstantInTimeZone, resolveLocalDateTime } from "@workspace/calendar";
import { CalendarView } from "@workspace/calendar/view";
import { apiRequest, type CollectionItemsPage, type NodeProperty, type PropertyDefinition, type SavedCollection, type WorkspaceNode } from "./api";
import type { PropertyValue } from "@workspace/domain";

function openLabel(node: WorkspaceNode): string {
  return `Open ${node.type}: ${node.title}`;
}

function nodeTypeIcon(type: string): string {
  if (type === "task") return "◯";
  if (type === "page") return "▤";
  return "◇";
}

function propertyValueText(property: NodeProperty | undefined): string {
  if (!property) return "Not set";
  const value = property.value.value;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}

function VirtualizedRecords<T>({
  items,
  label,
  role,
  estimateSize,
  getKey,
  renderItem,
  header,
}: {
  readonly items: readonly T[];
  readonly label: string;
  readonly role: "list" | "table";
  readonly estimateSize: number;
  readonly getKey: (item: T) => string;
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly header?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : getKey(item);
    },
    overscan: 10,
  });
  const table = role === "table";
  return <div ref={scrollRef} className="collection-virtual-scroll" role={role} aria-label={label} aria-rowcount={table ? items.length + 1 : undefined}>
    {header}
    <div className="collection-virtual-spacer" style={{ height: `${virtualizer.getTotalSize()}px` }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index];
        return item === undefined ? null : <div
          key={virtualRow.key}
          ref={virtualizer.measureElement}
          data-index={virtualRow.index}
          className="collection-virtual-item"
          style={{ transform: `translateY(${virtualRow.start}px)` }}
          role={table ? "row" : "listitem"}
          aria-rowindex={table ? virtualRow.index + 2 : undefined}
        >{renderItem(item, virtualRow.index)}</div>;
      })}
    </div>
  </div>;
}

function PropertyEditorCell({
  node,
  definition,
  property,
  timeZone,
  editable,
  saving,
  onSave,
}: {
  readonly node: WorkspaceNode;
  readonly definition: PropertyDefinition;
  readonly property: NodeProperty | undefined;
  readonly timeZone: string;
  readonly editable: boolean;
  readonly saving: boolean;
  readonly onSave: (value: PropertyValue | null) => void;
}) {
  const current = property?.value.value;
  const disabled = !editable || saving;
  const label = `${node.title} · ${definition.name}`;
  const options = definition.options ?? [];
  const textValue = typeof current === "string" ? current : "";
  const numberValue = typeof current === "number" ? String(current) : "";
  const [textDraft, setTextDraft] = useState(textValue);
  const [numberDraft, setNumberDraft] = useState(numberValue);
  useEffect(() => setTextDraft(textValue), [textValue]);
  useEffect(() => setNumberDraft(numberValue), [numberValue]);
  switch (definition.type) {
    case "text":
    case "email":
    case "url":
    case "phone": {
      const inputType = { text: "text", email: "email", url: "url", phone: "text" }[definition.type];
      return <input className="collection-property-input" aria-label={label} type={inputType} value={textDraft} disabled={disabled} onChange={(event) => setTextDraft(event.target.value)} onBlur={() => {
        if (textDraft !== textValue) onSave(textDraft ? { type: definition.type as "text" | "email" | "url" | "phone", value: textDraft } : null);
      }} />;
    }
    case "number":
    case "duration": {
      return <input className="collection-property-input" aria-label={label} type="number" min={definition.type === "duration" ? 0 : undefined} step="any" value={numberDraft} disabled={disabled} onChange={(event) => setNumberDraft(event.target.value)} onBlur={() => {
        if (numberDraft === numberValue) return;
        const parsed = Number(numberDraft);
        if (numberDraft !== "" && !Number.isFinite(parsed)) return;
        onSave(numberDraft === "" ? null : { type: definition.type as "number" | "duration", value: parsed });
      }} />;
    }
    case "boolean":
      return <select aria-label={label} value={typeof current === "boolean" ? String(current) : ""} disabled={disabled} onChange={(event) => onSave(event.target.value === "" ? null : { type: "boolean", value: event.target.value === "true" })}><option value="">Not set</option><option value="true">Yes</option><option value="false">No</option></select>;
    case "date":
      return <input aria-label={label} type="date" value={typeof current === "string" ? current : ""} disabled={disabled} onChange={(event) => onSave(event.target.value ? { type: "date", value: event.target.value } : null)} />;
    case "dateTime":
      return <input aria-label={label} type="datetime-local" value={typeof current === "string" ? formatInstantInTimeZone(current, timeZone) : ""} disabled={disabled} onChange={(event) => {
        if (!event.target.value) { onSave(null); return; }
        const resolution = resolveLocalDateTime(event.target.value, timeZone);
        if (resolution.kind !== "nonexistent") onSave({ type: "dateTime", value: resolution.instant });
      }} />;
    case "select":
    case "status":
      return <select aria-label={label} value={typeof current === "string" ? current : ""} disabled={disabled} onChange={(event) => onSave(event.target.value ? { type: definition.type as "select" | "status", value: event.target.value } : null)}><option value="">Not set</option>{options.map((option) => <option value={option} key={option}>{option}</option>)}</select>;
    case "multiSelect":
      return <select aria-label={label} multiple value={Array.isArray(current) ? current : []} disabled={disabled} onChange={(event) => onSave({ type: "multiSelect", value: [...event.currentTarget.selectedOptions].map((option) => option.value) })}>{options.map((option) => <option value={option} key={option}>{option}</option>)}</select>;
    default:
      return <output className="collection-property-readonly" aria-label={label}>{propertyValueText(property)}</output>;
  }
}

export function CollectionDetail({
  collection,
  workspaceId,
  timeZone,
  csrfToken,
  editable,
  onOpenNode,
  onClose,
}: {
  readonly collection: SavedCollection;
  readonly workspaceId: string;
  readonly timeZone: string;
  readonly csrfToken: string;
  readonly editable: boolean;
  readonly onOpenNode: (node: WorkspaceNode) => void;
  readonly onClose: () => void;
}) {
  const [items, setItems] = useState<readonly WorkspaceNode[]>([]);
  const [definitions, setDefinitions] = useState<readonly PropertyDefinition[]>([]);
  const [properties, setProperties] = useState<readonly NodeProperty[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setDefinitions([]);
    setProperties([]);
    setPage(1);
    setLoading(true);
    setError("");
    void apiRequest<CollectionItemsPage>(`/api/collections/${collection.id}/items?workspaceId=${encodeURIComponent(workspaceId)}&page=1`, { signal: controller.signal })
      .then((result) => {
        setItems(result.items);
        setDefinitions(result.propertyDefinitions);
        setProperties(result.properties);
        setHasMore(result.hasMore);
      })
      .catch(() => { if (!controller.signal.aborted) setError("Could not load this collection. Try again."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [collection.id, workspaceId]);

  async function loadMore() {
    if (!hasMore || loading) return;
    setLoading(true);
    setError("");
    const nextPage = page + 1;
    try {
      const result = await apiRequest<CollectionItemsPage>(`/api/collections/${collection.id}/items?workspaceId=${encodeURIComponent(workspaceId)}&page=${nextPage}`);
      setItems((current) => [...current, ...result.items]);
      setProperties((current) => [...current, ...result.properties]);
      setHasMore(result.hasMore);
      setPage(nextPage);
    } catch {
      setError("Could not load the next page. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function updateProperty(node: WorkspaceNode, definition: PropertyDefinition, value: PropertyValue | null) {
    if (!editable || savingKey) return;
    const key = `${node.id}:${definition.id}`;
    const existing = properties.find((property) => property.nodeId === node.id && property.definitionId === definition.id);
    const previous = existing;
    setSavingKey(key);
    setError("");
    if (value === null) setProperties((current) => current.filter((property) => !(property.nodeId === node.id && property.definitionId === definition.id)));
    else setProperties((current) => [...current.filter((property) => !(property.nodeId === node.id && property.definitionId === definition.id)), { nodeId: node.id, definitionId: definition.id, value }]);
    const path = `/api/nodes/${node.id}/properties/${definition.id}?workspaceId=${encodeURIComponent(workspaceId)}`;
    try {
      if (value === null) {
        if (existing) await apiRequest<void>(path, { method: "DELETE", headers: { "x-csrf-token": csrfToken } });
      } else {
        const saved = await apiRequest<NodeProperty>(path, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ value }),
        });
        setProperties((current) => [...current.filter((property) => !(property.nodeId === saved.nodeId && property.definitionId === saved.definitionId)), saved]);
      }
    } catch {
      setProperties((current) => [
        ...current.filter((property) => !(property.nodeId === node.id && property.definitionId === definition.id)),
        ...(previous ? [previous] : []),
      ]);
      setError(`Could not save ${definition.name} on ${node.title}.`);
    } finally {
      setSavingKey("");
    }
  }

  function openNode(node: WorkspaceNode) {
    if (node.type === "task" || node.type === "page") onOpenNode(node);
  }

  function propertyFor(node: WorkspaceNode, definitionId: string) {
    return properties.find((property) => property.nodeId === node.id && property.definitionId === definitionId);
  }

  function renderColumn(node: WorkspaceNode, column: string): ReactNode {
    if (column === "type") return node.type;
    if (column === "createdAt") return new Date(node.createdAt).toLocaleDateString();
    if (column === "updatedAt") return new Date(node.updatedAt).toLocaleDateString();
    if (column === "title") return node.type === "task" || node.type === "page"
      ? <button className="collection-title-button" type="button" onClick={() => openNode(node)}>{node.title}</button>
      : node.title;
    const definition = definitions.find((item) => item.id === column);
    if (!definition) return <span className="collection-property-readonly">Unavailable property</span>;
    const property = propertyFor(node, column);
    return <PropertyEditorCell
      node={node}
      definition={definition}
      property={property}
      timeZone={timeZone}
      editable={editable}
      saving={savingKey !== ""}
      onSave={(value) => void updateProperty(node, definition, value)}
    />;
  }

  const standardColumnLabels: Readonly<Record<string, string>> = { updatedAt: "Updated", createdAt: "Created", type: "Type" };
  const definitionLabel = (column: string) => definitions.find((definition) => definition.id === column)?.name ?? standardColumnLabels[column] ?? "Title";
  const openButton = (node: WorkspaceNode) => (node.type === "task" || node.type === "page")
    ? <AppButton label={openLabel(node)} variant="ghost" size="sm" onClick={() => openNode(node)} />
    : null;
  const extraColumns = collection.view.columns.filter((column) => column !== "title");
  const tableColumns = `repeat(${collection.view.columns.length}, minmax(8rem, 1fr)) minmax(8rem, auto)`;
  const tableHeader = <div className="collection-table-grid-header" role="row" style={{ gridTemplateColumns: tableColumns }}>
    {collection.view.columns.map((column) => <div role="columnheader" key={column}>{definitionLabel(column)}</div>)}
    <div role="columnheader"><span className="visually-hidden">Open</span></div>
  </div>;
  const renderTableRow = (node: WorkspaceNode) => <div className="collection-table-grid-row" role="presentation" style={{ gridTemplateColumns: tableColumns }}>
    {collection.view.columns.map((column) => <div className="collection-table-grid-cell" role="cell" key={column}>{renderColumn(node, column)}</div>)}
    <div className="collection-table-grid-cell" role="cell">{openButton(node)}</div>
  </div>;
  const renderListRow = (node: WorkspaceNode) => <article className="item-row">
    <span className={`type-icon type-${node.type}`} aria-hidden="true">{nodeTypeIcon(node.type)}</span>
    <span className="item-title">{renderColumn(node, "title")}</span>
    {extraColumns.map((column) => <span className="collection-list-field" key={column}><span>{definitionLabel(column)}: </span>{renderColumn(node, column)}</span>)}
    {openButton(node)}
  </article>;

  const collectionView = (() => {
    if (collection.view.layout === "calendar") {
      return <CalendarView workspaceId={workspaceId} timeZone={timeZone} csrfToken={csrfToken} editable={editable} collectionId={collection.id} onOpenNode={onOpenNode} />;
    }
    if (loading && items.length === 0) return <output className="loading">Loading collection…</output>;
    if (items.length === 0) return <div className="quiet-empty"><span aria-hidden="true">▦</span><p>No nodes match this collection yet.</p></div>;
    if (collection.view.layout === "table") {
      return <VirtualizedRecords items={items} role="table" label="Collection table" estimateSize={52} getKey={(node) => node.id} header={tableHeader} renderItem={renderTableRow} />;
    }
    if (collection.view.layout === "board") {
      const types = [...new Set(items.map(({ type }) => type))];
      return <div className="collection-board">{types.map((type) => {
        const groupedNodes = items.filter((node) => node.type === type);
        return <section className="collection-board-column" key={type}><h2>{type}<span>{groupedNodes.length}</span></h2><VirtualizedRecords items={groupedNodes} role="list" label={`${type} collection items`} estimateSize={170} getKey={(node) => node.id} renderItem={(node) => <article className="collection-board-card"><span className="collection-card-title">{node.title}</span>{extraColumns.map((column) => <label className="collection-card-field" key={column}><span>{definitionLabel(column)}</span>{renderColumn(node, column)}</label>)}{openButton(node)}</article>} /></section>;
      })}</div>;
    }
    return <VirtualizedRecords items={items} role="list" label="Collection items" estimateSize={78} getKey={(node) => node.id} renderItem={renderListRow} />;
  })();

  return <section className="collection-detail" aria-label={`Collection: ${collection.name}`}>
    <div className="collection-toolbar"><AppButton label="Back to items" variant="ghost" onClick={onClose} /><span className="document-save-state">Saved collection</span></div>
    <div className="collection-heading"><div><div className="eyebrow">COLLECTION · {collection.view.layout.toUpperCase()}</div><h1>{collection.name}</h1><p>{collection.query.types.length ? collection.query.types.join(", ") : "All node types"}{collection.query.titleContains ? ` · title contains “${collection.query.titleContains}”` : ""} · sorted by {collection.query.sortBy} ({collection.query.sortDirection})</p></div><span className="count-label">{items.length} {items.length === 1 ? "item" : "items"}</span></div>
    {error && <p className="notice" role="alert">{error}</p>}
    {collectionView}
    {collection.view.layout !== "calendar" && hasMore && <div className="search-more"><AppButton label="Load more collection items" variant="ghost" onClick={() => void loadMore()} isLoading={loading} /></div>}
  </section>;
}
