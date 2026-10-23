const PREFIX = "elm-interaction:v1:";

export type RequestInteraction =
  | { type: "notice.request"; id: string; text: string; color: string }
  | { type: "poll.request"; id: string; question: string; options: string[] };
export type Interaction = RequestInteraction
  | { type: "notice.ack"; id: string; replyTo: string }
  | { type: "poll.answer"; id: string; replyTo: string; answer: string }
  | { type: "message.like"; id: string; replyTo: string }
  | { type: "pin.set"; id: string; text: string; color: string }
  | { type: "pin.delete"; id: string }
  | { type: "dice"; id: string; value: number }
  | { type: "hidden"; id: string; surface: string; hidden: string }
  | { type: "message.edit"; id: string; replyTo: string; start: number; end: number; replacement: string };

type Message = { id: string; senderSessionId: string; plaintext?: string; sentAt?: number };
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
const validText = (value: unknown, limit: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= limit;

function isInteraction(value: unknown): value is Interaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!validId(item.id)) return false;
  switch (item.type) {
    case "notice.request": return item.id.length <= 120 && validText(item.text, 500) && typeof item.color === "string" && /^#[0-9a-fA-F]{6}$/.test(item.color);
    case "poll.request": return item.id.length <= 120 && validText(item.question, 500) && Array.isArray(item.options) && item.options.length >= 1 && item.options.length <= 6 && item.options.every(option => validText(option, 120)) && new Set(item.options.map(option => option.trim())).size === item.options.length;
    case "notice.ack":
    case "message.like": return validId(item.replyTo);
    case "pin.set": return validText(item.text, 500) && typeof item.color === "string" && /^#[0-9a-fA-F]{6}$/.test(item.color);
    case "pin.delete": return true;
    case "dice": return typeof item.value === "number" && Number.isInteger(item.value) && item.value >= 1 && item.value <= 6;
    case "hidden": return validText(item.surface, 4000) && validText(item.hidden, 4000);
    case "message.edit": return validId(item.replyTo) && Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) && (item.start as number) >= 0 && (item.end as number) > (item.start as number) && validText(item.replacement, 4000);
    case "poll.answer": return validId(item.replyTo) && validText(item.answer, 120);
    default: return false;
  }
}

export function encodeInteraction(value: Interaction): string {
  if (!isInteraction(value)) throw new Error("互动消息格式无效");
  return PREFIX + JSON.stringify(value);
}

export function decodeInteraction(value: string): Interaction | null {
  if (!value.startsWith(PREFIX) || value.length > 60000) return null;
  try {
    const parsed: unknown = JSON.parse(value.slice(PREFIX.length));
    return isInteraction(parsed) ? parsed : null;
  } catch { return null; }
}

export function interactionText(value: Interaction): string {
  switch (value.type) {
    case "notice.request": return value.text;
    case "notice.ack": return "";
    case "poll.request": return value.question;
    case "poll.answer": return value.answer;
    case "dice": return `${["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][value.value - 1]} ${value.value}`;
    case "hidden": return value.surface;
    case "message.like":
    case "pin.set":
    case "pin.delete":
    case "message.edit": return "";
  }
}

export function pendingInteractions(messages: readonly Message[], sessionId: string): RequestInteraction[] {
  const requests = new Map<string, RequestInteraction>();
  const answered = new Set<string>();
  for (const message of messages) {
    if (typeof message.plaintext !== "string") continue;
    const value = decodeInteraction(message.plaintext);
    if (!value) continue;
    if (value.type === "notice.request" || value.type === "poll.request") {
      if (message.senderSessionId !== sessionId && !requests.has(value.id)) requests.set(value.id, value);
    }
  }
  // Peer timestamps may place a reply before its request in local history.
  for (const message of messages) {
    if (message.senderSessionId !== sessionId || typeof message.plaintext !== "string") continue;
    const value = decodeInteraction(message.plaintext);
    if (!value || (value.type !== "notice.ack" && value.type !== "poll.answer")) continue;
    const request = requests.get(value.replyTo);
    if ((request?.type === "notice.request" && value.type === "notice.ack") ||
        (request?.type === "poll.request" && value.type === "poll.answer" && request.options.includes(value.answer))) answered.add(value.replyTo);
  }
  return [...requests.values()].filter(request => !answered.has(request.id));
}

export function isStateInteraction(value: Interaction): boolean {
  return value.type === "notice.ack" || value.type === "message.like" || value.type === "pin.set" || value.type === "pin.delete" || value.type === "message.edit";
}

export type MessageEdit = { start: number; end: number; replacement: string };
export type SharedPin = { id: string; text: string; color: string };

export function deriveInteractionState(messages: readonly Message[]) {
  const acknowledged = new Set<string>();
  const answers = new Map<string, string>();
  const likes = new Map<string, number>();
  const edits = new Map<string, MessageEdit>();
  let pin: SharedPin | null = null;
  const targets = new Map<string, Message>();
  const requests = new Map<string, { value: RequestInteraction; sender: string }>();
  const events: { message: Message; value: Interaction }[] = [];
  for (const message of messages) {
    if (typeof message.plaintext !== "string") continue;
    const value = decodeInteraction(message.plaintext);
    if (!value) {
      if (!targets.has(message.id)) targets.set(message.id, message);
      continue;
    }
    events.push({ message, value });
  }
  // Resolve targets first: clock skew and replay order must not drop replies.
  events.sort((a, b) => (a.message.sentAt ?? 0) - (b.message.sentAt ?? 0) ||
    compareId(a.value.id, b.value.id) || compareId(a.message.senderSessionId, b.message.senderSessionId));
  for (const { message, value } of events) {
    if ((value.type === "notice.request" || value.type === "poll.request") && !requests.has(value.id)) {
      requests.set(value.id, { value, sender: message.senderSessionId });
    }
  }
  const seen = new Set<string>();
  for (const { message, value } of events) {
    const eventKey = JSON.stringify([message.senderSessionId, value.id]);
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    if (value.type === "pin.set") {
      pin = { id: value.id, text: value.text, color: value.color };
    } else if (value.type === "pin.delete") {
      pin = null;
    } else if (value.type === "notice.ack" || value.type === "poll.answer") {
      const request = requests.get(value.replyTo);
      if (!request || request.sender === message.senderSessionId) continue;
      if (value.type === "notice.ack" && request.value.type === "notice.request") acknowledged.add(value.replyTo);
      if (value.type === "poll.answer" && request.value.type === "poll.request" && request.value.options.includes(value.answer) && !answers.has(value.replyTo)) answers.set(value.replyTo, value.answer);
    } else if (value.type === "message.like") {
      if (targets.has(value.replyTo)) likes.set(value.replyTo, (likes.get(value.replyTo) ?? 0) + 1);
    } else if (value.type === "message.edit") {
      const target = targets.get(value.replyTo);
      if (target && target.senderSessionId !== message.senderSessionId && value.end <= target.plaintext!.length && !edits.has(value.replyTo)) {
        edits.set(value.replyTo, { start: value.start, end: value.end, replacement: value.replacement });
      }
    }
  }
  return { acknowledged, answers, likes, edits, pin };
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
