import { useMemo, useRef, useState, type ReactNode } from "react";
import { BlockNoteSchema, defaultBlockSpecs, type PartialBlock } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/ariakit";
import { createReactBlockSpec, useCreateBlockNote } from "@blocknote/react";
import { validateNodeDocumentContent, type JsonValue } from "@workspace/domain";
import "./styles.css";

export interface PageCalendarCollection {
  readonly id: string;
  readonly name: string;
}

export interface PageEditorProps {
  readonly initialContent: readonly JsonValue[];
  readonly editable?: boolean;
  readonly calendarCollections: readonly PageCalendarCollection[];
  readonly renderCalendar: (collectionId: string) => ReactNode;
  readonly onChange: (content: readonly JsonValue[]) => void;
  readonly onExportMarkdown: (markdown: string) => void;
}

export function PageEditor({ initialContent, editable = true, calendarCollections, renderCalendar, onChange, onExportMarkdown }: PageEditorProps) {
  const editorBlocks = useMemo(() => initialContent as PartialBlock[], [initialContent]);
  const collectionsRef = useRef(calendarCollections);
  const renderCalendarRef = useRef(renderCalendar);
  collectionsRef.current = calendarCollections;
  renderCalendarRef.current = renderCalendar;
  const schema = useMemo(() => BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      calendar_view: createReactBlockSpec({
        type: "calendar_view",
        propSchema: { collectionId: { default: "" } },
        content: "none",
      }, {
        render: ({ block, editor }) => {
          const collectionId = block.props.collectionId;
          const collection = collectionsRef.current.find((item) => item.id === collectionId);
          return <div className="page-calendar-embed" contentEditable={false}>
            <div className="page-calendar-embed-toolbar">
              <label>Saved calendar<select aria-label="Embedded saved calendar" value={collectionId} disabled={!editable} onChange={(event) => editor.updateBlock(block, { props: { collectionId: event.target.value } })}>
                <option value="">Choose a saved calendar</option>
                {collectionsRef.current.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
                {collectionId && !collection && <option value={collectionId}>Unavailable calendar</option>}
              </select></label>
            </div>
            {collection ? renderCalendarRef.current(collection.id) : <p className="page-calendar-embed-empty">Choose a saved calendar to show its live view in this page.</p>}
          </div>;
        },
      })(),
    },
  }), [editable]);
  const editor = useCreateBlockNote({ schema, initialContent: editorBlocks.length > 0 ? [...editorBlocks] : undefined });
  const [calendarToInsert, setCalendarToInsert] = useState("");

  function insertCalendar() {
    if (!editable || !calendarToInsert) return;
    const reference = editor.document.at(-1);
    if (!reference) return;
    editor.insertBlocks([{ type: "calendar_view", props: { collectionId: calendarToInsert } }], reference.id, "after");
  }

  function exportMarkdown() {
    const markdownBlocks = editor.document.map((block) => {
      if (block.type !== "calendar_view") return block;
      const collection = collectionsRef.current.find((item) => item.id === block.props.collectionId);
      const label = collection ? `Embedded calendar: ${collection.name}` : "Embedded calendar";
      return { type: "paragraph", content: [{ type: "text", text: `[${label}]` }] } as PartialBlock;
    });
    onExportMarkdown(editor.blocksToMarkdownLossy(markdownBlocks));
  }

  return <div className="page-editor-shell">
    <div className="page-editor-insert-toolbar">
      <button type="button" onClick={exportMarkdown}>Export Markdown</button>
    {editable && calendarCollections.length > 0 && <>
      <label>Insert saved calendar<select aria-label="Calendar to insert" value={calendarToInsert} onChange={(event) => setCalendarToInsert(event.target.value)}>
        <option value="">Choose a calendar</option>
        {calendarCollections.map((collection) => <option value={collection.id} key={collection.id}>{collection.name}</option>)}
      </select></label>
      <button type="button" disabled={!calendarToInsert} onClick={insertCalendar}>Insert calendar</button>
    </>}
    </div>
    <BlockNoteView
      editor={editor}
      editable={editable}
      className="workspace-page-editor"
      onChange={(changedEditor) => {
        const portableDocument: unknown = JSON.parse(JSON.stringify(changedEditor.document));
        onChange(validateNodeDocumentContent(portableDocument));
      }}
    />
  </div>;
}
