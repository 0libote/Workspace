import { describe, expect, test } from "bun:test";
import { bindCanvasElement, validateCanvasBindings, validateCanvasScene, projectLiveNodeTitles, EMPTY_CANVAS_SCENE } from "./index";
import type { NodeId } from "@workspace/domain";

const canvasId = "5530ab49-e215-41ea-8740-7eabed509875" as NodeId;

describe("portable canvas scenes", () => {
  test("validates Excalidraw JSON and node bindings against existing scene elements", () => {
    const scene = validateCanvasScene({
      elements: [
        { id: "rectangle-1", type: "rectangle", x: 10, y: 20, customData: { workspaceNodeId: canvasId } },
      ],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    });
    expect(validateCanvasBindings([{ elementId: "rectangle-1", nodeId: canvasId }], scene)).toEqual([
      { elementId: "rectangle-1", nodeId: canvasId },
    ]);
    expect(() => validateCanvasBindings([{ elementId: "missing", nodeId: canvasId }], scene)).toThrow("existing element");
    expect(() => validateCanvasScene({ ...EMPTY_CANVAS_SCENE, elements: [
      { id: "duplicate", type: "rectangle" }, { id: "duplicate", type: "ellipse" },
    ] })).toThrow("unique IDs");
    expect(() => validateCanvasScene({ elements: [], appState: {}, files: {}, unsupported: undefined })).toThrow("valid JSON");
  });

  test("refreshes linked element labels from the canonical node title", () => {
    const scene = validateCanvasScene({
      elements: [
        { id: "card-text", type: "text", text: "Old task title" },
        { id: "free-text", type: "text", text: "My note" },
      ],
      appState: {},
      files: {},
    });
    const refreshed = projectLiveNodeTitles(scene, [{ elementId: "card-text", nodeId: canvasId }], new Map([[canvasId, "Canonical task title"]]));
    expect(refreshed.elements[0]).toMatchObject({ text: "Canonical task title" });
    expect(refreshed.elements[1]).toMatchObject({ text: "My note" });
  });

  test("adds and removes a canonical node reference from an element", () => {
    const scene = validateCanvasScene({
      elements: [{ id: "shape", type: "rectangle", x: 12, customData: { color: "green" } }],
      appState: {},
      files: {},
    });
    const bound = bindCanvasElement(scene, "shape", canvasId);
    expect(bound.elements[0]).toMatchObject({ customData: { color: "green", workspaceNodeId: canvasId } });
    expect(bindCanvasElement(bound, "shape", null).elements[0]).toMatchObject({ customData: { color: "green" } });
  });
});
