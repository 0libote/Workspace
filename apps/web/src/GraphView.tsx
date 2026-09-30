import { useEffect, useMemo, useState } from "react";
import type { WorkspaceGraph } from "@workspace/domain";
import type { WorkspaceNode } from "./api";

interface GraphViewProps {
  readonly workspaceId: string;
  readonly nodes: readonly WorkspaceNode[];
  readonly onOpenNode: (node: WorkspaceNode) => void;
}

export function GraphView({ workspaceId, nodes, onOpenNode }: GraphViewProps) {
  const [rootId, setRootId] = useState("");
  const [depth, setDepth] = useState<"1" | "2">("1");
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ workspaceId, depth, limit: "150" });
    if (rootId) params.set("nodeId", rootId);
    setLoading(true); setError("");
    void fetch(`/api/graph?${params}`, { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load the relationship graph.");
        return await response.json() as WorkspaceGraph;
      })
      .then(setGraph)
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load the relationship graph."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, rootId, depth]);

  const points = useMemo(() => {
    if (!graph) return new Map<string, { x: number; y: number }>();
    const center = { x: 420, y: 270 };
    return new Map(graph.nodes.map((node, index) => {
      if (node.id === rootId || (!rootId && index === 0)) return [node.id, center] as const;
      let positionIndex = index;
      if (rootId && graph.nodes.some((item) => item.id === rootId)) positionIndex -= 1;
      const angle = (Math.PI * 2 * positionIndex) / Math.max(1, graph.nodes.length - 1);
      return [node.id, { x: center.x + Math.cos(angle) * 240, y: center.y + Math.sin(angle) * 190 }] as const;
    }));
  }, [graph, rootId]);
  const showEmptyGraph = !loading && !error && !graph?.nodes.length;

  return <section className="graph-view" aria-label="Workspace graph">
    <header className="graph-toolbar"><div><label htmlFor="graph-root">Focus node</label><select id="graph-root" value={rootId} onChange={(event) => setRootId(event.target.value)}><option value="">Whole workspace</option>{nodes.filter((node) => !node.archivedAt).map((node) => <option key={node.id} value={node.id}>{node.title} · {node.type}</option>)}</select></div><label htmlFor="graph-depth">Connections</label><select id="graph-depth" value={depth} onChange={(event) => setDepth(event.target.value as "1" | "2")}><option value="1">1 step</option><option value="2">2 steps</option></select><span role="status">{loading ? "Loading graph…" : graph ? `${graph.nodes.length} nodes · ${graph.edges.length} connections` : ""}</span></header>
    {error && <p className="notice" role="alert">{error}</p>}{graph?.truncated && <p className="viewer-note">Showing a bounded slice of this workspace graph. Focus a node to explore its nearby connections.</p>}
    {graph?.nodes.length ? <div className="graph-canvas"><svg viewBox="0 0 840 540" role="img" aria-label="Relationship links between workspace nodes">
      {graph.edges.map((edge) => { const from = points.get(edge.source); const to = points.get(edge.target); return from && to ? <g key={edge.id}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="graph-edge" /><text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 6} className="graph-edge-label">{edge.type}</text></g> : null; })}
      {graph.nodes.map((node) => { const point = points.get(node.id)!; return <g key={node.id} transform={`translate(${point.x},${point.y})`} className={node.id === rootId ? "graph-vertex graph-root" : "graph-vertex"}>
        <circle r="39" /><text y="4" textAnchor="middle">{node.type}</text><text y="60" textAnchor="middle" className="graph-node-title">{node.title.slice(0, 32)}</text>
      </g>; })}
    </svg><div className="graph-node-actions" aria-label="Open graph nodes">{graph.nodes.map((node) => { const item = nodeById.get(node.id); return item ? <button key={node.id} type="button" onClick={() => onOpenNode(item)}>{node.title} <span>{node.type} · open</span></button> : null; })}</div></div> : null}
    {showEmptyGraph && <p className="quiet-empty">No nodes are available in this graph.</p>}
  </section>;
}
