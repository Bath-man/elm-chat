import { generateMessageId } from "@elm-chat/crypto";
import { useRef, useState, type FormEvent } from "react";
import type { Interaction, RequestInteraction } from "./interactions";
import { loadRecentNoticeColors, noticePresetColors as colors, rememberNoticeColor } from "./recent-notice-colors";

type ComposerKind = "notice" | "poll" | "pin" | "hidden";

export function InteractionComposer({ onSend, onClose, initialKind = "notice", initialPin }: {
  onSend: (value: Interaction) => Promise<boolean>;
  onClose: () => void;
  initialKind?: ComposerKind;
  initialPin?: { text: string; color: string } | null;
}) {
  const [kind, setKind] = useState<ComposerKind>(initialKind);
  const [text, setText] = useState(initialKind === "pin" ? initialPin?.text ?? "" : "");
  const [hiddenText, setHiddenText] = useState("");
  const [color, setColor] = useState(initialPin?.color ?? colors[0]);
  const [options, setOptions] = useState(["", ""]);
  const [recentColors] = useState(loadRecentNoticeColors);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const validColor = /^#[0-9a-fA-F]{6}$/.test(color);
  const colored = kind === "notice" || kind === "pin";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    if (!text.trim() || (colored && !validColor) || (kind === "poll" && options.some(option => !option.trim())) || (kind === "hidden" && !hiddenText.trim())) {
      setError("请填写完整内容，颜色格式为 #RRGGBB。");
      return;
    }
    if (kind === "poll" && new Set(options.map(option => option.trim())).size !== options.length) {
      setError("调查选项不能重复，请修改后发送。");
      return;
    }
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const id = generateMessageId();
      let value: Interaction;
      switch (kind) {
        case "notice": value = { type: "notice.request", id, text: text.trim(), color }; break;
        case "poll": value = { type: "poll.request", id, question: text.trim(), options: options.map(option => option.trim()) }; break;
        case "pin": value = { type: "pin.set", id, text: text.trim(), color }; break;
        case "hidden": value = { type: "hidden", id, surface: text.trim(), hidden: hiddenText.trim() }; break;
      }
      if (await onSend(value)) {
        if (value.type === "notice.request") rememberNoticeColor(value.color);
        onClose();
      }
      else setError("发送失败，请重试。");
    } catch { setError("发送失败，请重试。"); }
    finally { sending.current = false; setBusy(false); }
  }

  return <div className="interaction-overlay" role="dialog" aria-modal="true" aria-label="发送互动">
    <form className="interaction-panel" onSubmit={submit}>
      <div className="interaction-tabs">
        {([["notice", "发送提醒"], ["poll", "单选问卷"], ["pin", "共享置顶"], ["hidden", "隐藏信息"]] as const).map(([value, label]) => <button key={value} type="button" disabled={busy} aria-pressed={kind === value} onClick={() => { setKind(value); setError(""); }}>{label}</button>)}
      </div>
      <label>{kind === "notice" ? "提醒文字" : kind === "poll" ? "问卷问题" : kind === "pin" ? "置顶文字" : "表面文字"}<textarea maxLength={kind === "hidden" ? 4000 : 500} required disabled={busy} value={text} onChange={event => setText(event.target.value)} /></label>
      {colored && <>
        <div className="interaction-colors" aria-label="预设背景色">{colors.map(preset => <button key={preset} type="button" disabled={busy} aria-label={`选择 ${preset}`} aria-pressed={color === preset} style={{ backgroundColor: preset }} onClick={() => setColor(preset)} />)}</div>
        {kind === "notice" && recentColors.length > 0 && <div>
          <span>最近使用</span>
          <div className="interaction-colors" aria-label="最近使用的提醒颜色">{recentColors.map(recent => <button key={recent} type="button" disabled={busy} aria-label={`选择最近使用的颜色 ${recent}`} title={recent} aria-pressed={color.toLowerCase() === recent} style={{ backgroundColor: recent }} onClick={() => setColor(recent)} />)}</div>
        </div>}
        <label>自定义颜色（HEX）<input value={color} disabled={busy} maxLength={7} placeholder="#RRGGBB" onChange={event => setColor(event.target.value)} aria-invalid={!validColor} /></label>
        <div className="interaction-preview" style={{ backgroundColor: validColor ? color : "#ffffff", color: validColor ? contrastColor(color) : "#111111" }}>{text || (kind === "pin" ? "置顶预览" : "提醒预览")}</div>
      </>}
      {kind === "poll" && <>
        {options.map((option, index) => <label key={index}>选项 {index + 1}<input required disabled={busy} maxLength={120} value={option} onChange={event => setOptions(current => current.map((item, i) => i === index ? event.target.value : item))} /></label>)}
        <div className="interaction-tabs"><button type="button" disabled={busy || options.length >= 6} onClick={() => setOptions([...options, ""])}>添加选项</button><button type="button" disabled={busy || options.length <= 1} onClick={() => setOptions(options.slice(0, -1))}>移除末项</button></div>
      </>}
      {kind === "hidden" && <label>隐藏文字<textarea required disabled={busy} maxLength={4000} value={hiddenText} onChange={event => setHiddenText(event.target.value)} /></label>}
      {error && <p className="interaction-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "发送中…" : kind === "pin" ? "保存置顶" : "发送"}</button>
      <button type="button" disabled={busy} onClick={onClose}>取消</button>
    </form>
  </div>;
}

export function contrastColor(color: string): string {
  const channels = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
  return channels[0] * 0.299 + channels[1] * 0.587 + channels[2] * 0.114 > 150 ? "#111111" : "#ffffff";
}

export function InteractionPrompt({ interaction, onReply, onExit }: {
  interaction: RequestInteraction;
  onReply: (value: Interaction) => Promise<boolean>;
  onExit: () => void;
}) {
  const [selection, setSelection] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const notice = interaction.type === "notice.request";
  const lastOptionTap = useRef<{ option: string; time: number } | null>(null);
  async function reply(answer = selection) {
    if (sending.current || (!notice && !interaction.options.includes(answer))) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const value: Interaction = notice
      ? { type: "notice.ack", id: `ack:${interaction.id}`, replyTo: interaction.id }
      : { type: "poll.answer", id: `answer:${interaction.id}`, replyTo: interaction.id, answer };
    let sent = false;
    try {
      sent = await onReply(value);
      if (!sent) setError("回复失败，请重试。");
    } catch { setError("回复失败，请重试。"); }
    finally {
      // A successful reply stays locked until the parent removes this prompt.
      if (!sent) { sending.current = false; setBusy(false); }
    }
  }
  return <div className={`interaction-overlay ${notice ? "notice-prompt" : "poll-prompt"}`} role="dialog" aria-modal="true" aria-label={notice ? "收到提醒" : "收到调查"} style={notice ? { backgroundColor: interaction.color, color: contrastColor(interaction.color) } : undefined}>
    <form className="interaction-panel" onSubmit={event => { event.preventDefault(); void reply(); }}>
      <h2>{notice ? interaction.text : interaction.question}</h2>
      {!notice && <fieldset className="interaction-options" disabled={busy}><legend>单击选择，双击直接提交</legend>{interaction.options.map((option, index) => <label key={index} onPointerUp={event => {
        // Some mobile browsers do not synthesize dblclick for two taps.
        if (event.pointerType !== "touch") return;
        const time = performance.now();
        const previous = lastOptionTap.current;
        lastOptionTap.current = { option, time };
        setSelection(option);
        if (previous?.option === option && time - previous.time < 350) {
          lastOptionTap.current = null;
          void reply(option);
        }
      }} onDoubleClick={() => { setSelection(option); void reply(option); }}><input type="radio" name={`poll-${interaction.id}`} checked={selection === option} onChange={() => setSelection(option)} value={option} />{option}</label>)}</fieldset>}
      {error && <p className="interaction-error" role="alert">{error}</p>}
      <button className={notice ? "interaction-confirm" : undefined} type="submit" disabled={busy || (!notice && !selection)}>{busy ? "发送中…" : notice ? "确认" : "提交"}</button>
    </form>
    <button type="button" className="interaction-exit" onClick={onExit}>退出房间</button>
  </div>;
}

export function MessageEditDialog({ text, onSubmit, onClose }: {
  text: string;
  onSubmit: (start: number, end: number, replacement: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const validSelection = range.start >= 0 && range.end > range.start && range.end <= text.length;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    if (!validSelection || !replacement.trim()) { setError("请选择原文字中的一段，并填写替换文字。"); return; }
    if (text.length - (range.end - range.start) + replacement.length > 8000) { setError("涂改后的文字不能超过 8000 字。"); return; }
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      if (await onSubmit(range.start, range.end, replacement)) onClose();
      else setError("涂改失败，消息可能已被涂改，请重试。");
    } catch { setError("涂改失败，请重试。"); }
    finally { sending.current = false; setBusy(false); }
  }
  return <div className="interaction-overlay" role="dialog" aria-modal="true" aria-labelledby="message-edit-title">
    <form className="interaction-panel" onSubmit={submit}>
      <h2 id="message-edit-title">涂改消息</h2>
      <p>选择一段原文字，再输入替换内容。每条消息只能涂改一次。</p>
      <label>选择原文字<textarea readOnly disabled={busy} value={text} onSelect={event => { const target = event.currentTarget; setRange({ start: target.selectionStart, end: target.selectionEnd }); }} /></label>
      <label>替换文字<textarea required disabled={busy} maxLength={4000} value={replacement} onChange={event => setReplacement(event.target.value)} /></label>
      {validSelection && <div className="interaction-preview message-edit-preview" aria-label="涂改预览">{text.slice(0, range.start)}<del className="message-edit-original">{text.slice(range.start, range.end)}</del><ins className="message-edit-replacement">{replacement}</ins>{text.slice(range.end)}</div>}
      {error && <p className="interaction-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || !validSelection || !replacement.trim()}>{busy ? "保存中…" : "确认涂改"}</button>
      <button type="button" disabled={busy} onClick={onClose}>取消</button>
    </form>
  </div>;
}
