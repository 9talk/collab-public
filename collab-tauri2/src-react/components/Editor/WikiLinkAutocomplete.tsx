import {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";

// BlockNote does not export its internal TipTap editor type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TipTapEditor = any;

interface Suggestion {
  stem: string;
  path: string;
  ambiguous: boolean;
}

function displayLabel(s: Suggestion): string {
  if (!s.ambiguous) return s.stem;
  const segments = s.path.replace(/\\/g, "/").split("/");
  const name = segments[segments.length - 1] ?? "";
  const stem = name.replace(/\.md$/, "");
  const parent = segments[segments.length - 2];
  return parent ? `${parent}/${stem}` : stem;
}

interface WikiLinkAutocompleteProps {
  editor: TipTapEditor;
}

function getCaretCoords(
  editor: TipTapEditor,
): { top: number; left: number } | null {
  const tiptap =
    editor._tiptapEditor ?? editor.tiptapEditor;
  if (!tiptap?.view) return null;
  const { state } = tiptap;
  const { from } = state.selection;
  try {
    const coords = tiptap.view.coordsAtPos(from);
    return { top: coords.bottom, left: coords.left };
  } catch {
    return null;
  }
}

function getTiptap(
  editor: TipTapEditor,
): TipTapEditor {
  return editor._tiptapEditor ?? editor.tiptapEditor;
}

function findTrigger(
  editor: TipTapEditor,
): { start: number; query: string } | null {
  const tiptap = getTiptap(editor);
  if (!tiptap) return null;

  const { state } = tiptap;
  const { from, empty } = state.selection;
  if (!empty) return null;

  const $pos = state.doc.resolve(from);
  const textBefore = $pos.parent.textBetween(
    0,
    $pos.parentOffset,
    undefined,
    "\ufffc",
  );

  const triggerIdx = textBefore.lastIndexOf("[[");
  if (triggerIdx === -1) return null;

  const afterTrigger = textBefore.slice(triggerIdx + 2);
  if (afterTrigger.includes("]]")) return null;
  if (afterTrigger.includes("\n")) return null;

  const blockStart = $pos.start();
  return {
    start: blockStart + triggerIdx,
    query: afterTrigger,
  };
}

export function WikiLinkAutocomplete({
  editor,
}: WikiLinkAutocompleteProps) {
  const [active, setActive] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>(
    [],
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const triggerRef = useRef<{
    start: number;
    query: string;
  } | null>(null);
  const suggestionsRef = useRef(suggestions);
  suggestionsRef.current = suggestions;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const dropdownRef = useRef<HTMLDivElement>(null);

  const insertWikiLink = useCallback(
    (target: string) => {
      const tiptap = getTiptap(editor);
      if (!tiptap || !triggerRef.current) return;

      const { state } = tiptap;
      const { from } = state.selection;
      const triggerStart = triggerRef.current.start;

      const node = state.schema.nodes.wikiLink?.create({
        target,
      });
      if (!node) return;

      const tr = state.tr
        .delete(triggerStart, from)
        .insert(triggerStart, node);

      tiptap.view.dispatch(tr);
      tiptap.view.focus();

      setActive(false);
      triggerRef.current = null;
    },
    [editor],
  );

  useEffect(() => {
    const tiptap = getTiptap(editor);
    if (!tiptap) return;

    const handleUpdate = () => {
      const trigger = findTrigger(editor);
      if (trigger) {
        triggerRef.current = trigger;
        setActive(true);
        setSelectedIndex(0);

        const coords = getCaretCoords(editor);
        if (coords) {
          setPosition(coords);
        }

        window.api
          .suggestWikilinks(trigger.query)
          .then(setSuggestions)
          .catch(() => setSuggestions([]));
      } else {
        setActive(false);
        triggerRef.current = null;
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!triggerRef.current) return;
      const items = suggestionsRef.current;
      const idx = selectedIndexRef.current;

      if (e.key === "Escape") {
        e.preventDefault();
        setActive(false);
        triggerRef.current = null;
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) =>
          Math.min(i + 1, items.length - 1),
        );
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }

      if (e.key === "Enter" || e.key === "Tab") {
        if (items.length > 0) {
          e.preventDefault();
          const selected = items[idx];
          if (selected) {
            insertWikiLink(displayLabel(selected));
          }
        }
      }
    };

    tiptap.on("transaction", handleUpdate);
    const el = tiptap.view?.dom;
    if (el) {
      el.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      tiptap.off("transaction", handleUpdate);
      if (el) {
        el.removeEventListener("keydown", handleKeyDown);
      }
    };
  }, [editor, insertWikiLink]);

  useEffect(() => {
    if (!active) return;
    const item = dropdownRef.current?.children[
      selectedIndex
    ] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, active]);

  if (!active || !position || suggestions.length === 0) {
    return null;
  }

  return (
    <div
      ref={dropdownRef}
      className="wikilink-autocomplete"
      style={{
        position: "fixed",
        top: position.top + 4,
        left: position.left,
      }}
    >
      {suggestions.map((s, i) => (
        <button
          key={s.path}
          type="button"
          className={`wikilink-autocomplete-item${
            i === selectedIndex ? " selected" : ""
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            insertWikiLink(displayLabel(s));
          }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          {displayLabel(s)}
        </button>
      ))}
    </div>
  );
}
