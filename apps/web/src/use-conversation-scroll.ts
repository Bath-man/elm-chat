import { useLayoutEffect, useRef, useState } from "react";
import { isNearLatest, unseenMessageIds } from "./conversation-scroll";

export function useConversationScroll(messages: readonly { id: string }[], ready: boolean, pauseFollowing = false) {
  const chatLogRef = useRef<HTMLElement | null>(null);
  const followingRef = useRef(true);
  const previousIdsRef = useRef<ReadonlySet<string>>(new Set());
  const pendingIdsRef = useRef<ReadonlySet<string>>(new Set());
  const historyAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);

  function preserveHistoryPosition() {
    const log = chatLogRef.current;
    if (log) historyAnchorRef.current = { height: log.scrollHeight, top: log.scrollTop };
  }

  function jumpToLatest() {
    followingRef.current = true;
    pendingIdsRef.current = new Set();
    setAwayFromLatest(false);
    setNewMessageCount(0);
    const log = chatLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }

  function handleConversationScroll() {
    const log = chatLogRef.current;
    if (!log) return;
    const following = isNearLatest(log);
    followingRef.current = following;
    setAwayFromLatest(!following);
    if (following) {
      pendingIdsRef.current = new Set();
      setNewMessageCount(0);
    }
  }

  useLayoutEffect(() => {
    const log = chatLogRef.current;
    if (!log) {
      previousIdsRef.current = new Set();
      jumpToLatest();
      return;
    }
    const ids = messages.map((message) => message.id);
    const anchor = historyAnchorRef.current;
    historyAnchorRef.current = null;
    if (anchor) {
      // Use the pre-update height, not native anchoring, to avoid a double adjustment.
      log.scrollTop = anchor.top + log.scrollHeight - anchor.height;
      previousIdsRef.current = new Set(ids);
      handleConversationScroll();
      return;
    }
    pendingIdsRef.current = unseenMessageIds(
      previousIdsRef.current, pendingIdsRef.current, ids, followingRef.current && !pauseFollowing
    );
    previousIdsRef.current = new Set(ids);
    setNewMessageCount(pendingIdsRef.current.size);
    if (pauseFollowing) setAwayFromLatest(!isNearLatest(log) || pendingIdsRef.current.size > 0);
    if (!pauseFollowing && (followingRef.current || messages.length === 0)) {
      jumpToLatest();
    }
    // When reading earlier messages, leave scrollTop to native scroll anchoring.
    // In particular, expiration and file updates must not force a jump.
  }, [messages, ready]);

  return { chatLogRef, awayFromLatest, newMessageCount, jumpToLatest, handleConversationScroll, preserveHistoryPosition };
}
