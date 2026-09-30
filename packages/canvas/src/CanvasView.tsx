import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, convertToExcalidrawElements, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { CanvasNodeBinding, JsonValue } from "@workspace/domain";
import { bindCanvasElement, EMPTY_CANVAS_SCENE, projectLiveNodeTitles, validateCanvasScene } from "./index";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";

export interface CanvasNode { readonly id: string; readonly title: string; readonly type: string }
interface StoredCanvas { readonly scene: JsonValue; readonly bindings: readonly CanvasNodeBinding[]; readonly revision: number }
export interface CanvasViewProps {
  readonly canvasId: string; readonly workspaceId: string; readonly csrfToken: string; readonly editable: boolean;
  readonly nodes: readonly CanvasNode[]; readonly onOpenNode: (node: CanvasNode) => void;
  readonly onClose: () => void;
  readonly onCreateNode: (type: "task" | "page", title: string) => Promise<CanvasNode>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init, headers: { ...init?.headers } });
  if (!response.ok) throw new Error(response.status === 409 ? "Canvas changed elsewhere. Reload to continue." : `Canvas request failed (${response.status}).`);
  return response.json() as Promise<T>;
}

export function CanvasView({ canvasId, workspaceId, csrfToken, editable, nodes, onOpenNode, onClose, onCreateNode }: CanvasViewProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const initialSceneRef = useRef(EMPTY_CANVAS_SCENE);
  const setExcalidrawApi = useCallback((api: ExcalidrawImperativeAPI) => { apiRef.current = api; }, []);
  const handleChange = useCallback((elements: readonly unknown[], appState: { selectedElementIds: Record<string, boolean> }) => {
    setSelected(Object.keys(appState.selectedElementIds).find((id) => appState.selectedElementIds[id]) ?? "");
    setScene((current) => ({ ...current, elements: elements as JsonValue[] }));
  }, []);
  const [stored, setStored] = useState<StoredCanvas | null>(null);
  const [scene, setScene] = useState(EMPTY_CANVAS_SCENE);
  const [bindings, setBindings] = useState<readonly CanvasNodeBinding[]>([]);
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<readonly CanvasNode[]>([]);
  const [saveState, setSaveState] = useState("Loading canvas…");
  const [busy, setBusy] = useState(false);
  const [loadKey, setLoadKey] = useState("");
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  useEffect(() => {
    const query = search.trim();
    if (query.length < 2) { setSearchResults([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void request<{ items: readonly { node: CanvasNode }[] }>(`/api/search?workspaceId=${encodeURIComponent(workspaceId)}&query=${encodeURIComponent(query)}&page=1`, { signal: controller.signal })
        .then((result) => setSearchResults(result.items.map(({ node }) => node)))
        .catch(() => { if (!controller.signal.aborted) setSearchResults([]); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [search, workspaceId]);

  useEffect(() => {
    let active = true;
    setLoadKey(""); setSaveState("Loading canvas…");
    void request<StoredCanvas>(`/api/nodes/${canvasId}/canvas?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((data) => {
        if (!active) return;
        const valid = validateCanvasScene(data.scene);
        setStored(data); setBindings(data.bindings);
        const projected = projectLiveNodeTitles(valid, data.bindings, new Map(nodes.map((node) => [node.id, node.title])));
        initialSceneRef.current = projected;
        setScene(projected);
        setLoadKey(canvasId); setSaveState("Saved");
      }).catch((error: unknown) => { if (active) setSaveState(error instanceof Error ? error.message : "Could not load canvas."); });
    return () => { active = false; };
  }, [canvasId, workspaceId]);

  useEffect(() => {
    if (loadKey === canvasId) {
      apiRef.current?.updateScene({ elements: scene.elements as never, appState: scene.appState as never });
      apiRef.current?.addFiles(Object.values(scene.files) as never);
    }
  }, [loadKey, canvasId]);

  useEffect(() => {
    if (!stored || loadKey !== canvasId || !editable) return;
    const timer = window.setTimeout(() => {
      const current = apiRef.current;
      const appState = current?.getAppState();
      const files = current?.getFiles() ?? {};
      const stableState = { viewBackgroundColor: appState?.viewBackgroundColor ?? "#ffffff", gridSize: appState?.gridSize ?? null };
      const payload = { scene: { elements: scene.elements, appState: stableState, files } as unknown as JsonValue, bindings };
      setSaveState("Saving…");
      void request<StoredCanvas>(`/api/nodes/${canvasId}/canvas?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "PUT", headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ ...payload, expectedRevision: stored.revision }),
      }).then((next) => { setStored(next); setSaveState("Saved"); }).catch((error: unknown) => setSaveState(error instanceof Error ? error.message : "Could not save canvas."));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [scene, bindings, stored, canvasId, workspaceId, csrfToken, editable, loadKey]);

  function linkNode(node: CanvasNode) {
    const api = apiRef.current;
    if (!api || !selected) return;
    setBusy(true);
    try {
      let element = api.getSceneElements().find((item) => item.id === selected);
      if (!element) return;
      if (element.type !== "text") {
        const [text] = convertToExcalidrawElements([{ type: "text", x: element.x + 12, y: element.y + 12, text: node.title, fontSize: 20, strokeColor: "#1b1b1f", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, roughness: 0, opacity: 100 }]);
        api.updateScene({ elements: [...api.getSceneElements(), text] }); element = text;
      }
      setSelected(element.id);
      const next = bindCanvasElement({ ...scene, elements: api.getSceneElements() as unknown as JsonValue[] }, element.id, node.id as CanvasNodeBinding["nodeId"]);
      setScene(next); setBindings((current) => [...current.filter((binding) => binding.elementId !== element?.id), { elementId: element!.id, nodeId: node.id as CanvasNodeBinding["nodeId"] }]);
      setSearch("");
    } finally { setBusy(false); }
  }

  async function convertSelected(type: "task" | "page") {
    const api = apiRef.current; const element = api?.getSceneElements().find((item) => item.id === selected);
    if (!api || !element || !search.trim()) return;
    setBusy(true);
    try { const node = await onCreateNode(type, search.trim()); await linkNode(node); }
    finally { setBusy(false); }
  }

  function unlinkSelected() {
    if (!selected) return;
    setBindings((current) => current.filter((binding) => binding.elementId !== selected));
    setScene(bindCanvasElement({ ...scene, elements: apiRef.current?.getSceneElements() as unknown as JsonValue[] }, selected, null));
  }

  function exportScene() {
    const api = apiRef.current; if (!api) return;
    const state = api.getAppState();
    const json = serializeAsJSON(api.getSceneElements(), state, api.getFiles(), "local");
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${canvasId}.excalidraw`; anchor.click(); URL.revokeObjectURL(url);
  }

  const linked = bindings.find(({ elementId }) => elementId === selected);
  const linkedNode = linked ? nodeMap.get(linked.nodeId) : undefined;
  const visibleNodes = searchResults.filter((node) => node.id !== canvasId).slice(0, 8);
  return <section className="canvas-detail" aria-label="Canvas editor">
    <header className="canvas-toolbar"><div><button type="button" onClick={onClose}>← All items</button><strong>Canvas</strong><output>{saveState}</output></div><button type="button" onClick={exportScene}>Export .excalidraw</button></header>
    <div className="canvas-workspace"><div className="canvas-editor"><Excalidraw excalidrawAPI={setExcalidrawApi} initialData={initialSceneRef.current as never} onChange={handleChange} viewModeEnabled={!editable} /></div>
    <aside className="canvas-inspector" aria-label="Canvas node inspector"><h2>Node link</h2>{linkedNode ? <><p>Linked to <strong>{linkedNode.title}</strong> · {linkedNode.type}</p><button type="button" onClick={() => onOpenNode(linkedNode)}>Open node</button>{editable && <button type="button" onClick={unlinkSelected}>Unlink</button>}</> : <p>Select a canvas element to link it to a workspace node.</p>}
      {editable && <><label htmlFor="canvas-node-search">Link existing node</label><input id="canvas-node-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search nodes…" />{search.length > 1 && <ul>{visibleNodes.map((node) => <li key={node.id}><button disabled={busy} type="button" onClick={() => void linkNode(node)}>{node.title} · {node.type}</button></li>)}</ul>}
      <p>Convert the selected element using the text above as its title.</p><button type="button" disabled={busy || !selected || !search.trim()} onClick={() => void convertSelected("task")}>Create task from selection</button><button type="button" disabled={busy || !selected || !search.trim()} onClick={() => void convertSelected("page")}>Create page from selection</button></>}
    </aside></div>
  </section>;
}
