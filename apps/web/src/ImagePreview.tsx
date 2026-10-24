import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { imageBytes, type ChatImage } from './image-messages';

function useImageUrl(image: ChatImage) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([imageBytes(image)], { type: image.mimeType }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [image]);
  return url;
}

export function ImageThumbnail({ image, onPreview }: { image: ChatImage; onPreview: (image: ChatImage) => void }) {
  const url = useImageUrl(image);
  return <button className="image-thumbnail" type="button" aria-label={`查看图片：${image.name || '图片'}`} onClick={() => onPreview(image)}>
    <img src={url} alt={image.name || '聊天图片'} width={image.width} height={image.height} loading="lazy" draggable={false} />
  </button>;
}

type Transform = { scale: number; x: number; y: number };
type Point = { x: number; y: number };
const initial: Transform = { scale: 1, x: 0, y: 0 };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function ImagePreview({ image, onClose }: { image: ChatImage; onClose: () => void }) {
  const url = useImageUrl(image);
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [transform, setTransform] = useState(initial);
  const current = useRef(transform);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ points: Point[]; transform: Transform }>({ points: [], transform: initial });
  const commit = (next: Transform) => { current.current = next; setTransform(next); };
  const snapshot = () => { gesture.current = { points: [...pointers.current.values()], transform: current.current }; };

  function zoom(factor: number, point?: Point) {
    const previous = current.current;
    const scale = Math.max(0.25, Math.min(8, previous.scale * factor));
    const ratio = scale / previous.scale;
    commit({ scale, x: (previous.x - (point?.x ?? 0)) * ratio + (point?.x ?? 0), y: (previous.y - (point?.y ?? 0)) * ratio + (point?.y ?? 0) });
  }

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoom(Math.exp(-event.deltaY * 0.002), { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  function endPointer(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    snapshot();
  }

  return <div className="image-preview" ref={dialog} role="dialog" aria-modal="true" aria-label="图片预览" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.25); }
    if (event.key === '-') { event.preventDefault(); zoom(0.8); }
    if (event.key === '0') { event.preventDefault(); commit(initial); }
    if (event.key === 'Tab') {
      const buttons = [...dialog.current!.querySelectorAll<HTMLButtonElement>('button')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <div className="image-preview-toolbar">
      <button type="button" ref={close} aria-label="关闭图片预览" onClick={onClose}>关闭</button>
      <button type="button" aria-label="缩小图片" onClick={() => zoom(0.8)} disabled={transform.scale <= 0.25}>−</button>
      <span className="image-preview-zoom" aria-live="polite">{Math.round(transform.scale * 100)}%</span>
      <button type="button" aria-label="放大图片" onClick={() => zoom(1.25)} disabled={transform.scale >= 8}>+</button>
      <button type="button" aria-label="复位图片" onClick={() => commit(initial)}>复位</button>
    </div>
    <div className="image-preview-stage" ref={stage} onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (event.currentTarget.hasPointerCapture(event.pointerId) || event.nativeEvent.isTrusted) event.currentTarget.setPointerCapture(event.pointerId);
      snapshot();
    }} onPointerMove={event => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...pointers.current.values()];
      const before = gesture.current;
      if (points.length >= 2 && before.points.length >= 2) {
        const origin = midpoint(before.points[0], before.points[1]);
        const center = midpoint(points[0], points[1]);
        const scale = Math.max(0.25, Math.min(8, before.transform.scale * distance(points[0], points[1]) / Math.max(1, distance(before.points[0], before.points[1]))));
        const rect = event.currentTarget.getBoundingClientRect();
        const x = origin.x - rect.left - rect.width / 2, y = origin.y - rect.top - rect.height / 2;
        const ratio = scale / before.transform.scale;
        commit({ scale, x: (before.transform.x - x) * ratio + x + center.x - origin.x, y: (before.transform.y - y) * ratio + y + center.y - origin.y });
      } else if (points.length === 1 && before.points.length === 1) {
        commit({ ...before.transform, x: before.transform.x + points[0].x - before.points[0].x, y: before.transform.y + points[0].y - before.points[0].y });
      }
    }} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}>
      <img src={url} alt={image.name || '聊天图片'} draggable={false} style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }} />
    </div>
    <p className="image-preview-hint">滚轮或双指缩放 · 拖动移动 · Esc 关闭</p>
  </div>;
}
