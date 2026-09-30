import { StrictMode, Suspense, lazy, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AppButton, AppTheme } from "@workspace/ui";
import { getPlatform } from "@workspace/platform";
import { apiRequest, ApiError, type NodePage, type NodeProperty, type NodeSearchPage, type PageDocument, type PropertyDefinition, type SavedCollection, type Session, type TaskStatusDefinition, type WorkspaceNode, type WorkspaceSummary } from "./api";
import { NodeRelationsPanel } from "./NodeRelationsPanel";
import { ModalDialog } from "./ModalDialog";
import { formString } from "./form-data";
import { CollectionDetail } from "./CollectionDetail";
import { GraphView } from "./GraphView";
import { CalendarView } from "@workspace/calendar/view";
const CanvasView = lazy(() => import("@workspace/canvas/view").then(({ CanvasView }) => ({ default: CanvasView })));
import { formatInstantInTimeZone, resolveLocalDateTime } from "@workspace/calendar";
import { validateNodeDocumentContent, type JsonValue, type PropertyValue, type WorkspaceExport } from "@workspace/domain";
import "@workspace/ui/styles.css";
import "./styles.css";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
    console.warn("Could not register the offline application shell", error);
  });
}

type NodeView = "all" | "task" | "page" | "calendar" | "canvas" | "graph";
const PageEditor = lazy(() => import("@workspace/editor").then(({ PageEditor: Editor }) => ({ default: Editor })));

function stringPropertyValue(type: "text" | "email" | "url" | "phone", value: string): PropertyValue {
  // These four property variants all carry strings; the type argument preserves their discriminant.
  return { type, value } as PropertyValue;
}

function propertyDisplayValue(value: unknown): string {
  if (value === undefined) return "Not set";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

function pageSaveStateText(state: "saved" | "unsaved" | "saving" | "error"): string {
  switch (state) {
    case "saved": return "All changes saved";
    case "unsaved": return "Unsaved changes";
    case "saving": return "Saving…";
    case "error": return "Save needs attention";
  }
}

function nodeTypeIcon(type: string): string {
  if (type === "task") return "◯";
  if (type === "page") return "▤";
  return "◇";
}

function collectionLayoutIcon(layout: SavedCollection["view"]["layout"]): string {
  const icons: Record<SavedCollection["view"]["layout"], string> = {
    board: "▥",
    table: "▦",
    calendar: "◷",
    list: "☷",
  };
  return icons[layout];
}

function emptyNodeMessage(view: NodeView): string {
  switch (view) {
    case "all": return "Nothing here yet. Your first idea can go right above.";
    case "task": return "No tasks yet. Add one above to get started.";
    case "canvas": return "No canvases yet. Add one above to get started.";
    default: return "No pages yet. Add one above to get started.";
  }
}

function safeFilenameStem(value: string): string {
  let result = "";
  let hasSeparator = false;
  for (const character of value) {
    const normalized = character.toLowerCase();
    const code = normalized.codePointAt(0)!;
    const safe = normalized.length === 1 && ((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || character === "_" || character === "-");
    if (safe) {
      result += character;
      hasSeparator = false;
    } else if (!hasSeparator) {
      result += "-";
      hasSeparator = true;
    }
  }
  return result;
}

function trimFilenameSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  while (value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

interface LocalPageDraft {
  readonly baseRevision: number;
  readonly content: readonly JsonValue[];
  readonly savedAt: string;
}

function readLocalPageDraft(key: string): LocalPageDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("baseRevision" in parsed) || !("content" in parsed) || !("savedAt" in parsed)) return null;
    if (typeof parsed.baseRevision !== "number" || !Number.isInteger(parsed.baseRevision) || parsed.baseRevision < 0 || typeof parsed.savedAt !== "string") return null;
    return { baseRevision: parsed.baseRevision, content: validateNodeDocumentContent(parsed.content), savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

function writeLocalPageDraft(key: string, draft: LocalPageDraft): void {
  try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* Keep remote autosave available when local storage is full. */ }
}

function removeLocalPageDraftIfMatching(key: string, content: readonly JsonValue[]): void {
  const draft = readLocalPageDraft(key);
  if (draft && JSON.stringify(draft.content) === JSON.stringify(content)) {
    try { localStorage.removeItem(key); } catch { /* The saved page remains available on the server. */ }
  }
}

function nodeViewFromHash(hash: string): NodeView {
  if (hash === "#tasks") return "task";
  if (hash === "#pages") return "page";
  if (hash === "#calendar") return "calendar";
  if (hash === "#canvas") return "canvas";
  if (hash === "#graph") return "graph";
  return "all";
}

function App() {
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [activeView, setActiveView] = useState<NodeView>(() => nodeViewFromHash(window.location.hash));
  const [nodes, setNodes] = useState<WorkspaceNode[]>([]);
  const [taskStatusDefinition, setTaskStatusDefinition] = useState<TaskStatusDefinition | null>(null);
  const [taskStatuses, setTaskStatuses] = useState<Record<string, string | null>>({});
  const [savingTaskStatusNodeId, setSavingTaskStatusNodeId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchType, setSearchType] = useState("");
  const [searchResult, setSearchResult] = useState<NodeSearchPage | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [savedCollections, setSavedCollections] = useState<readonly SavedCollection[]>([]);
  const [openedCollection, setOpenedCollection] = useState<SavedCollection | null>(null);
  const [collectionDialogOpen, setCollectionDialogOpen] = useState(false);
  const [collectionBeingEdited, setCollectionBeingEdited] = useState<SavedCollection | null>(null);
  const [collectionPropertyDefinitions, setCollectionPropertyDefinitions] = useState<readonly PropertyDefinition[]>([]);
  const [openedPage, setOpenedPage] = useState<WorkspaceNode | null>(null);
  const [openedTask, setOpenedTask] = useState<WorkspaceNode | null>(null);
  const [openedCanvas, setOpenedCanvas] = useState<WorkspaceNode | null>(null);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [workspaceTimeZoneDraft, setWorkspaceTimeZoneDraft] = useState("UTC");
  const [savingWorkspaceSettings, setSavingWorkspaceSettings] = useState(false);
  const [exportingWorkspace, setExportingWorkspace] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    const syncViewFromLocation = () => setActiveView(nodeViewFromHash(window.location.hash));
    window.addEventListener("hashchange", syncViewFromLocation);
    return () => window.removeEventListener("hashchange", syncViewFromLocation);
  }, []);

  async function bootstrap() {
    try {
      const status = await apiRequest<{ setupRequired: boolean }>("/api/setup/status");
      setSetupRequired(status.setupRequired);
      if (status.setupRequired) return;
      try {
        const current = await apiRequest<Session>("/api/auth/me");
        setSession(current);
        await loadWorkspaces();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
      }
    } catch {
      setNotice("The workspace service is unavailable. Check that the server and database are running.");
      setSetupRequired(false);
    }
  }

  async function loadWorkspaces() {
    const result = await apiRequest<WorkspaceSummary[]>("/api/workspaces");
    setWorkspaces(result);
    setWorkspaceId((current) => current && result.some((workspace) => workspace.id === current) ? current : result[0]?.id ?? "");
  }

  function selectWorkspace(nextWorkspaceId: string) {
    setOpenedPage(null);
    setOpenedTask(null);
    setOpenedCollection(null);
    setOpenedCanvas(null);
    setCollectionDialogOpen(false);
    setCollectionBeingEdited(null);
    setWorkspaceDialogOpen(false);
    setWorkspaceSettingsOpen(false);
    setWorkspaceId(nextWorkspaceId);
  }

  useEffect(() => {
    if (!session || !workspaceId) {
      setNodes([]);
      setTaskStatusDefinition(null);
      setTaskStatuses({});
      return;
    }
    const controller = new AbortController();
    setNodes([]);
    setTaskStatusDefinition(null);
    setTaskStatuses({});
    void apiRequest<NodePage>(`/api/nodes?workspaceId=${encodeURIComponent(workspaceId)}&limit=100&includeTaskStatus=true`, { signal: controller.signal })
      .then((page) => {
        setNodes([...page.items]);
        setTaskStatusDefinition(page.taskStatusDefinition ?? null);
        setTaskStatuses(Object.fromEntries((page.taskStatuses ?? []).map(({ nodeId, value }) => [nodeId, value])));
      })
      .catch(() => {
        if (!controller.signal.aborted) setNotice("Could not load items for this workspace.");
      });
    return () => controller.abort();
  }, [session, workspaceId]);

  useEffect(() => {
    if (!collectionDialogOpen || !workspaceId) return;
    const controller = new AbortController();
    void apiRequest<readonly PropertyDefinition[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/properties`, { signal: controller.signal })
      .then(setCollectionPropertyDefinitions)
      .catch(() => { if (!controller.signal.aborted) setNotice("Could not load property columns for this collection."); });
    return () => controller.abort();
  }, [collectionDialogOpen, workspaceId]);

  useEffect(() => {
    if (!session || !workspaceId) {
      setSavedCollections([]);
      setOpenedCollection(null);
      return;
    }
    const controller = new AbortController();
    void apiRequest<readonly SavedCollection[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/collections`, { signal: controller.signal })
      .then(setSavedCollections)
      .catch(() => { if (!controller.signal.aborted) setNotice("Could not load saved collections for this workspace."); });
    return () => controller.abort();
  }, [session, workspaceId]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!session || !workspaceId || query.length < 2) {
      setSearchResult(null);
      setSearchError("");
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      setSearchResult(null);
      setSearchError("");
      const params = new URLSearchParams({ workspaceId, query, page: "1" });
      if (searchType) params.set("type", searchType);
      void apiRequest<NodeSearchPage>(`/api/search?${params}`, { signal: controller.signal })
        .then(setSearchResult)
        .catch(() => { if (!controller.signal.aborted) setSearchError("Search could not be completed. Try again."); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [session, workspaceId, searchQuery, searchType]);

  async function loadMoreSearchResults() {
    if (!searchResult?.hasMore || searching) return;
    setSearching(true);
    setSearchError("");
    const params = new URLSearchParams({ workspaceId, query: searchQuery.trim(), page: String(searchResult.page + 1) });
    if (searchType) params.set("type", searchType);
    try {
      const next = await apiRequest<NodeSearchPage>(`/api/search?${params}`);
      setSearchResult((current) => current ? { ...next, items: [...current.items, ...next.items] } : next);
    } catch {
      setSearchError("Could not load more search results.");
    } finally {
      setSearching(false);
    }
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    const path = setupRequired ? "/api/setup" : "/api/auth/login";
    try {
      const result = await apiRequest<Session>(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
          ...(setupRequired ? { displayName: form.get("displayName"), workspaceName: form.get("workspaceName"), timeZone: form.get("timeZone") } : {}),
        }),
      });
      setSession(result);
      setSetupRequired(false);
      await loadWorkspaces();
    } catch (error) {
      setNotice(error instanceof ApiError && error.status === 409 ? "Owner setup has already been completed. Sign in instead." : "Could not sign in. Check your details and try again.");
      if (error instanceof ApiError && error.status === 409) setSetupRequired(false);
    } finally {
      setBusy(false);
    }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const workspace = await apiRequest<WorkspaceSummary>("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ name: form.get("name"), timeZone: form.get("timeZone") }),
      });
      setWorkspaces((current) => [...current, workspace]);
      setWorkspaceId(workspace.id);
      setWorkspaceDialogOpen(false);
      formElement.reset();
      setNotice("");
    } catch {
      setNotice("Could not create the workspace. Please try again.");
    }
  }

  async function saveWorkspaceSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !workspaceId) return;
    setSavingWorkspaceSettings(true);
    setNotice("");
    try {
      const updated = await apiRequest<{ readonly id: string; readonly timeZone: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ timeZone: workspaceTimeZoneDraft }),
      });
      setWorkspaces((current) => current.map((workspace) => workspace.id === updated.id ? { ...workspace, timeZone: updated.timeZone } : workspace));
      setWorkspaceSettingsOpen(false);
    } catch {
      setNotice("Enter a valid IANA time zone, such as Europe/London or America/New_York.");
    } finally {
      setSavingWorkspaceSettings(false);
    }
  }

  async function exportWorkspace(): Promise<void> {
    if (!workspaceId || !activeWorkspace) return;
    setExportingWorkspace(true);
    setNotice("");
    try {
      const snapshot = await apiRequest<WorkspaceExport>(`/api/workspaces/${encodeURIComponent(workspaceId)}/export`);
      await getPlatform().saveFile(`astryx-${workspaceId.slice(0, 8)}-export.json`, JSON.stringify(snapshot, null, 2), "application/json");
      setNotice("Workspace export downloaded.");
    } catch {
      setNotice("Could not export this workspace. Please try again.");
    } finally {
      setExportingWorkspace(false);
    }
  }

  async function createCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !workspaceId) return;
    const form = new FormData(event.currentTarget);
    const layout = formString(form, "layout", "table") as "table" | "list" | "board" | "calendar";
    const columns = ["title", ...form.getAll("columns").map(String)];
    try {
      const collection = await apiRequest<SavedCollection>(collectionBeingEdited
        ? `/api/collections/${collectionBeingEdited.id}?workspaceId=${encodeURIComponent(workspaceId)}`
        : `/api/workspaces/${encodeURIComponent(workspaceId)}/collections`, {
        method: collectionBeingEdited ? "PATCH" : "POST",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({
          name: form.get("name"),
          query: {
            types: form.getAll("types"),
            titleContains: form.get("titleContains"),
            sortBy: form.get("sortBy"),
            sortDirection: form.get("sortDirection"),
            groupBy: layout === "board" ? "type" : null,
          },
          view: { layout, columns: [...new Set(columns)] },
        }),
      });
      setSavedCollections((current) => (collectionBeingEdited
        ? current.map((item) => item.id === collection.id ? collection : item)
        : [...current, collection]).sort((left, right) => left.name.localeCompare(right.name)));
      if (openedCollection?.id === collection.id) setOpenedCollection(collection);
      setCollectionDialogOpen(false);
      setCollectionBeingEdited(null);
      setNotice("");
    } catch {
      setNotice("Could not create this collection. Check its name and filters, then try again.");
    }
  }

  async function deleteCollection(collection: SavedCollection) {
    if (!session || !workspaceId || !window.confirm(`Delete the collection “${collection.name}”? Its nodes will remain in the workspace.`)) return;
    try {
      await apiRequest<void>(`/api/collections/${collection.id}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "DELETE",
        headers: { "x-csrf-token": session.csrfToken },
      });
      setSavedCollections((current) => current.filter((item) => item.id !== collection.id));
      if (openedCollection?.id === collection.id) setOpenedCollection(null);
      setNotice("");
    } catch {
      setNotice(`Could not delete “${collection.name}”. Try again.`);
    }
  }

  async function createNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !workspaceId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const node = await apiRequest<WorkspaceNode>("/api/nodes", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ workspaceId, type: form.get("type"), title: form.get("title") }),
      });
      setNodes((current) => [node, ...current]);
      if (node.type === "task") setTaskStatuses((current) => ({ ...current, [node.id]: null }));
      formElement.reset();
      setNotice("");
    } catch {
      setNotice("Could not add that item. Please try again.");
    }
  }

  async function setTaskStatus(node: WorkspaceNode, value: string | null) {
    if (!session || !taskStatusDefinition || savingTaskStatusNodeId === node.id) return;
    const previousValue = taskStatuses[node.id] ?? null;
    if (previousValue === value) return;
    setTaskStatuses((current) => ({ ...current, [node.id]: value }));
    setSavingTaskStatusNodeId(node.id);
    try {
      const path = `/api/nodes/${node.id}/properties/${taskStatusDefinition.id}?workspaceId=${encodeURIComponent(workspaceId)}`;
      if (value === null) {
        await apiRequest<void>(path, { method: "DELETE", headers: { "x-csrf-token": session.csrfToken } });
      } else {
        await apiRequest<NodeProperty>(path, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
          body: JSON.stringify({ value: { type: taskStatusDefinition.type, value } }),
        });
      }
      setNotice("");
    } catch {
      setTaskStatuses((current) => ({ ...current, [node.id]: previousValue }));
      setNotice(`Could not update the status for ${node.title}.`);
    } finally {
      setSavingTaskStatusNodeId("");
    }
  }

  async function changeNode(node: WorkspaceNode, action: "archive" | "restore") {
    if (!session) return;
    const method = action === "archive" ? "DELETE" : "POST";
    try {
      const changed = await apiRequest<WorkspaceNode>(`/api/nodes/${node.id}${action === "restore" ? "/restore" : ""}?workspaceId=${workspaceId}`, {
        method,
        headers: { "x-csrf-token": session.csrfToken },
      });
      setNodes((current) => current.some((item) => item.id === changed.id)
        ? current.map((item) => item.id === changed.id ? changed : item)
        : [changed, ...current].slice(0, 100));
      if (action === "archive") setSearchResult((current) => current && ({ ...current, items: current.items.filter(({ node: resultNode }) => resultNode.id !== changed.id) }));
      setNotice("");
    } catch {
      setNotice(`Could not ${action} that item. Please try again.`);
    }
  }

  function openPage(node: WorkspaceNode) {
    setNotice("");
    setOpenedPage(node);
  }

  function openNodeFromCollection(node: WorkspaceNode) {
    switch (node.type) {
      case "page": openPage(node); break;
      case "task": setOpenedTask(node); break;
      default: setNotice(`Open ${node.type} items from the workspace list.`);
    }
  }

  function openNodeFromGraph(node: WorkspaceNode) {
    switch (node.type) {
      case "page": openPage(node); break;
      case "task": setOpenedTask(node); break;
      case "canvas": setOpenedCanvas(node); break;
      default: setNotice(`Open ${node.type} items from the workspace list.`);
    }
  }

  async function logout() {
    if (!session) return;
    await apiRequest<void>("/api/auth/logout", { method: "POST", headers: { "x-csrf-token": session.csrfToken } });
    setSession(null);
    setWorkspaces([]);
    setNodes([]);
    setOpenedPage(null);
    setOpenedTask(null);
    setWorkspaceDialogOpen(false);
  }

  if (setupRequired === null) return <main className="loading" aria-live="polite">Opening your workspace…</main>;
  if (!session) return <AuthScreen setupRequired={setupRequired} busy={busy} notice={notice} onSubmit={authenticate} />;

  const activeWorkspace = workspaces.find((item) => item.id === workspaceId);
  const canWrite = activeWorkspace?.role !== "viewer";
  const activeNodes = nodes.filter((node) => !node.archivedAt);
  const archivedNodes = nodes.filter((node) => node.archivedAt);
  const visibleNodes = activeView === "all" || activeView === "calendar" ? activeNodes : activeNodes.filter((node) => node.type === activeView);
  const visibleArchivedNodes = activeView === "all" || activeView === "calendar" ? archivedNodes : archivedNodes.filter((node) => node.type === activeView);
  const viewTitles: Record<NodeView, string> = {
    all: "Everything in one place",
    task: "Tasks",
    page: "Pages",
    calendar: "Calendar",
    canvas: "Canvas",
    graph: "Graph",
  };
  const viewTitle = viewTitles[activeView];

  return (
    <div className="app-frame">
      <aside className="sidebar" aria-label="Workspace navigation">
          <a className="brand" href="/" aria-label="Commonplace home"><span className="brand-mark">c</span><span>commonplace</span></a>
        <label className="workspace-label" htmlFor="workspace-select">Workspace</label>
        <select id="workspace-select" value={workspaceId} onChange={(event) => selectWorkspace(event.target.value)} aria-label="Choose workspace">
          <option value="" disabled>Select a workspace</option>
          {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
        <AppButton className="workspace-create-button" label="＋ New workspace" variant="ghost" size="sm" onClick={() => setWorkspaceDialogOpen(true)} />
        <nav className="main-nav" aria-label="Main">
          <a className={`nav-item${activeView === "all" ? " active" : ""}`} href="#items" aria-label="All items" title="All items" aria-current={activeView === "all" ? "page" : undefined} onClick={() => setActiveView("all")}><span aria-hidden="true">▦</span> All items</a>
          <a className={`nav-item${activeView === "task" ? " active" : ""}`} href="#tasks" aria-label="Tasks" title="Tasks" aria-current={activeView === "task" ? "page" : undefined} onClick={() => setActiveView("task")}><span aria-hidden="true">◷</span> Tasks</a>
          <a className={`nav-item${activeView === "page" ? " active" : ""}`} href="#pages" aria-label="Pages" title="Pages" aria-current={activeView === "page" ? "page" : undefined} onClick={() => setActiveView("page")}><span aria-hidden="true">▤</span> Pages</a>
          <a className={`nav-item${activeView === "calendar" ? " active" : ""}`} href="#calendar" aria-label="Calendar" title="Calendar" aria-current={activeView === "calendar" ? "page" : undefined} onClick={() => setActiveView("calendar")}><span aria-hidden="true">▦</span> Calendar</a>
          <a className={`nav-item${activeView === "canvas" ? " active" : ""}`} href="#canvas" aria-label="Canvas" title="Canvas" aria-current={activeView === "canvas" ? "page" : undefined} onClick={() => setActiveView("canvas")}><span aria-hidden="true">◇</span> Canvas</a>
          <a className={`nav-item${activeView === "graph" ? " active" : ""}`} href="#graph" aria-label="Graph" title="Graph" aria-current={activeView === "graph" ? "page" : undefined} onClick={() => setActiveView("graph")}><span aria-hidden="true">⌘</span> Graph</a>
        </nav>
        <div className="sidebar-bottom">
          <div className="user-card"><span className="avatar">{session.user.email.slice(0, 1).toUpperCase()}</span><span className="user-email">{session.user.email}</span></div>
          <AppButton label="Sign out" variant="ghost" onClick={() => void logout()} />
        </div>
      </aside>
      <main className="main-panel" id="items">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span aria-hidden="true">/</span><strong>{activeWorkspace?.name ?? "Getting started"}</strong></div>
          <label className="visually-hidden" htmlFor="mobile-workspace-select">Choose workspace</label>
          <select className="mobile-workspace-select" id="mobile-workspace-select" value={workspaceId} onChange={(event) => selectWorkspace(event.target.value)} aria-label="Choose workspace">
            <option value="" disabled>Select a workspace</option>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <AppButton className="mobile-new-workspace" label="＋ New" variant="ghost" size="sm" onClick={() => setWorkspaceDialogOpen(true)} />
          <AppButton className="mobile-signout" label="Sign out" variant="ghost" onClick={() => void logout()} />
        </header>
        <div className="content">
          {(() => {
            if (openedCanvas) {
              return (
            <Suspense fallback={<p className="loading">Loading canvas…</p>}><CanvasView key={openedCanvas.id} canvasId={openedCanvas.id} workspaceId={workspaceId} csrfToken={session.csrfToken} editable={canWrite} nodes={activeNodes} onClose={() => setOpenedCanvas(null)} onOpenNode={(node) => { const item = activeNodes.find(({ id }) => id === node.id); if (item?.type === "page") openPage(item); else if (item?.type === "task") setOpenedTask(item); }} onCreateNode={async (type, title) => { const node = await apiRequest<WorkspaceNode>("/api/nodes", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken }, body: JSON.stringify({ workspaceId, type, title }) }); setNodes((current) => [node, ...current]); return node; }} /></Suspense>
              );
            }
            if (openedTask) {
              return (
            <TaskDetail
              key={openedTask.id}
              node={openedTask}
              workspaceId={workspaceId}
              timeZone={activeWorkspace?.timeZone ?? "UTC"}
              csrfToken={session.csrfToken}
              editable={canWrite}
              nodes={activeNodes}
              onOpenNode={openNodeFromCollection}
              onClose={() => setOpenedTask(null)}
            />
              );
            }
            if (openedPage) {
              return (
            <PageDetail
              key={openedPage.id}
              node={openedPage}
              workspaceId={workspaceId}
              timeZone={activeWorkspace?.timeZone ?? "UTC"}
              csrfToken={session.csrfToken}
              editable={activeWorkspace?.role !== "viewer"}
              nodes={activeNodes}
              savedCollections={savedCollections}
              onOpenNode={openNodeFromCollection}
              onClose={() => setOpenedPage(null)}
            />
              );
            }
            if (openedCollection) {
              return (
            <CollectionDetail
              key={openedCollection.id}
              collection={openedCollection}
              workspaceId={workspaceId}
              timeZone={activeWorkspace?.timeZone ?? "UTC"}
              csrfToken={session.csrfToken}
              editable={canWrite}
              onOpenNode={openNodeFromCollection}
              onClose={() => setOpenedCollection(null)}
            />
              );
            }
            return <>
          <div className="page-heading">
            <div><div className="eyebrow">YOUR SPACE</div><h1>{activeWorkspace?.name ?? "Welcome to Commonplace"}</h1><p className="subtitle">A clear place for the work that matters.</p></div>
            {activeWorkspace && <div className="workspace-heading-actions"><span className="role-pill">{activeWorkspace.role}</span><AppButton label="Export workspace JSON" variant="ghost" size="sm" isLoading={exportingWorkspace} onClick={() => void exportWorkspace()} />{canWrite && <AppButton label="Workspace settings" variant="ghost" size="sm" onClick={() => { setWorkspaceTimeZoneDraft(activeWorkspace.timeZone); setWorkspaceSettingsOpen(true); setNotice(""); }} />}</div>}
          </div>
          {!activeWorkspace ? (
            <section className="empty-workspace"><div className="empty-art" aria-hidden="true"><span>✳</span><i>✧</i><b>◌</b></div><h2>Make this space yours</h2><p>Create a workspace to bring your notes, plans, and projects together.</p><form className="inline-form" onSubmit={(event) => void createWorkspace(event)}><label className="visually-hidden" htmlFor="workspace-name">Workspace name</label><input id="workspace-name" name="name" placeholder="e.g. Personal" required maxLength={120} /><AppButton label="Create workspace" variant="primary" type="submit" /></form></section>
          ) : (
            <>
              <section className="welcome-banner"><div><div className="eyebrow">A LITTLE ROOM TO THINK</div><h2>Good work starts with a clear space.</h2><p>Keep the moving pieces connected, and let every idea find its place.</p></div><div className="banner-illustration" aria-hidden="true"><div className="sun" /><div className="hill hill-back" /><div className="hill hill-front" /><div className="banner-card">✳</div></div></section>
          {activeView === "calendar" && <CalendarView workspaceId={workspaceId} timeZone={activeWorkspace.timeZone} csrfToken={session.csrfToken} editable={canWrite} onOpenNode={openNodeFromCollection} />}
          {activeView === "graph" && <GraphView workspaceId={workspaceId} nodes={activeNodes} onOpenNode={openNodeFromGraph} />}
          {activeView !== "calendar" && activeView !== "graph" && <>
              {notice && <output className="notice">{notice}</output>}
              {!canWrite && <p className="viewer-note">You have read-only access to this workspace.</p>}
              <section className="saved-collection-section" aria-labelledby="saved-collections-heading">
                <div className="section-heading"><div><div className="eyebrow">REUSABLE NODE VIEWS</div><h2 id="saved-collections-heading">Collections</h2></div>{canWrite && <AppButton label="＋ New collection" variant="ghost" size="sm" onClick={() => { setCollectionBeingEdited(null); setNotice(""); setCollectionDialogOpen(true); }} />}</div>
                {savedCollections.length > 0 ? <div className="saved-collection-list">{savedCollections.map((collection) => <div className="saved-collection-entry" key={collection.id}><button className="saved-collection-link" type="button" aria-label={`Open collection: ${collection.name}`} onClick={() => setOpenedCollection(collection)}><span aria-hidden="true">{collectionLayoutIcon(collection.view.layout)}</span>{collection.name}</button>{canWrite && <><AppButton label={`Edit collection: ${collection.name}`} variant="ghost" size="sm" onClick={() => { setCollectionBeingEdited(collection); setNotice(""); setCollectionDialogOpen(true); }} /><AppButton label={`Delete collection: ${collection.name}`} variant="ghost" size="sm" onClick={() => void deleteCollection(collection)} /></>}</div>)}</div> : <p className="quiet-empty">Save a node filter as a reusable table, list, board, or calendar.</p>}
              </section>
              <section className="workspace-search" aria-label="Search workspace">
                <label htmlFor="workspace-search-input">Search items and page content</label>
                <div><input id="workspace-search-input" type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search your workspace…" maxLength={200} /><select aria-label="Search item type" value={searchType} onChange={(event) => setSearchType(event.target.value)}><option value="">All types</option><option value="task">Tasks</option><option value="page">Pages</option><option value="project">Projects</option><option value="event">Events</option>{[...new Set(nodes.map(({ type }) => type))].filter((type) => !["task", "page", "project", "event"].includes(type)).map((type) => <option value={type} key={type}>{type}</option>)}</select></div>
              </section>
              {searchQuery.trim().length >= 2 ? <section className="search-results" aria-label="Search results" aria-live="polite">
                <div className="section-heading"><div><div className="eyebrow">WORKSPACE SEARCH</div><h2>Results for “{searchQuery.trim()}”</h2></div><span className="count-label">{searching ? "Searching…" : `${searchResult?.items.length ?? 0} results`}</span></div>
                {searchError && <p className="notice" role="alert">{searchError}</p>}
                {searchResult?.items.length ? <section className="item-list">{searchResult.items.map(({ node, matchedIn }) => <article className="item-row search-result-row" key={node.id}><span className={`type-icon type-${node.type}`} aria-hidden="true">{nodeTypeIcon(node.type)}</span><span className="item-title">{node.title}</span><span className="item-type">{node.type} · matched {matchedIn}</span>{node.type === "page" && <AppButton label="Open page" variant="ghost" size="sm" onClick={() => openPage(node)} />}{node.type === "task" && <AppButton label="Open task" variant="ghost" size="sm" onClick={() => setOpenedTask(node)} />}{canWrite && <AppButton label={`Archive ${node.title}`} variant="ghost" size="sm" onClick={() => void changeNode(node, "archive")} />}</article>)}</section> : !searching && <div className="quiet-empty"><span aria-hidden="true">⌕</span><p>No matching items. Try another phrase or item type.</p></div>}
                {searchResult?.hasMore && <div className="search-more"><AppButton label="Load more results" variant="ghost" onClick={() => void loadMoreSearchResults()} isLoading={searching} /></div>}
              </section> : <>
              <section className="section-heading"><div><div className="eyebrow">YOUR WORKSPACE</div><h2>{viewTitle}</h2></div><span className="count-label">{visibleNodes.length} {visibleNodes.length === 1 ? "item" : "items"}</span></section>
              {canWrite && <section className="create-card" aria-labelledby="add-item-title"><div className="create-icon" aria-hidden="true">＋</div><div className="create-copy"><h3 id="add-item-title">Start with an item</h3><p>Add a task or page. You can organize and connect it later.</p></div><form className="create-form" onSubmit={(event) => void createNode(event)}><select name="type" aria-label="Item type"><option value="task">Task</option><option value="page">Page</option><option value="canvas">Canvas</option><option value="project">Project</option><option value="event">Event</option></select><label className="visually-hidden" htmlFor="item-title">Item title</label><input id="item-title" name="title" placeholder="Give it a name…" required maxLength={500} /><AppButton label="Add item" variant="primary" type="submit" /></form></section>}
              {visibleNodes.length > 0 ? <section className="item-list" aria-label="Workspace items">{visibleNodes.map((node) => {
                const statusValue = taskStatuses[node.id] ?? null;
                const canComplete = taskStatusDefinition?.options.includes("Done") ?? false;
                return <article className="item-row" key={node.id}>
                  <span className={`type-icon type-${node.type}`} aria-hidden="true">{nodeTypeIcon(node.type)}</span>
                  <span className="item-title">{node.title}</span>
                  <span className="item-type">{node.type}</span>
                  {node.type === "task" && taskStatusDefinition && taskStatusDefinition.options.length > 0 && <div className="task-quick-status">
                    {canComplete && <input className="task-complete-checkbox" type="checkbox" aria-label={`Complete ${node.title}`} checked={statusValue === "Done"} disabled={!canWrite || savingTaskStatusNodeId === node.id} onChange={(event) => {
                      const nextValue = event.target.checked ? "Done" : taskStatusDefinition.options.find((option) => option !== "Done") ?? null;
                      void setTaskStatus(node, nextValue);
                    }} />}
                    <select aria-label={`Status for ${node.title}`} value={statusValue ?? ""} disabled={!canWrite || savingTaskStatusNodeId === node.id} onChange={(event) => void setTaskStatus(node, event.target.value || null)}>
                      <option value="">Not set</option>{taskStatusDefinition.options.map((option) => <option value={option} key={option}>{option}</option>)}
                    </select>
                  </div>}
                  {node.type === "page" && <AppButton label="Open page" variant="ghost" size="sm" onClick={() => openPage(node)} />}
                  {node.type === "canvas" && <AppButton label="Open canvas" variant="ghost" size="sm" onClick={() => setOpenedCanvas(node)} />}
                  {node.type === "task" && <AppButton label="Open task" variant="ghost" size="sm" onClick={() => { setNotice(""); setOpenedTask(node); }} />}
                  {canWrite && <AppButton label="Archive" variant="ghost" size="sm" onClick={() => void changeNode(node, "archive")} />}
                </article>;
              })}</section> : <div className="quiet-empty"><span aria-hidden="true">✧</span><p>{emptyNodeMessage(activeView)}</p></div>}
              {visibleArchivedNodes.length > 0 && <details className="archive-section"><summary>Archived items <span>{visibleArchivedNodes.length}</span></summary>{visibleArchivedNodes.map((node) => <article className="item-row archived" key={node.id}><span className="item-title">{node.title}</span>{canWrite && <AppButton label="Restore" variant="ghost" size="sm" onClick={() => void changeNode(node, "restore")} />}</article>)}</details>}
              </>}
              </>}
            </>
          )}
          </>; })()}
        </div>
      </main>
      {workspaceDialogOpen && <ModalDialog titleId="workspace-dialog-title" className="workspace-dialog" onClose={() => setWorkspaceDialogOpen(false)}>
          <div className="eyebrow">YOUR SPACE</div><h2 id="workspace-dialog-title">Create a workspace</h2>
          <form onSubmit={(event) => void createWorkspace(event)}>
            <label htmlFor="new-workspace-name">Workspace name</label>
            <input id="new-workspace-name" name="name" placeholder="e.g. Personal" required maxLength={120} />
            <label htmlFor="new-workspace-time-zone">Time zone</label>
            <input id="new-workspace-time-zone" name="timeZone" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"} required maxLength={100} />
            {notice && <p className="notice" role="alert">{notice}</p>}
            <div className="workspace-dialog-actions"><AppButton label="Cancel" variant="ghost" type="button" onClick={() => setWorkspaceDialogOpen(false)} /><AppButton label="Create workspace" variant="primary" type="submit" /></div>
          </form>
      </ModalDialog>}
      {workspaceSettingsOpen && activeWorkspace && <ModalDialog titleId="workspace-settings-title" className="workspace-dialog" onClose={() => setWorkspaceSettingsOpen(false)}>
          <div className="eyebrow">WORKSPACE SETTINGS</div><h2 id="workspace-settings-title">Time zone</h2>
          <form onSubmit={(event) => void saveWorkspaceSettings(event)}>
            <label htmlFor="workspace-time-zone">IANA time zone</label>
            <input id="workspace-time-zone" value={workspaceTimeZoneDraft} onChange={(event) => setWorkspaceTimeZoneDraft(event.target.value)} required maxLength={100} placeholder="Europe/London" />
            <p className="quiet-empty">Calendar dates and times display in this zone. Saved dates and instants will not change.</p>
            {notice && <p className="notice" role="alert">{notice}</p>}
            <div className="workspace-dialog-actions"><AppButton label="Cancel" variant="ghost" type="button" onClick={() => setWorkspaceSettingsOpen(false)} /><AppButton label="Save time zone" variant="primary" type="submit" isLoading={savingWorkspaceSettings} /></div>
          </form>
      </ModalDialog>}
      {collectionDialogOpen && <ModalDialog titleId="collection-dialog-title" className="workspace-dialog collection-dialog" onClose={() => setCollectionDialogOpen(false)}>
          <div className="eyebrow">SAVED NODE VIEW</div><h2 id="collection-dialog-title">{collectionBeingEdited ? "Edit collection" : "Create a collection"}</h2>
          <form onSubmit={(event) => void createCollection(event)}>
            <label htmlFor="collection-name">Name</label><input id="collection-name" name="name" required maxLength={120} placeholder="e.g. Active projects" defaultValue={collectionBeingEdited?.name ?? ""} />
            <fieldset className="collection-type-filter"><legend>Filter by item type</legend><div className="collection-filter-types">{[...new Set([...nodes.map(({ type }) => type), ...(collectionBeingEdited?.query.types ?? [])])].map((type) => <label key={type}><input type="checkbox" name="types" value={type} defaultChecked={collectionBeingEdited?.query.types.includes(type) ?? false} />{type}</label>)}</div></fieldset>
            <label htmlFor="collection-title-filter">Title contains</label><input id="collection-title-filter" name="titleContains" maxLength={120} placeholder="Optional words in the title" defaultValue={collectionBeingEdited?.query.titleContains ?? ""} />
            <fieldset className="collection-columns"><legend>Columns</legend><p>Title is always included.</p><div className="collection-filter-types">
              <label><input type="checkbox" name="columns" value="type" defaultChecked={!collectionBeingEdited || collectionBeingEdited.view.columns.includes("type")} />Type</label>
              <label><input type="checkbox" name="columns" value="updatedAt" defaultChecked={!collectionBeingEdited || collectionBeingEdited.view.columns.includes("updatedAt")} />Updated</label>
              <label><input type="checkbox" name="columns" value="createdAt" defaultChecked={collectionBeingEdited?.view.columns.includes("createdAt") ?? false} />Created</label>
              {collectionPropertyDefinitions.map((definition) => <label key={definition.id}><input type="checkbox" name="columns" value={definition.id} defaultChecked={collectionBeingEdited?.view.columns.includes(definition.id) ?? false} />{definition.name}</label>)}
            </div></fieldset>
            <label htmlFor="collection-sort-by">Sort by</label><select id="collection-sort-by" name="sortBy" defaultValue={collectionBeingEdited?.query.sortBy ?? "updatedAt"}><option value="updatedAt">Last updated</option><option value="createdAt">Date created</option><option value="title">Title</option></select>
            <label htmlFor="collection-sort-direction">Direction</label><select id="collection-sort-direction" name="sortDirection" defaultValue={collectionBeingEdited?.query.sortDirection ?? "desc"}><option value="desc">Descending</option><option value="asc">Ascending</option></select>
            <label htmlFor="collection-layout">View</label><select id="collection-layout" name="layout" defaultValue={collectionBeingEdited?.view.layout ?? "table"}><option value="table">Table</option><option value="list">List</option><option value="board">Board, grouped by type</option><option value="calendar">Calendar</option></select>
            {notice && <p className="notice" role="alert">{notice}</p>}
            <div className="workspace-dialog-actions"><AppButton label="Cancel" variant="ghost" type="button" onClick={() => { setCollectionDialogOpen(false); setCollectionBeingEdited(null); }} /><AppButton label={collectionBeingEdited ? "Save changes" : "Create collection"} variant="primary" type="submit" /></div>
          </form>
      </ModalDialog>}
    </div>
  );
}

function PageDetail({
  node,
  workspaceId,
  timeZone,
  csrfToken,
  editable,
  nodes,
  savedCollections,
  onOpenNode,
  onClose,
}: {
  readonly node: WorkspaceNode;
  readonly workspaceId: string;
  readonly timeZone: string;
  readonly csrfToken: string;
  readonly editable: boolean;
  readonly nodes: readonly WorkspaceNode[];
  readonly savedCollections: readonly SavedCollection[];
  readonly onOpenNode: (node: WorkspaceNode) => void;
  readonly onClose: () => void;
}) {
  const [document, setDocument] = useState<PageDocument | null>(null);
  const [recoverableDraft, setRecoverableDraft] = useState<LocalPageDraft | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "unsaved" | "saving" | "error">("saved");
  const [saveError, setSaveError] = useState("");
  const current = useRef(true);
  const revision = useRef(0);
  const pendingContent = useRef<readonly JsonValue[] | null>(null);
  const saveTimer = useRef<number | null>(null);
  const saveInProgress = useRef(false);
  const saveFailed = useRef(false);
  const draftKey = `commonplace:page-draft:${workspaceId}:${node.id}`;

  useEffect(() => {
    current.current = true;
    const controller = new AbortController();
    const localDraft = readLocalPageDraft(draftKey);
    void apiRequest<PageDocument>(`/api/nodes/${node.id}/document?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal })
      .then((result) => {
        if (!current.current) return;
        revision.current = result.revision;
        setDocument(result);
        if (!localDraft) return;
        if (editable && localDraft.baseRevision === result.revision) {
          revision.current = result.revision;
          pendingContent.current = localDraft.content;
          setDocument({ ...result, content: localDraft.content });
          setSaveState("unsaved");
          setSaveError("Restored an unsaved local draft. Saving it to this page now.");
          saveTimer.current = window.setTimeout(() => void flushSave(), 700);
        } else {
          setRecoverableDraft(localDraft);
          setSaveError(localDraft.baseRevision === result.revision
            ? "This local draft is preserved in your browser because you cannot edit this page."
            : "A local draft from another page revision is preserved for review.");
        }
      })
      .catch(() => {
        if (!current.current || controller.signal.aborted) return;
        if (localDraft) {
          revision.current = localDraft.baseRevision;
          pendingContent.current = localDraft.content;
          saveFailed.current = true;
          setDocument({ workspaceId, nodeId: node.id, content: localDraft.content, revision: localDraft.baseRevision, updatedAt: null, updatedBy: null });
          setSaveState("error");
          setSaveError("The server is unavailable. This local draft is open and will retry when the connection returns.");
        } else {
          setSaveError("Could not open this page. Please try again.");
        }
      });
    const retryWhenOnline = () => {
      if (pendingContent.current && !saveInProgress.current) {
        saveFailed.current = false;
        void flushSave();
      }
    };
    window.addEventListener("online", retryWhenOnline);
    return () => {
      current.current = false;
      controller.abort();
      window.removeEventListener("online", retryWhenOnline);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [node.id, workspaceId, draftKey, editable]);

  async function flushSave(): Promise<boolean> {
    if (saveInProgress.current) return false;
    const content = pendingContent.current;
    if (!content) return true;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    saveInProgress.current = true;
    pendingContent.current = null;
    saveFailed.current = false;
    setSaveState("saving");
    setSaveError("");
    try {
      const saved = await apiRequest<PageDocument>(`/api/nodes/${node.id}/document?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ expectedRevision: revision.current, content }),
      });
      revision.current = saved.revision;
      if (current.current) setDocument(saved);
      const hasMore = pendingContent.current !== null;
      if (hasMore && pendingContent.current) {
        writeLocalPageDraft(draftKey, { baseRevision: saved.revision, content: pendingContent.current, savedAt: new Date().toISOString() });
      } else {
        removeLocalPageDraftIfMatching(draftKey, content);
      }
      setSaveState(hasMore ? "unsaved" : "saved");
      return true;
    } catch (error) {
      if (pendingContent.current === null) pendingContent.current = content;
      writeLocalPageDraft(draftKey, { baseRevision: revision.current, content: pendingContent.current, savedAt: new Date().toISOString() });
      saveFailed.current = true;
      setSaveState("error");
      setSaveError(error instanceof ApiError && error.status === 409
        ? "This page changed in another session. Your draft is still here, but needs a manual review before saving."
        : "Could not save this page. Your unsaved changes are still here.");
      return false;
    } finally {
      saveInProgress.current = false;
      if (current.current && pendingContent.current && !saveFailed.current) {
        saveTimer.current = window.setTimeout(() => void flushSave(), 250);
      }
    }
  }

  function queueSave(content: readonly JsonValue[]) {
    pendingContent.current = content;
    saveFailed.current = false;
    writeLocalPageDraft(draftKey, { baseRevision: revision.current, content, savedAt: new Date().toISOString() });
    setSaveState("unsaved");
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flushSave(), 700);
  }

  async function downloadRecoveryDraft() {
    if (!recoverableDraft) return;
    await getPlatform().saveFile(
      `${safeFilenameStem(node.title).slice(0, 80) || "page"}-local-draft.json`,
      JSON.stringify(recoverableDraft, null, 2),
      "application/json",
    );
  }

  function discardRecoveryDraft() {
    try { localStorage.removeItem(draftKey); } catch { /* The draft remains safely stored if clearing is unavailable. */ }
    setRecoverableDraft(null);
    setSaveError("");
  }

  async function closePage() {
    if (pendingContent.current && !await flushSave()) return;
    onClose();
  }

  return (
    <section className="page-detail" aria-label={`Page: ${node.title}`}>
      <div className="page-detail-toolbar">
        <AppButton label="Back to items" variant="ghost" onClick={() => void closePage()} />
        <output className={`document-save-state state-${saveState}`}>
          {pageSaveStateText(saveState)}
        </output>
        {saveState === "error" && pendingContent.current && editable && <AppButton label="Retry save" variant="ghost" size="sm" onClick={() => { saveFailed.current = false; void flushSave(); }} />}
      </div>
      {saveError && <p className="notice" role="alert">{saveError}</p>}
      {recoverableDraft && <section className="draft-recovery" aria-label="Preserved local draft"><div><strong>Local draft preserved</strong><p>Saved {new Date(recoverableDraft.savedAt).toLocaleString()} from revision {recoverableDraft.baseRevision}. The server copy has changed, so this draft was not applied.</p></div><div className="draft-recovery-actions"><AppButton label="Download draft" variant="ghost" size="sm" onClick={downloadRecoveryDraft} /><AppButton label="Discard draft" variant="ghost" size="sm" onClick={discardRecoveryDraft} /></div></section>}
      <h1 className="document-title">{node.title}</h1>
      {document ? <Suspense fallback={<output className="loading document-loading">Loading editor…</output>}><PageEditor
        initialContent={document.content}
        editable={editable}
        calendarCollections={savedCollections.filter((collection) => collection.view.layout === "calendar").map(({ id, name }) => ({ id, name }))}
        renderCalendar={(collectionId) => <CalendarView workspaceId={workspaceId} timeZone={timeZone} csrfToken={csrfToken} editable={editable} collectionId={collectionId} onOpenNode={onOpenNode} />}
        onChange={queueSave}
        onExportMarkdown={(markdown) => {
          const filename = trimFilenameSeparators(safeFilenameStem(node.title)).slice(0, 80) || "page";
          void getPlatform().saveFile(`${filename}.md`, markdown, "text/markdown; charset=utf-8");
        }}
      /></Suspense> : <output className="loading document-loading">Opening your page…</output>}
      {!editable && <p className="viewer-note">You have read-only access to this page.</p>}
      <NodeRelationsPanel node={node} nodes={nodes} workspaceId={workspaceId} timeZone={timeZone} csrfToken={csrfToken} editable={editable} onOpen={onOpenNode} />
    </section>
  );
}

function TaskDetail({
  node,
  workspaceId,
  timeZone,
  csrfToken,
  editable,
  nodes,
  onOpenNode,
  onClose,
}: {
  readonly node: WorkspaceNode;
  readonly workspaceId: string;
  readonly timeZone: string;
  readonly csrfToken: string;
  readonly editable: boolean;
  readonly nodes: readonly WorkspaceNode[];
  readonly onOpenNode: (node: WorkspaceNode) => void;
  readonly onClose: () => void;
}) {
  const [definitions, setDefinitions] = useState<readonly PropertyDefinition[]>([]);
  const [properties, setProperties] = useState<readonly NodeProperty[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [propertyDialogOpen, setPropertyDialogOpen] = useState(false);
  const [newPropertyType, setNewPropertyType] = useState("text");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void Promise.all([
      apiRequest<readonly PropertyDefinition[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/properties`, { signal: controller.signal }),
      apiRequest<readonly NodeProperty[]>(`/api/nodes/${node.id}/properties?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal }),
    ]).then(([nextDefinitions, nextProperties]) => {
      setDefinitions(nextDefinitions);
      setProperties(nextProperties);
    }).catch(() => {
      if (!controller.signal.aborted) setError("Could not load task details. Please try again.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [node.id, workspaceId]);

  async function updateProperty(definition: PropertyDefinition, nextValue: PropertyValue | null) {
    if (!editable) return;
    if (nextValue?.type === "duration" && nextValue.value < 0) {
      setError("Duration must be zero or more.");
      return;
    }
    const existing = properties.some((property) => property.definitionId === definition.id);
    setSavingId(definition.id);
    setError("");
    setSaved("");
    try {
      if (nextValue === null && existing) {
        await apiRequest<void>(`/api/nodes/${node.id}/properties/${definition.id}?workspaceId=${encodeURIComponent(workspaceId)}`, {
          method: "DELETE", headers: { "x-csrf-token": csrfToken },
        });
        setProperties((current) => current.filter((property) => property.definitionId !== definition.id));
      } else if (nextValue !== null) {
        const property = await apiRequest<NodeProperty>(`/api/nodes/${node.id}/properties/${definition.id}?workspaceId=${encodeURIComponent(workspaceId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ value: nextValue }),
        });
        setProperties((current) => [...current.filter((item) => item.definitionId !== definition.id), property]);
      }
      setSaved(definition.name);
    } catch {
      setError(`Could not save ${definition.name.toLowerCase()}. Please try again.`);
    } finally {
      setSavingId("");
    }
  }

  function propertyValue(definition: PropertyDefinition): PropertyValue | undefined {
    return properties.find((property) => property.definitionId === definition.id)?.value;
  }

  async function createProperty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = formString(form, "name").trim();
    const needsOptions = ["select", "multiSelect", "status"].includes(newPropertyType);
    const options = formString(form, "options").split(",").map((item) => item.trim()).filter(Boolean);
    if (needsOptions && options.length === 0) {
      setError("Add at least one option for this property type.");
      return;
    }
    setError("");
    try {
      const definition = await apiRequest<PropertyDefinition>(`/api/workspaces/${encodeURIComponent(workspaceId)}/properties`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ name, type: newPropertyType, ...(needsOptions ? { options } : {}) }),
      });
      setDefinitions((current) => [...current, definition].sort((left, right) => left.name.localeCompare(right.name)));
      setPropertyDialogOpen(false);
      setNewPropertyType("text");
    } catch {
      setError("Could not create this property. Check that its name is unique and try again.");
    }
  }

  function renderPropertyEditor(definition: PropertyDefinition): ReactNode {
    const property = propertyValue(definition);
    const current = property?.value;
    const options = definition.options ?? [];
    const disabled = !editable || savingId !== "";
    switch (definition.type) {
      case "status":
      case "select": {
        const selectionType = definition.type;
        return options.length > 0
          ? <select aria-label={definition.name} value={typeof current === "string" ? current : ""} disabled={disabled} onChange={(event) => {
            const selected = event.target.value;
            let nextValue: PropertyValue | null = null;
            if (selected) {
              if (selectionType === "status") nextValue = { type: "status", value: selected };
              else nextValue = { type: "select", value: selected };
            }
            void updateProperty(definition, nextValue);
          }}><option value="">Not set</option>{options.map((option) => <option value={option} key={option}>{option}</option>)}</select>
          : <output className="unsupported-property">Add options to edit this field.</output>;
      }
      case "multiSelect":
        return options.length > 0
          ? <select aria-label={definition.name} multiple value={Array.isArray(current) ? current : []} disabled={disabled} onChange={(event) => void updateProperty(definition, { type: "multiSelect", value: [...event.currentTarget.selectedOptions].map((option) => option.value) })}>{options.map((option) => <option value={option} key={option}>{option}</option>)}</select>
          : <output className="unsupported-property">Add options to edit this field.</output>;
      case "boolean":
        return <select aria-label={definition.name} value={typeof current === "boolean" ? String(current) : ""} disabled={disabled} onChange={(event) => void updateProperty(definition, event.target.value === "" ? null : { type: "boolean", value: event.target.value === "true" })}><option value="">Not set</option><option value="true">Yes</option><option value="false">No</option></select>;
      case "date":
        return <input aria-label={definition.name} type="date" value={typeof current === "string" ? current : ""} disabled={disabled} onChange={(event) => void updateProperty(definition, event.target.value ? { type: "date", value: event.target.value } : null)} />;
      case "dateTime":
        return <input aria-label={definition.name} type="datetime-local" value={typeof current === "string" ? formatInstantInTimeZone(current, timeZone) : ""} disabled={disabled} onChange={(event) => {
          if (!event.target.value) { void updateProperty(definition, null); return; }
          const resolution = resolveLocalDateTime(event.target.value, timeZone);
          if (resolution.kind === "nonexistent") { setError("That local time does not exist because the clock moves forward. Choose another time."); return; }
          void updateProperty(definition, { type: "dateTime", value: resolution.instant });
        }} />;
      case "number":
      case "duration":
        return <input key={`${definition.id}-${typeof current === "number" ? current : ""}`} aria-label={definition.name} type="number" min={definition.type === "duration" ? 0 : undefined} step="any" defaultValue={typeof current === "number" ? String(current) : ""} disabled={!editable} placeholder={definition.type === "duration" ? "Minutes" : "Number"} onBlur={(event) => { const value = event.target.value; if (value === "") void updateProperty(definition, null); else if (Number.isFinite(Number(value))) void updateProperty(definition, definition.type === "duration" ? { type: "duration", value: Number(value) } : { type: "number", value: Number(value) }); }} />;
      case "text":
      case "email":
      case "url":
      case "phone": {
        const propertyType = definition.type as "text" | "email" | "url" | "phone";
        const inputType = { text: "text", email: "email", url: "url", phone: "tel" }[propertyType];
        const currentText = typeof current === "string" ? current : "";
        return <input key={`${definition.id}-${currentText}`} aria-label={definition.name} type={inputType} defaultValue={currentText} disabled={!editable} onBlur={(event) => {
          const value = event.target.value;
          if (value !== currentText) void updateProperty(definition, value ? stringPropertyValue(propertyType, value) : null);
        }} />;
      }
      default:
        return <output className="unsupported-property">{propertyDisplayValue(current)}</output>;
    }
  }

  let taskSaveStatus = "Task details";
  if (saved) taskSaveStatus = `${saved} saved`;
  if (savingId) taskSaveStatus = `Saving ${definitions.find((item) => item.id === savingId)?.name.toLowerCase()}…`;

  return <section className="task-detail" aria-label={`Task: ${node.title}`}>
    <div className="page-detail-toolbar"><AppButton label="Back to items" variant="ghost" onClick={onClose} /><output className="document-save-state">{taskSaveStatus}</output></div>
    <div className="task-heading"><div><div className="eyebrow">TASK</div><h1 className="document-title">{node.title}</h1></div>{editable && <AppButton label="＋ Add property" variant="ghost" size="sm" onClick={() => { setError(""); setPropertyDialogOpen(true); }} />}</div>
    {error && !propertyDialogOpen && <p className="notice" role="alert">{error}</p>}
    {loading ? <output className="loading document-loading">Loading task details…</output> : <div className="task-properties">{definitions.map((definition) => <label className="task-property" key={definition.id}><span>{definition.name}</span>{renderPropertyEditor(definition)}</label>)}{definitions.length === 0 && <p className="quiet-empty">No task properties are available in this workspace.</p>}</div>}
    {!editable && <p className="viewer-note">You have read-only access to this task.</p>}
    <NodeRelationsPanel node={node} nodes={nodes} workspaceId={workspaceId} timeZone={timeZone} csrfToken={csrfToken} editable={editable} onOpen={onOpenNode} />
    {propertyDialogOpen && <ModalDialog titleId="property-dialog-title" className="workspace-dialog" onClose={() => setPropertyDialogOpen(false)}><div className="eyebrow">WORKSPACE PROPERTY</div><h2 id="property-dialog-title">Add a property</h2><form onSubmit={(event) => void createProperty(event)}><label htmlFor="property-name">Name</label><input id="property-name" name="name" required maxLength={120} placeholder="e.g. Estimate" /><label htmlFor="property-type">Type</label><select id="property-type" value={newPropertyType} onChange={(event) => setNewPropertyType(event.target.value)}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Yes or no</option><option value="date">Date</option><option value="dateTime">Date and time</option><option value="select">Select</option><option value="multiSelect">Multiple select</option><option value="status">Status</option><option value="duration">Duration</option><option value="email">Email</option><option value="url">URL</option><option value="phone">Phone</option></select>{["select", "multiSelect", "status"].includes(newPropertyType) && <><label htmlFor="property-options">Options, separated by commas</label><input id="property-options" name="options" required placeholder="e.g. Small, Medium, Large" /></>}{error && <p className="notice" role="alert">{error}</p>}<div className="workspace-dialog-actions"><AppButton label="Cancel" variant="ghost" type="button" onClick={() => setPropertyDialogOpen(false)} /><AppButton label="Add property" variant="primary" type="submit" /></div></form></ModalDialog>}
  </section>;
}

function AuthScreen({ setupRequired, busy, notice, onSubmit }: { readonly setupRequired: boolean; readonly busy: boolean; readonly notice: string; readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <main className="auth-page"><section className="auth-card"><a className="brand auth-brand" href="/" aria-label="Commonplace home"><span className="brand-mark">c</span><span>commonplace</span></a><div className="auth-art" aria-hidden="true"><div className="auth-orbit orbit-one" /><div className="auth-orbit orbit-two" /><span className="auth-star">✳</span><span className="auth-spark">✧</span></div><div className="eyebrow">A SPACE FOR WHAT’S NEXT</div><h1>{setupRequired ? "Make yourself at home." : "Welcome back."}</h1><p className="auth-subtitle">{setupRequired ? "Set up your owner account and begin shaping your workspace." : "Sign in to pick up where your thoughts left off."}</p><form className="auth-form" onSubmit={onSubmit}>{setupRequired && <><label htmlFor="displayName">Your name</label><input id="displayName" name="displayName" autoComplete="name" placeholder="How should we address you?" required maxLength={120} /><label htmlFor="workspaceName">Workspace name</label><input id="workspaceName" name="workspaceName" placeholder="e.g. Personal" required maxLength={120} /></>}<label htmlFor="email">Email address</label><input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={320} /><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete={setupRequired ? "new-password" : "current-password"} placeholder={setupRequired ? "At least 12 characters" : "Your password"} required minLength={setupRequired ? 12 : 1} maxLength={256} />{notice && <p className="notice" role="alert">{notice}</p>}<AppButton label={setupRequired ? "Create owner account" : "Sign in"} variant="primary" type="submit" isLoading={busy} /></form><p className="auth-footnote">Your data stays on your server.</p></section><footer className="auth-footer">A thoughtful home for your connected work <span>✳</span></footer></main>;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing application root element");
createRoot(rootElement).render(<StrictMode><AppTheme><App /></AppTheme></StrictMode>);
