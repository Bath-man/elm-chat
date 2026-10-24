import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { messageOffsets, visibleMessageRange } from "./virtual-messages";

export interface VirtualMessageNavigation {
  scrollToMessage(id: string): boolean;
}

interface Props<T extends { id: string }> {
  messages: readonly T[];
  scrollRef: RefObject<HTMLElement | null>;
  navigationRef?: RefObject<VirtualMessageNavigation | null>;
  renderMessage(message: T): ReactNode;
}

const GAP = 8;
const ESTIMATED_HEIGHT = 100;
const OVERSCAN = 600;

/** Windowed, variable-height rows. Slot wrappers survive scrolling; message state does not. */
export function VirtualMessageList<T extends { id: string }>({ messages, scrollRef, navigationRef, renderMessage }: Props<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const pendingNavigation = useRef<string | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [, setMeasurementVersion] = useState(0);
  const offsets = messageOffsets(messages, heights.current, ESTIMATED_HEIGHT);
  const range = visibleMessageRange(offsets, viewport.top, viewport.height, OVERSCAN);
  const latest = useRef({ messages, offsets });
  latest.current = { messages, offsets };

  function listTop(log: HTMLElement, root: HTMLElement) {
    return root.getBoundingClientRect().top - log.getBoundingClientRect().top - log.clientTop + log.scrollTop;
  }

  function readViewport() {
    const log = scrollRef.current;
    const root = rootRef.current;
    if (!log || !root) return;
    const top = log.scrollTop - listTop(log, root);
    const height = log.clientHeight;
    setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height });
  }

  function navigate(id: string) {
    const log = scrollRef.current;
    const root = rootRef.current;
    const { messages: current, offsets: currentOffsets } = latest.current;
    const index = current.findIndex(message => message.id === id);
    if (!log || !root || index < 0) return false;
    log.scrollTop = listTop(log, root) + currentOffsets[index] - (log.clientHeight - (currentOffsets[index + 1] - currentOffsets[index])) / 2;
    readViewport();
    return true;
  }

  useEffect(() => {
    const log = scrollRef.current;
    if (!log) return;
    const onScroll = () => { pendingNavigation.current = null; readViewport(); };
    log.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(readViewport);
    observer.observe(log);
    readViewport();
    return () => { log.removeEventListener("scroll", onScroll); observer.disconnect(); };
  }, [scrollRef]);

  useLayoutEffect(() => {
    if (!navigationRef) return;
    navigationRef.current = { scrollToMessage(id) {
      pendingNavigation.current = id;
      return navigate(id);
    } };
    return () => { navigationRef.current = null; };
  });

  useEffect(() => {
    const root = rootRef.current;
    const log = scrollRef.current;
    if (!root || !log) return;
    const measure = () => {
      const { messages: current, offsets: oldOffsets } = latest.current;
      const top = log.scrollTop - listTop(log, root);
      const following = log.scrollHeight - log.scrollTop - log.clientHeight <= 48;
      let correction = 0;
      let changed = false;
      for (const row of root.querySelectorAll<HTMLElement>("[data-virtual-message]")) {
        const id = row.dataset.virtualMessage!;
        const height = row.getBoundingClientRect().height;
        const previous = heights.current.get(id) ?? ESTIMATED_HEIGHT;
        if (height > 0 && Math.abs(height - previous) > 0.5) {
          const index = Number(row.dataset.messageIndex);
          if (oldOffsets[index + 1] <= top) correction += height - previous;
          heights.current.set(id, height);
          changed = true;
        }
      }
      if (!changed) return;
      const nextOffsets = messageOffsets(current, heights.current, ESTIMATED_HEIGHT);
      latest.current = { messages: current, offsets: nextOffsets };
      // Update spacers before adjusting scrollTop, avoiding the browser's old-height clamp.
      const first = Number(root.dataset.rangeStart);
      const last = Number(root.dataset.rangeEnd);
      (root.firstElementChild as HTMLElement).style.height = `${nextOffsets[first]}px`;
      (root.lastElementChild as HTMLElement).style.height = `${nextOffsets[current.length] - nextOffsets[last]}px`;
      if (pendingNavigation.current) navigate(pendingNavigation.current);
      else if (following) log.scrollTop = log.scrollHeight;
      else if (correction) log.scrollTop += correction;
      setMeasurementVersion(version => version + 1);
      readViewport();
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const row of root.querySelectorAll<HTMLElement>("[data-virtual-message]")) observer.observe(row);
    return () => observer.disconnect();
  }, [messages, range.start, range.end]);

  useLayoutEffect(() => {
    const retained = new Set(messages.map(message => message.id));
    for (const id of heights.current.keys()) if (!retained.has(id)) heights.current.delete(id);
    readViewport();
  }, [messages]);

  return <div ref={rootRef} className="virtual-message-list" data-range-start={range.start} data-range-end={range.end}
    style={{ display: "flex", flexDirection: "column", gap: 0, overflowAnchor: "none" }}>
    <div aria-hidden="true" style={{ height: offsets[range.start], flexShrink: 0 }} />
    {messages.slice(range.start, range.end).map((message, slot) => <div key={slot} data-virtual-message={message.id}
      data-message-index={range.start + slot} style={{ display: "flex", flexDirection: "column", paddingBottom: GAP, flexShrink: 0 }}>
      <Fragment key={message.id}>{renderMessage(message)}</Fragment>
    </div>)}
    <div aria-hidden="true" style={{ height: offsets[messages.length] - offsets[range.end], flexShrink: 0 }} />
  </div>;
}
