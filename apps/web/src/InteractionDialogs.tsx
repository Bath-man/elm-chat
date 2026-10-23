import { generateMessageId } from "@elm-chat/crypto";
import { useRef, useState, type FormEvent } from "react";
import type { Interaction, RequestInteraction } from "./interactions";

const colors = ["#fff2a8", "#ffd1dc", "#cceaff", "#d5f5dc", "#dcd4ff", "#ffffff"];

export function InteractionComposer({ onSend, onClose }: {
  onSend: (value: Interaction) => Promise<boolean>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"notice" | "poll">("notice");
  const [text, setText] = useState("");
  const [color, setColor] = useState(colors[0]);
  const [options, setOptions] = useState(["", ""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const validColor = /^#[0-9a-fA-F]{6}$/.test(color);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    if (!text.trim() || (kind === "notice" ? !validColor : options.some(option => !option.trim()))) {
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
      const value: Interaction = kind === "notice"
        ? { type: "notice.request", id: generateMessageId(), text: text.trim(), color }
        : { type: "poll.request", id: generateMessageId(), question: text.trim(), options: options.map(option => option.trim()) };
      if (await onSend(value)) onClose();
      else setError("发送失败，请重试。");
    } catch { setError("发送失败，请重试。"); }
    finally { sending.current = false; setBusy(false); }
  }

  return <div className="interaction-overlay" role="dialog" aria-modal="true" aria-label="发送互动">
    <form className="interaction-panel" onSubmit={submit}>
      <div className="interaction-tabs">
        <button type="button" aria-pressed={kind === "notice"} onClick={() => setKind("notice")}>发送提醒</button>
        <button type="button" aria-pressed={kind === "poll"} onClick={() => setKind("poll")}>单选调查</button>
      </div>
      <label>{kind === "notice" ? "提醒文字" : "调查问题"}<textarea maxLength={500} required value={text} onChange={event => setText(event.target.value)} /></label>
      {kind === "notice" ? <>
        <div className="interaction-colors" aria-label="预设背景色">{colors.map(preset => <button key={preset} type="button" aria-label={`选择 ${preset}`} aria-pressed={color === preset} style={{ backgroundColor: preset }} onClick={() => setColor(preset)} />)}</div>
        <label>自定义颜色（HEX）<input value={color} maxLength={7} placeholder="#RRGGBB" onChange={event => setColor(event.target.value)} aria-invalid={!validColor} /></label>
        <div className="interaction-preview" style={{ backgroundColor: validColor ? color : "#ffffff", color: validColor ? contrastColor(color) : "#111111" }}>{text || "提醒预览"}</div>
      </> : <>
        {options.map((option, index) => <label key={index}>选项 {index + 1}<input required maxLength={120} value={option} onChange={event => setOptions(current => current.map((item, i) => i === index ? event.target.value : item))} /></label>)}
        <div className="interaction-tabs"><button type="button" disabled={options.length >= 6} onClick={() => setOptions([...options, ""])}>添加选项</button><button type="button" disabled={options.length <= 2} onClick={() => setOptions(options.slice(0, -1))}>移除末项</button></div>
      </>}
      {error && <p className="interaction-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "发送中…" : "发送"}</button>
      <button type="button" disabled={busy} onClick={onClose}>取消</button>
    </form>
  </div>;
}

function contrastColor(color: string): string {
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
  async function reply(event: FormEvent) {
    event.preventDefault();
    if (sending.current || (!notice && !interaction.options.includes(selection))) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const value: Interaction = notice
      ? { type: "notice.ack", id: `ack:${interaction.id}`, replyTo: interaction.id }
      : { type: "poll.answer", id: `answer:${interaction.id}`, replyTo: interaction.id, answer: selection };
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
    <form className="interaction-panel" onSubmit={reply}>
      <h2>{notice ? interaction.text : interaction.question}</h2>
      {!notice && <fieldset className="interaction-options"><legend>请选择一项</legend>{interaction.options.map((option, index) => <label key={index}><input type="radio" name={`poll-${interaction.id}`} checked={selection === option} onChange={() => setSelection(option)} value={option} />{option}</label>)}</fieldset>}
      {error && <p className="interaction-error" role="alert">{error}</p>}
      <button className={notice ? "interaction-confirm" : undefined} type="submit" disabled={busy || (!notice && !selection)}>{busy ? "发送中…" : notice ? "确认" : "提交"}</button>
    </form>
    <button type="button" className="interaction-exit" onClick={onExit}>退出房间</button>
  </div>;
}
