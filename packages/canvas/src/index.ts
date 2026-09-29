import type { CanvasNodeBinding, JsonValue, NodeId } from "@workspace/domain";

export interface CanvasScene {
  readonly [key: string]: JsonValue;
  readonly elements: readonly JsonValue[];
  readonly appState: Readonly<Record<string, JsonValue>>;
  readonly files: Readonly<Record<string, JsonValue>>;
}

export const EMPTY_CANVAS_SCENE: CanvasScene = {
  elements: [],
  appState: { viewBackgroundColor: "#ffffff", gridSize: null },
  files: {},
};

const MAX_SCENE_CHARACTERS = 8_000_000;
const MAX_SCENE_ELEMENTS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 48) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100_000 && value.every((item) => isJson(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJson(item, depth + 1));
}

export function validateCanvasScene(value: unknown): CanvasScene {
  if (!isRecord(value) || !Array.isArray(value.elements) || value.elements.length > MAX_SCENE_ELEMENTS ||
      !isRecord(value.appState) || !isRecord(value.files) || !isJson(value)) {
    throw new RangeError("Canvas scene must contain valid JSON elements, app state, and files.");
  }
  if (JSON.stringify(value).length > MAX_SCENE_CHARACTERS) {
    throw new RangeError("Canvas scene is too large to save (8 MB maximum).");
  }
  const ids = new Set<string>();
  for (const element of value.elements) {
    if (!isRecord(element) || typeof element.id !== "string" || element.id.length === 0 || element.id.length > 255 ||
        typeof element.type !== "string" || element.type.length > 40 || ids.has(element.id)) {
      throw new RangeError("Canvas elements must have unique IDs and valid element types.");
    }
    ids.add(element.id);
  }
  return value as unknown as CanvasScene;
}

export function validateCanvasBindings(value: unknown, scene: CanvasScene): readonly CanvasNodeBinding[] {
  if (!Array.isArray(value) || value.length > MAX_SCENE_ELEMENTS) {
    throw new RangeError("Canvas node bindings must be an array of at most 5,000 elements.");
  }
  const sceneIds = new Set(scene.elements.flatMap((element) => isRecord(element) && typeof element.id === "string" ? [element.id] : []));
  const bindingIds = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.elementId !== "string" || candidate.elementId.length === 0 ||
        candidate.elementId.length > 255 || typeof candidate.nodeId !== "string" || candidate.nodeId.length > 64 ||
        !sceneIds.has(candidate.elementId) || bindingIds.has(candidate.elementId)) {
      throw new RangeError("Each canvas binding must point to one existing element and node.");
    }
    bindingIds.add(candidate.elementId);
    return { elementId: candidate.elementId, nodeId: candidate.nodeId as NodeId };
  });
}

/** Refreshes node-card text from canonical node titles whenever a canvas opens. */
export function projectLiveNodeTitles(scene: CanvasScene, bindings: readonly CanvasNodeBinding[], titles: ReadonlyMap<string, string>): CanvasScene {
  const nodeByElement = new Map(bindings.map(({ elementId, nodeId }) => [elementId, nodeId]));
  let changed = false;
  const elements = scene.elements.map((element) => {
    if (!isRecord(element) || element.type !== "text" || typeof element.text !== "string") return element;
    const nodeId = nodeByElement.get(String(element.id));
    const title = nodeId ? titles.get(nodeId) : undefined;
    if (!title || title === element.text) return element;
    changed = true;
    return { ...element, text: title } as JsonValue;
  });
  return changed ? { ...scene, elements } : scene;
}

export function bindCanvasElement(scene: CanvasScene, elementId: string, nodeId: NodeId | null): CanvasScene {
  let found = false;
  const elements = scene.elements.map((element) => {
    if (!isRecord(element) || element.id !== elementId) return element;
    found = true;
    const customData = isRecord(element.customData) ? { ...element.customData } : {};
    if (nodeId) customData.workspaceNodeId = nodeId;
    else delete customData.workspaceNodeId;
    return { ...element, customData } as JsonValue;
  });
  if (!found) throw new RangeError("The selected canvas element no longer exists.");
  return { ...scene, elements };
}
