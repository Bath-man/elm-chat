const PREFIX = "elm-interaction:v1:";

export type RequestInteraction =
  | { type: "notice.request"; id: string; text: string; color: string }
  | { type: "poll.request"; id: string; question: string; options: string[] };
export type Interaction = RequestInteraction
  | { type: "notice.ack"; id: string; replyTo: string }
  | { type: "poll.answer"; id: string; replyTo: string; answer: string };

type Message = { id: string; senderSessionId: string; plaintext?: string };
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
const validText = (value: unknown, limit: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= limit;

function isInteraction(value: unknown): value is Interaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!validId(item.id)) return false;
  switch (item.type) {
    case "notice.request": return item.id.length <= 120 && validText(item.text, 500) && typeof item.color === "string" && /^#[0-9a-fA-F]{6}$/.test(item.color);
    case "poll.request": return item.id.length <= 120 && validText(item.question, 500) && Array.isArray(item.options) && item.options.length >= 2 && item.options.length <= 6 && item.options.every(option => validText(option, 120)) && new Set(item.options.map(option => option.trim())).size === item.options.length;
    case "notice.ack": return validId(item.replyTo);
    case "poll.answer": return validId(item.replyTo) && validText(item.answer, 120);
    default: return false;
  }
}

export function encodeInteraction(value: Interaction): string {
  if (!isInteraction(value)) throw new Error("互动消息格式无效");
  return PREFIX + JSON.stringify(value);
}

export function decodeInteraction(value: string): Interaction | null {
  if (!value.startsWith(PREFIX) || value.length > 10000) return null;
  try {
    const parsed: unknown = JSON.parse(value.slice(PREFIX.length));
    return isInteraction(parsed) ? parsed : null;
  } catch { return null; }
}

export function interactionText(value: Interaction): string {
  switch (value.type) {
    case "notice.request": return value.text;
    case "notice.ack": return "√";
    case "poll.request": return `${value.question}\n${value.options.map((option, index) => `${index + 1}. ${option}`).join("\n")}`;
    case "poll.answer": return value.answer;
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
    if (!value || value.type === "notice.request" || value.type === "poll.request") continue;
    const request = requests.get(value.replyTo);
    if ((request?.type === "notice.request" && value.type === "notice.ack") ||
        (request?.type === "poll.request" && value.type === "poll.answer" && request.options.includes(value.answer))) answered.add(value.replyTo);
  }
  return [...requests.values()].filter(request => !answered.has(request.id));
}
