// useChatSearchHighlight — find-in-conversation, without touching the DOM.
//
// The obvious implementation (wrap matches in <mark>) is unsafe here: the
// message bubbles render markdown, and an assistant answer types out character
// by character, so React owns and continuously mutates those text nodes.
// Wrapping them would fight the reconciler and can throw outright when React
// tries to update a text node we re-parented.
//
// So this uses the CSS Custom Highlight API: ranges are computed by READING
// the text nodes and handed to the browser to paint (see `::highlight()` in
// index.css). Zero DOM mutation, nothing for React to trip over. On a browser
// without the API the hook degrades to counting + scrolling matches with no
// tint, which is still a working find.

import { useCallback, useEffect, useRef, useState } from "react";

const HIGHLIGHT_ALL = "chat-search";
const HIGHLIGHT_ACTIVE = "chat-search-active";

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

function highlightRegistry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights ?? null;
}

function HighlightCtor(): (new (...ranges: Range[]) => unknown) | null {
  return (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight ?? null;
}

/** Every match of `query` inside `root`, in document order. */
function collectRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const hay = node.data.toLowerCase();
    let from = hay.indexOf(needle);
    while (from !== -1) {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, from + needle.length);
      ranges.push(range);
      from = hay.indexOf(needle, from + needle.length);
    }
    node = walker.nextNode() as Text | null;
  }
  return ranges;
}

export interface ChatSearchState {
  /** How many matches are on screen for the current query. */
  count: number;
  /** 0-based index of the focused match (-1 when there are none). */
  index: number;
  next: () => void;
  prev: () => void;
}

/**
 * @param rootRef   container whose text is searched
 * @param query     raw search string (trimmed/lowercased internally)
 * @param revision  bump to recompute — pass something that changes when the
 *                  rendered content does (message count, last message length…)
 */
export function useChatSearchHighlight(
  rootRef: React.RefObject<HTMLElement | null>,
  query: string,
  revision: unknown,
): ChatSearchState {
  const rangesRef = useRef<Range[]>([]);
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(-1);

  // Recompute the match set whenever the query or the content changes.
  useEffect(() => {
    const root = rootRef.current;
    const registry = highlightRegistry();
    const Ctor = HighlightCtor();
    const ranges = root && query.trim() ? collectRanges(root, query) : [];
    rangesRef.current = ranges;
    setCount(ranges.length);
    setIndex((prev) => (ranges.length === 0 ? -1 : Math.min(Math.max(prev, 0), ranges.length - 1)));

    if (registry && Ctor) {
      if (ranges.length === 0) registry.delete(HIGHLIGHT_ALL);
      else registry.set(HIGHLIGHT_ALL, new Ctor(...ranges));
    }
    return () => {
      registry?.delete(HIGHLIGHT_ALL);
      registry?.delete(HIGHLIGHT_ACTIVE);
    };
  }, [rootRef, query, revision]);

  // Paint the focused match differently and bring it into view.
  useEffect(() => {
    const registry = highlightRegistry();
    const Ctor = HighlightCtor();
    const active = rangesRef.current[index];
    if (!active) {
      registry?.delete(HIGHLIGHT_ACTIVE);
      return;
    }
    if (registry && Ctor) registry.set(HIGHLIGHT_ACTIVE, new Ctor(active));
    // Ranges can't be scrolled directly — scroll the element that contains it.
    const anchor =
      active.startContainer.nodeType === Node.TEXT_NODE
        ? active.startContainer.parentElement
        : (active.startContainer as HTMLElement);
    anchor?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [index, count]);

  const next = useCallback(() => {
    setIndex((i) => (rangesRef.current.length === 0 ? -1 : (i + 1) % rangesRef.current.length));
  }, []);
  const prev = useCallback(() => {
    setIndex((i) =>
      rangesRef.current.length === 0
        ? -1
        : (i - 1 + rangesRef.current.length) % rangesRef.current.length,
    );
  }, []);

  return { count, index, next, prev };
}
