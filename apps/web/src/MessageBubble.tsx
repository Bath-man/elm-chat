import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { decodeInteraction, interactionText, type MessageEdit } from "./interactions";

export type MessageEntrance = { until: number; played?: boolean };

type BubbleMessage = { id: string; plaintext?: string; sentAt: number; delivery?: "pending" | "sent"; imported?: boolean; entrance?: MessageEntrance };

export function MessageBubble({ message, mine, likes, confirmed, answer, edit, onLike, onEdit }: {
  message: BubbleMessage;
  mine: boolean;
  likes: number;
  confirmed: boolean;
  answer?: string;
  edit?: MessageEdit;
  onLike: () => Promise<boolean>;
  onEdit: () => void;
}) {
  // UI-only token survives delivery updates and temporary unmounts. Consume it
  // after commit (not during render, which StrictMode can repeat).
  const [animateEntrance, setAnimateEntrance] = useState(() => !message.imported &&
    !!message.entrance && !message.entrance.played && message.entrance.until > Date.now() &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (message.entrance) message.entrance.played = true;
    if (!animateEntrance) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => setAnimateEntrance(false);
    const onMotionChange = () => { if (motion.matches) stop(); };
    // Fallback for suppressed/cancelled animations that do not emit animationend.
    const timeout = window.setTimeout(stop, 250);
    motion.addEventListener("change", onMotionChange);
    onMotionChange();
    return () => { window.clearTimeout(timeout); motion.removeEventListener("change", onMotionChange); };
  }, [animateEntrance, message.entrance]);
  const [revealed, setRevealed] = useState(false);
  const [actions, setActions] = useState(false);
  const [hearts, setHearts] = useState<{ id: number; style: CSSProperties }[]>([]);
  const heartSequence = useRef(0);
  const previousLikes = useRef(likes);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointer = useRef({ x: 0, y: 0, suppress: false });
  const interaction = decodeInteraction(message.plaintext ?? "");
  const ordinary = !interaction && !message.imported;
  const canEdit = ordinary && !mine && !edit;
  const kind = interaction?.type;
  const text = message.plaintext ?? "";

  useEffect(() => {
    if (likes <= previousLikes.current) { previousLikes.current = likes; return; }
    const added = likes - previousLikes.current;
    previousLikes.current = likes;
    const newHearts = Array.from({ length: added }, () => ({ id: ++heartSequence.current, style: {
      "--heart-x": `${Math.random() * 10 - 5}px`,
      "--heart-y": `${Math.random() * 6 - 3}px`,
      "--heart-drift": `${Math.random() * 24 - 12}px`,
      "--heart-rise": `${-38 - Math.random() * 10}px`,
      "--heart-duration": `${1150 + Math.random() * 300}ms`
    } as CSSProperties }));
    setHearts(current => [...current, ...newHearts]);
  }, [likes]);
  useEffect(() => () => clearTimeout(hold.current), []);

  function preserveTypingFocus(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0 || !ordinary || (event.target as HTMLElement).closest("button")) return;
    const active = event.currentTarget.ownerDocument.activeElement;
    // Keep the same typing/IME session; never blur then programmatically refocus.
    if (active?.matches(".composer textarea") && event.currentTarget.closest(".room-shell")?.contains(active)) {
      event.preventDefault();
    }
  }

  function pointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || !ordinary || (event.target as HTMLElement).closest("button")) return;
    preserveTypingFocus(event);
    clearTimeout(hold.current);
    pointer.current = { x: event.clientX, y: event.clientY, suppress: false };
    if (canEdit) hold.current = setTimeout(() => {
      pointer.current.suppress = true;
      setActions(true);
    }, 480);
  }
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(message.sentAt);
  const suffix = kind === "notice.request" ? ` notice${confirmed ? " confirmed" : ""}` : kind === "poll.request" ? " poll" : kind === "poll.answer" ? " answer" : kind === "dice" ? " dice" : kind === "hidden" ? " hidden-message" : "";

  return <article className={`bubble ${mine ? "bubble-mine" : "bubble-theirs"}${suffix}${ordinary ? " likeable" : ""}${animateEntrance ? " bubble-enter" : ""}`}
    onAnimationEnd={event => {
      if (event.target === event.currentTarget && event.animationName === "message-enter") setAnimateEntrance(false);
    }}
    data-message-id={message.id} role={ordinary ? "button" : undefined} tabIndex={ordinary ? 0 : undefined}
    aria-label={ordinary ? "点赞消息" : undefined}
    onPointerDown={pointerDown} onMouseDown={preserveTypingFocus} onPointerUp={() => clearTimeout(hold.current)}
    onPointerCancel={() => { clearTimeout(hold.current); pointer.current.suppress = true; }}
    onPointerMove={event => {
      if (Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 8) {
        clearTimeout(hold.current); pointer.current.suppress = true;
      }
    }}
    onClick={event => {
      if (ordinary && !pointer.current.suppress && !(event.target as HTMLElement).closest("button")) void onLike();
    }}
    onKeyDown={event => {
      if (ordinary && event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault(); void onLike();
      }
      if (event.key === "Escape") setActions(false);
    }}
    onContextMenu={event => {
      if (!canEdit) return;
      event.preventDefault(); clearTimeout(hold.current); pointer.current.suppress = true; setActions(true);
    }}>
    {interaction?.type === "dice" ? <div className="dice-result"><span className="dice-face" data-value={interaction.value} role="img" aria-label={`${interaction.value} 点`}>{["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][interaction.value - 1]}</span><span>摇到 {interaction.value} 点</span></div>
      : interaction?.type === "hidden" ? <div className="hidden-content"><p key={String(revealed)} className={revealed ? "hidden-text" : undefined}>{revealed ? interaction.hidden : interaction.surface}</p><button type="button" className="hidden-toggle" aria-label={revealed ? "显示表面文字" : "显示隐藏文字"} aria-pressed={revealed} onClick={() => setRevealed(!revealed)}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>{revealed && <path d="m3 3 18 18"/>}</svg></button></div>
      : <p>{edit ? <>{text.slice(0, edit.start)}<del>{text.slice(edit.start, edit.end)}</del><ins>{edit.replacement}</ins>{text.slice(edit.end)}</> : interaction ? interactionText(interaction) : text}</p>}
    {kind === "notice.request" && !message.imported && <span className="bubble-state">{confirmed ? "已确认" : "等待确认"}</span>}
    {kind === "poll.request" && !message.imported && <span className="bubble-state">{answer ? `已回答 · ${answer}` : "等待回答"}</span>}
    <footer>{time}{message.imported ? " · 导入记录" : mine && message.delivery === "pending" ? " · 待发送" : ""}{edit ? " · 已涂改" : ""}</footer>
    {ordinary && likes > 0 && <span className="bubble-likes" aria-label={`${likes} 次点赞`}><span aria-hidden="true">♥</span><span className="like-count" key={likes}>{likes}</span></span>}
    {hearts.map(heart => <span className="floating-heart" key={heart.id} style={heart.style} onAnimationEnd={() => setHearts(current => current.filter(item => item.id !== heart.id))} aria-hidden="true">♥</span>)}
    {actions && canEdit && <div className="message-actions"><button type="button" onClick={event => { event.stopPropagation(); setActions(false); onEdit(); }}>涂改</button><button type="button" onClick={event => { event.stopPropagation(); setActions(false); }}>取消</button></div>}
  </article>;
}
