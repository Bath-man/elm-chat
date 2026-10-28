import {
  createIdentityKeyPair,
  createAuthenticatedPeerEvent,
  createAgreementKeyPair,
  decryptBytes,
  decryptMessage,
  deriveRoomKey,
  encryptBytes,
  encryptMessage,
  exportIdentityPublicKey,
  exportIdentityPrivateKey,
  exportAgreementPrivateKey,
  exportAgreementPublicKey,
  generateMessageId,
  generateRoomSecret,
  generateSessionId,
  importIdentityPrivateKey,
  importIdentityPublicKey,
  importAgreementPrivateKey,
  sha256Base64Url,
  verifyAuthenticatedPeerEvent,
  unwrapRoomSecret,
  wrapRoomSecret
} from "@elm-chat/crypto";
import {
  FILE_CHUNK_BYTES,
  MESSAGE_PROTOCOL_VERSION,
  isAcquisitionSource,
  isMarketingAcquisitionSource,
  MAX_FILE_BYTES,
  MAX_TRANSCRIPT_SYNC_MESSAGES,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type EncryptedMessageEnvelope,
  type AuthenticatedPeerEvent,
  type PeerDataEvent,
  type PeerFileChunk,
  type PeerDescriptor,
  type PresenceSnapshot,
  type RoomInvite,
  type RoomMetadata,
  type ServerEvent,
} from "@elm-chat/shared";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { encryptedChatIssue } from "./browser-support";
import { ThemeToggle } from "./ThemeToggle";
import { contrastColor, InteractionComposer, InteractionPrompt, MessageEditDialog } from "./InteractionDialogs";
import { MessageBubble, type MessageEntrance } from "./MessageBubble";
import { decodeInteraction, deriveInteractionState, encodeInteraction, isStateInteraction, pendingInteractions, type Interaction } from "./interactions";
import { importHistory, loadHistory, loadHistoryContext, loadHistoryPage, saveHistory, saveReceivedImage, type HistoryCursor, type HistoryMessage } from "./history";
import { decryptHistory, encryptHistory, validateExportPasswords } from "./history-archive";
import { recordGrowthEvent, resolveExternalAcquisitionSource } from "./growth";
import { MarketingPage, type MarketingSlug } from "./MarketingPage";
import { locale, t } from "./localization";
import { InvalidMessageEnvelopeError, receiveTextMessage } from "./message-receive";
import { ReplayGuard } from "./replay";
import { createMessageTransmissions } from "./message-send";
import { handleComposerKeyDown, preserveComposerFocus } from "./composer";
import { ReconnectScheduler } from "./reconnect";
import { loadRoomMetadata, RoomMetadataError } from "./room-metadata";
import { ManualInviteLink } from "./ManualInviteLink";
import { canShareInvite } from "./manual-invite";
import { useConversationScroll } from "./use-conversation-scroll";
import { useConversationFind } from "./use-conversation-find";
import { useConversationConcealment } from "./use-conversation-concealment";

import { decodeImage, encodeImage, readChatImage, ImageMessageAssembler, IMAGE_CHUNK_PREFIX, type ChatImage } from "./image-messages";
import { ImagePreview } from "./ImagePreview";
import { VirtualMessageList, type VirtualMessageNavigation } from "./VirtualMessageList";
import { transcriptBatches } from "./transcript-sync";

type View = "landing" | "marketing" | "room";

type FileTransferState =
  | "offered"
  | "requesting"
  | "transferring"
  | "ready"
  | "sent"
  | "error";

type UiFile = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  state: FileTransferState;
  progress: number;
  url?: string;
  outgoing: boolean;
};

type UiMessage = {
  id: string;
  senderSessionId: string;
  sentAt: number;
  expiresAt?: number;
  delivery?: "pending" | "sent";
  kind: "text" | "file";
  plaintext?: string;
  file?: UiFile;
  imported?: boolean;
  mine?: boolean;
  likes?: number;
  // UI-only; never saved to IndexedDB or sent to a peer.
  entrance?: MessageEntrance;
};

type IncomingFile = {
  name: string;
  mimeType: string;
  size: number;
  totalChunks: number;
  received: number;
  receivedBytes: number;
  chunks: (Uint8Array | undefined)[];
  senderSessionId: string;
  sha256: string;
  keyEpoch: number;
  requested: boolean;
  timeoutId?: number;
};

type ActionFeedback = "idle" | "success";
type InviteFeedback = "idle" | "copied" | "shared";
type InviteAccess = "checking" | "granted" | "invalid" | "claimed" | "used";
type DurationUnit = "minutes" | "hours" | "days";
type DurationDraft = {
  amount: string;
  unit: DurationUnit;
  indefinite: boolean;
};
type InviteDurationDraft = {
  amount: string;
  unit: DurationUnit;
};

type CommunityIssue = {
  number: number;
  title: string;
  url: string;
  date: string;
};

type CommunityFeed = {
  fixes: CommunityIssue[];
  requests: CommunityIssue[];
};

type DurationKind = "message" | "room";

function roomPathname(): { view: View; roomId?: string; marketingSlug?: MarketingSlug } {
  const match = window.location.pathname.match(/^\/c\/([^/]+)$/);
  if (match) {
    return { view: "room", roomId: match[1] };
  }
  const marketingSlug = window.location.pathname.replace(/^\/|\/$/g, "");
  if (isMarketingAcquisitionSource(marketingSlug)) {
    return { view: "marketing", marketingSlug };
  }
  return { view: "landing" };
}

function formatRelativeDuration(target: number): string {
  const deltaSeconds = Math.max(0, Math.floor((target - Date.now()) / 1000));
  const minutes = Math.floor(deltaSeconds / 60);
  const seconds = deltaSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

function formatStaticDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) {
    return "0s";
  }

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

const GITHUB_URL = "https://github.com/shawnbure/elm-chat";

function samePresence(current: PresenceSnapshot, next: PresenceSnapshot): boolean {
  return current.count === next.count &&
    current.connectedSessionIds.length === next.connectedSessionIds.length &&
    current.connectedSessionIds.every(id => next.connectedSessionIds.includes(id));
}

function formatCount(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  const thousands = value / 1000;
  return `${thousands.toFixed(thousands < 10 ? 1 : 0).replace(/\.0$/, "")}k`;
}

function creatorTokenKey(roomId: string): string {
  return `elm-chat:creator:${roomId}`;
}

function sessionKey(roomId: string): string {
  return `elm-chat:session:${roomId}`;
}

function reconnectTokenKey(roomId: string, sessionId: string): string {
  return `elm-chat:reconnect:${roomId}:${sessionId}`;
}

function identityKeyPairKey(roomId: string, sessionId: string): string {
  return `elm-chat:identity:${roomId}:${sessionId}`;
}

function replayStateKey(roomId: string, sessionId: string, kind: "message" | "event"): string {
  return `elm-chat:replay:${kind}:${roomId}:${sessionId}`;
}

// StrictMode can start initialization twice before key generation finishes.
// Both attempts must use the same keys, including the persisted copy.
const identityLoads = new Map<string, ReturnType<typeof readIdentityKeyPair>>();
function loadIdentityKeyPair(roomId: string, sessionId: string) {
  const key = identityKeyPairKey(roomId, sessionId);
  const pending = identityLoads.get(key);
  if (pending) return pending;
  const loading = readIdentityKeyPair(roomId, sessionId);
  identityLoads.set(key, loading);
  void loading.finally(() => identityLoads.delete(key)).catch(() => {});
  return loading;
}

async function readIdentityKeyPair(roomId: string, sessionId: string): Promise<{
  privateKey: CryptoKey;
  publicKey: string;
  agreementPrivateKey: CryptoKey;
  agreementPublicKey: string;
}> {
  const storageKey = identityKeyPairKey(roomId, sessionId);
  const stored = safeStorageGet("local", storageKey) ?? safeStorageGet("session", storageKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as {
        privateKey: JsonWebKey;
        publicKey: string;
        agreementPrivateKey: JsonWebKey;
        agreementPublicKey: string;
      };
      const identity = {
        privateKey: await importIdentityPrivateKey(parsed.privateKey),
        publicKey: parsed.publicKey,
        agreementPrivateKey: await importAgreementPrivateKey(parsed.agreementPrivateKey),
        agreementPublicKey: parsed.agreementPublicKey
      };
      safeStorageSet("local", storageKey, stored);
      return identity;
    } catch {
      // Corrupt local keys cannot be used to recover an admitted identity.
    }
  }
  const [pair, agreementPair] = await Promise.all([
    createIdentityKeyPair(),
    createAgreementKeyPair()
  ]);
  const result = {
    privateKey: pair.privateKey,
    publicKey: await exportIdentityPublicKey(pair.publicKey),
    agreementPrivateKey: agreementPair.privateKey,
    agreementPublicKey: await exportAgreementPublicKey(agreementPair.publicKey)
  };
  safeStorageSet("local", storageKey, JSON.stringify({
    privateKey: await exportIdentityPrivateKey(pair.privateKey),
    publicKey: result.publicKey,
    agreementPrivateKey: await exportAgreementPrivateKey(agreementPair.privateKey),
    agreementPublicKey: result.agreementPublicKey
  }));
  return result;
}

function safeStorageGet(storage: "local" | "session", key: string): string | null {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    return target.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(storage: "local" | "session", key: string, value: string): void {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    target.setItem(key, value);
  } catch {
    // Private browsing and restrictive browser contexts can block storage access.
  }
}

function safeStorageRemove(storage: "local" | "session", key: string): void {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    target.removeItem(key);
  } catch {
    // Storage cleanup is best effort in restrictive browser contexts.
  }
}

function durationUnitLabel(unit: DurationUnit): string {
  switch (unit) {
    case "minutes":
      return t("minutes").toLowerCase();
    case "hours":
      return t("hours").toLowerCase();
    case "days":
      return t("days").toLowerCase();
  }
}

function durationToMs(amount: number, unit: DurationUnit): number {
  switch (unit) {
    case "minutes":
      return amount * 60 * 1000;
    case "hours":
      return amount * 60 * 60 * 1000;
    case "days":
      return amount * 24 * 60 * 60 * 1000;
  }
}

function durationToSeconds(amount: number, unit: DurationUnit): number {
  return Math.floor(durationToMs(amount, unit) / 1000);
}

function formatSelectedDuration(amount: string, unit: DurationUnit, indefinite: boolean): string {
  if (indefinite) {
    return t("indefinite");
  }
  const value = Number(amount) || 0;
  const label = durationUnitLabel(unit);
  return `${value} ${label}`;
}

function parseDurationDraft(
  draft: DurationDraft,
  fallbackValue: number,
  fallbackUnit: DurationUnit,
  kind: "seconds" | "milliseconds"
): number | null {
  if (draft.indefinite) {
    return null;
  }

  const parsed = Number(draft.amount);
  const safeAmount = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
  const unit = draft.unit || fallbackUnit;
  return kind === "seconds"
    ? durationToSeconds(safeAmount, unit)
    : durationToMs(safeAmount, unit);
}

function parseInviteDurationDraft(draft: InviteDurationDraft): number {
  const parsed = Number(draft.amount);
  const safeAmount = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
  return durationToMs(safeAmount, draft.unit || "minutes");
}

function toggleIndefiniteDuration(
  current: DurationDraft,
  checked: boolean,
  fallbackAmount: string
): DurationDraft {
  if (checked) {
    return {
      ...current,
      indefinite: true
    };
  }

  return {
    ...current,
    indefinite: false,
    amount: current.amount || fallbackAmount
  };
}

async function createRoom(body: CreateRoomRequest): Promise<CreateRoomResponse> {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? t("failedCreateRoom"));
  }
  return response.json();
}

async function destroyRoom(roomId: string, creatorToken: string): Promise<RoomMetadata> {
  const response = await fetch(`/api/rooms/${roomId}/destroy`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ creatorToken })
  });
  if (!response.ok) {
    throw new Error(t("destroyRoomFailed"));
  }
  return response.json();
}

async function createInvite(roomId: string, creatorToken: string, ttlMs = 10 * 60 * 1000): Promise<RoomInvite> {
  const response = await fetch(`/api/rooms/${roomId}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creatorToken, ttlMs })
  });
  if (!response.ok) {
    throw new Error(t("createInviteFailed"));
  }
  return response.json();
}

async function listInvites(roomId: string, creatorToken: string): Promise<RoomInvite[]> {
  const response = await fetch(`/api/rooms/${roomId}/invites`, {
    headers: { authorization: `Bearer ${creatorToken}` }
  });
  if (!response.ok) {
    throw new Error(t("failedLoadInvites"));
  }
  return response.json();
}

async function revokeInvite(roomId: string, creatorToken: string, token: string): Promise<void> {
  const response = await fetch(`/api/rooms/${roomId}/invites/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creatorToken, token })
  });
  if (!response.ok) {
    throw new Error(t("revokeInviteFailed"));
  }
}

async function copyText(value: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function wsUrl(path: string): string {
  const url = new URL(window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  return url.toString();
}

function messageStatus(message: UiMessage): string {
  if (message.expiresAt) {
    return t("vanishesIn", { duration: formatRelativeDuration(message.expiresAt) });
  }
  return t("untilRoomCloses");
}

function upsertMessage(messages: UiMessage[], next: UiMessage): UiMessage[] {
  const existingIndex = messages.findIndex((message) => message.id === next.id);
  if (existingIndex === -1) {
    return [...messages, next].sort((left, right) => left.sentAt - right.sentAt);
  }

  const copy = [...messages];
  copy[existingIndex] = {
    ...copy[existingIndex],
    ...next
  };
  return copy;
}

function mergeHistoryMessages(current: UiMessage[], saved: readonly HistoryMessage[]): UiMessage[] {
  const merged = new Map<string, UiMessage>(saved.map(message => [message.id, message]));
  for (const message of current) merged.set(message.id, message);
  return [...merged.values()].sort((a, b) => a.sentAt - b.sentAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function colorFromSessionId(sessionId: string): string {
  let hash = 0;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash = (hash * 31 + sessionId.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  const saturation = 62 + (hash % 12);
  const lightness = 48 + (hash % 10);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function inviteColor(invite: RoomInvite): string {
  return colorFromSessionId(invite.consumedBySessionId ?? invite.token);
}

function bubbleStyle(sessionId: string, mine: boolean): CSSProperties {
  const color = colorFromSessionId(sessionId);
  return {
    "--bubble-accent": color,
    "--bubble-surface": mine ? color : `color-mix(in srgb, ${color}, white 88%)`,
    "--bubble-surface-border": `color-mix(in srgb, ${color}, white 58%)`,
    "--bubble-text": mine ? "#fffaf3" : "var(--ink)"
  } as CSSProperties;
}

function inviteAccentStyle(invite: RoomInvite): CSSProperties | undefined {
  const color = inviteColor(invite);
  return {
    "--invite-accent": color,
    "--invite-surface": `color-mix(in srgb, ${color}, white 84%)`,
    "--invite-border": `color-mix(in srgb, ${color}, white 56%)`
  } as CSSProperties;
}

function inviteStatusLabel(invite: RoomInvite): string {
  if (invite.revokedAt) {
    return t("inviteStatusRevoked");
  }
  if (invite.consumedAt || invite.admittedAt) {
    return t("inviteStatusJoined");
  }
  if (invite.claimedAt) {
    return t("inviteStatusJoining");
  }
  if (invite.expiresAt <= Date.now()) {
    return t("inviteStatusExpired");
  }
  return t("inviteStatusExpires", { duration: formatRelativeDuration(invite.expiresAt) });
}

function buildInviteUrl(roomId: string, inviteToken: string, roomSecret: string): string {
  return `${window.location.origin}/c/${roomId}?invite=${encodeURIComponent(inviteToken)}#${roomSecret}`;
}

function roomStateMessage(status: RoomMetadata["status"], reason?: string): string {
  if (status === "destroyed") {
    return t("destroyed");
  }

  switch (reason) {
    case "join-timeout":
      return t("joinTimeout");
    case "inactive":
      return t("inactive");
    case "max-age":
      return t("maxAge");
    default:
      return t("unavailable");
  }
}

function recordMakeYourOwnClick() {
  recordGrowthEvent("make_your_own_clicked");
}

// Privacy-safe growth callout for an invite recipient. The aggregate event
// records no room, invite, participant, or message identifier.
function MakeYourOwnCallout({ compact = false }: { compact?: boolean }) {
  return (
    <p className={`make-your-own ${compact ? "make-your-own-compact" : ""}`}>
      {compact
        ? t("tryInvite")
        : t("madeWith")}
      <a
        className="make-your-own-link"
        href="/?source=invite"
        onClick={recordMakeYourOwnClick}
        rel={compact ? "noreferrer" : undefined}
        target={compact ? "_blank" : undefined}
      >
        {t("makeYourOwn")}
      </a>
    </p>
  );
}

type RecoveryFocusTarget = { focusRef?: React.RefCallback<HTMLElement> };

function InvalidInviteScreen({ reason, focusRef }: { reason: InviteAccess } & RecoveryFocusTarget) {
  const copy =
    reason === "claimed"
      ? t("inviteClaimed")
      : reason === "used"
        ? t("inviteUsed")
        : t("inviteInvalid");
  return (
    <main className="room-shell room-shell-centered">
      <section className="access-screen" aria-live="polite">
        <p className="eyebrow">elm chat</p>
        <h1 className="access-title" ref={focusRef} tabIndex={-1}>{t("invalidLink")}</h1>
        <p className="access-copy">{copy}</p>
        <a
          className="secondary-button access-home-link"
          href="/?source=invite"
          onClick={recordMakeYourOwnClick}
        >
          {t("backHome")}
        </a>
        <MakeYourOwnCallout />
      </section>
    </main>
  );
}

function RemovedFromRoomScreen({ focusRef }: RecoveryFocusTarget) {
  return (
    <main className="room-shell room-shell-centered">
      <section className="access-screen" aria-live="polite">
        <p className="eyebrow">elm chat</p>
        <h1 className="access-title" ref={focusRef} tabIndex={-1}>{t("removedTitle")}</h1>
        <p className="access-copy">{t("removedCopy")}</p>
        <a
          className="secondary-button access-home-link"
          href="/?source=invite"
          onClick={recordMakeYourOwnClick}
        >
          {t("backHome")}
        </a>
        <MakeYourOwnCallout />
      </section>
    </main>
  );
}

function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="currentColor" height={size} viewBox="0 0 16 16" width={size}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function FileCard({ file, onDownload }: { file: UiFile; onDownload: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const progress = file.progress ?? 0;
  const percent = Number.isFinite(progress) ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : 0;
  return (
    <div aria-label={t("fileCardLabel", { name: file.name })} className="file-card" ref={cardRef} role="group" tabIndex={-1}>
      <div className="file-card-head">
        <span className="file-icon" aria-hidden="true">
          &#128206;
        </span>
        <div className="file-meta">
          <span className="file-name">{file.name}</span>
          <span className="file-size">{formatBytes(file.size)}</span>
        </div>
      </div>
      {file.outgoing ? (
        <span className="file-status">{t("fileShared")}</span>
      ) : file.state === "offered" ? (
        <button aria-label={t("downloadFileLabel", { name: file.name })} className="secondary-button file-action" onClick={(event) => {
          // Preserve the initiating control's focus before progress replaces it.
          if (document.activeElement === event.currentTarget) cardRef.current?.focus({ preventScroll: true });
          onDownload();
        }} type="button">
          {t("download")}
        </button>
      ) : file.state === "requesting" || file.state === "transferring" ? (
        <div
          aria-label={t("fileProgressLabel", { name: file.name })}
          aria-live="off"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="file-progress"
          role="progressbar"
        >
          <div className="file-progress-track">
            <div className="file-progress-bar" style={{ width: `${percent}%` }} />
          </div>
          <span className="file-progress-label">{percent}%</span>
        </div>
      ) : file.state === "ready" && file.url ? (
        <a aria-label={t("saveFileLabel", { name: file.name })} className="secondary-button file-action" download={file.name} href={file.url}>
          {t("saveFile")}
        </a>
      ) : file.state === "error" ? (
        <span className="file-status file-status-error">{t("transferFailed")}</span>
      ) : null}
    </div>
  );
}

function InviteCheckingScreen({ connection, error, onRetry, focusRef, restoring = false }: {
  connection: string;
  error: string | null;
  onRetry?: () => void;
  restoring?: boolean;
} & RecoveryFocusTarget) {
  return (
    <main className="room-shell room-shell-centered">
      <section className="access-screen" aria-live="polite">
        <p className="eyebrow">elm chat</p>
        <h1 className="access-title">{t(restoring ? "restoringSession" : "checkingInvite")}</h1>
        <p className="access-copy">{t(restoring ? "restoringSessionCopy" : "verifyingInvite")}</p>
        <p ref={focusRef} tabIndex={-1}>{connection}</p>
        {error ? <p className="error-text" role="alert">{error}</p> : null}
        {onRetry ? <button className="secondary-button" onClick={onRetry} type="button">{t("retryConnection")}</button> : null}
        <MakeYourOwnCallout />
      </section>
    </main>
  );
}

export function RoomGoneScreen({ fromInvite, reason, focusRef, onViewHistory, historyLoaded }: {
  fromInvite: boolean; reason?: string; onViewHistory: () => void; historyLoaded: boolean;
} & RecoveryFocusTarget) {
  return (
    <main className="room-shell room-shell-centered">
      <section className="access-screen" aria-live="polite">
        <p className="eyebrow">elm chat</p>
        <h1 className="access-title" ref={focusRef} tabIndex={-1}>{t("roomGone")}</h1>
        <p className="access-copy">
          {reason ?? t("roomGoneCopy")}
        </p>
        <a
          className="primary-button access-home-link"
          href={fromInvite ? "/?source=invite" : "/"}
          onClick={fromInvite ? recordMakeYourOwnClick : undefined}
        >
          {t("startNew")} &rarr;
        </a>
        <button className="secondary-button" type="button" disabled={!historyLoaded} onClick={onViewHistory}>查看本地记录</button>
        <p className="access-copy">本地记录仍保留，可查看、导入和导出。继续聊天请创建新房间。</p>
        {fromInvite ? <MakeYourOwnCallout /> : null}
      </section>
    </main>
  );
}

export function App() {
  const route = roomPathname();
  useEffect(() => {
    const previousLanguage = document.documentElement.lang;
    // Marketing articles are English; the landing and room UI use the catalog locale.
    document.documentElement.lang = route.view === "marketing" ? "en" : "zh-CN";
    return () => {
      document.documentElement.lang = previousLanguage;
    };
  }, [route.view]);
  const cryptoIssue = encryptedChatIssue(window.isSecureContext, globalThis.crypto);
  if (route.view !== "marketing" && cryptoIssue) {
    return <main className="room-shell room-shell-centered">
      <section className="access-screen">
        <h1>无法建立安全聊天</h1>
        <p className="error-text" role="alert">{cryptoIssue}</p>
        <p className="access-copy">请使用手机系统浏览器打开 HTTPS 链接，不要使用普通 HTTP 局域网地址。</p>
      </section>
    </main>;
  }
  if (route.view === "room" && route.roomId) {
    return <RoomPage roomId={route.roomId} />;
  }
  if (route.view === "marketing" && route.marketingSlug) {
    const sourceParam = new URLSearchParams(window.location.search).get("source");
    const externalSource = resolveExternalAcquisitionSource(sourceParam, document.referrer);
    return <MarketingPage externalSource={externalSource} slug={route.marketingSlug} />;
  }
  return <LandingPage />;
}

function LandingPage() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const secret = generateRoomSecret();
      const room = await createRoom({
        disappearAfterReadSeconds: null, inactivityTimeoutMs: null, maxAgeMs: null
      });
      safeStorageSet("local", creatorTokenKey(room.roomId), room.creatorToken);
      window.location.assign(`${room.roomUrl}#${secret}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建失败，请重试");
      setCreating(false);
    }
  }
  return <main className="landing-shell">
    <div className="landing-heading"><p className="eyebrow">elm · 匿名聊天</p><ThemeToggle /></div>
    <h1>只与你，聊一会。</h1>
    <p>无需注册。创建房间，把邀请链接发给另一个人。</p>
    <button className="primary-button" disabled={creating} onClick={handleCreate}>
      {creating ? "正在创建…" : "创建聊天房间"}
    </button>
    {error && <p className="error-text" role="alert">{error}</p>}
    <p className="privacy-note">端到端加密 · 仅限两人 · 记录仅保存在本机<br />
      请勿在公用设备上使用；清理浏览器数据会删除本地记录。</p>
    <a className="source-link" href="/source.zip">项目源代码 · AGPL-3.0</a>
  </main>;
}

function RoomPage({ roomId }: { roomId: string }) {
  const roomSecret = window.location.hash.replace(/^#/, "");
  const inviteToken = new URLSearchParams(window.location.search).get("invite") ?? "";
  const storedCreatorToken = safeStorageGet("local", creatorTokenKey(roomId)) ?? "";
  const isInviteGuest = Boolean(inviteToken && !storedCreatorToken);
  const [room, setRoom] = useState<RoomMetadata | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [hiddenHistoryIds, setHiddenHistoryIds] = useState<ReadonlySet<string>>(new Set());
  const historyCursorRef = useRef<HistoryCursor | undefined>(undefined);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const loadingHistoryRef = useRef(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [archiveMode, setArchiveMode] = useState<"export" | "import" | null>(null);
  const [archivePassword, setArchivePassword] = useState("");
  const [archiveConfirmation, setArchiveConfirmation] = useState("");
  const [previewImage, setPreviewImage] = useState<ChatImage | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageAssemblerRef = useRef(new ImageMessageAssembler());
  const virtualMessagesRef = useRef<VirtualMessageNavigation | null>(null);
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveFeedback, setArchiveFeedback] = useState<string | null>(null);
  const [showInteractions, setShowInteractions] = useState(false);
  const [composerKind, setComposerKind] = useState<"notice" | "poll" | "pin" | "hidden">("notice");
  const [showMore, setShowMore] = useState(false);
  const [editingMessage, setEditingMessage] = useState<UiMessage | null>(null);
  const outgoingQueueRef = useRef<Promise<void>>(Promise.resolve());
  const interactionState = useMemo(() => deriveInteractionState(messages.filter(message => !message.imported)), [messages]);
  const visibleMessages = useMemo(() => messages.filter(message => {
    if (message.kind !== "text") return false;
    if (hiddenHistoryIds.has(message.id)) return false;
    const value = decodeInteraction(message.plaintext ?? "");
    return !value || !isStateInteraction(value);
  }), [messages, hiddenHistoryIds]);
  const [invites, setInvites] = useState<RoomInvite[]>([]);
  const [manualInvite, setManualInvite] = useState<{ token: string; trigger: HTMLButtonElement; focusOwner: Element | null } | null>(null);
  const inviteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inviteActionRef = useRef(0);
  const currentInvitesRef = useRef(invites);
  currentInvitesRef.current = invites;
  const [draft, setDraft] = useState("");
  const draftRevisionRef = useRef(0);
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState(t("connecting"));
  const [canRetryConnection, setCanRetryConnection] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const retryConnectionRef = useRef<(() => void) | null>(null);
  const stopConnectionRef = useRef<(() => void) | null>(null);
  const retryFocusTargetRef = useRef<HTMLElement | null>(null);
  const preserveRetryFocusRef = useRef(false);
  const setRetryFocusTarget = useCallback((element: HTMLElement | null) => {
    if (!element) {
      // Follow a replacement view only while the manually focused status owns focus.
      preserveRetryFocusRef.current = preserveRetryFocusRef.current &&
        document.activeElement === retryFocusTargetRef.current;
    }
    retryFocusTargetRef.current = element;
    if (element && preserveRetryFocusRef.current) element.focus();
  }, []);
  const [keyReady, setKeyReady] = useState(false);
  const [presence, setPresence] = useState<PresenceSnapshot>({ count: 0, connectedSessionIds: [] });
  const [now, setNow] = useState(Date.now());
  const conversationFind = useConversationFind(visibleMessages, now, (id) => {
    virtualMessagesRef.current?.scrollToMessage(id);
    handleConversationScroll();
  });
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const concealment = useConversationConcealment(() => conversationFind.close());
  const [notFound, setNotFound] = useState(false);
  const [viewLocalHistory, setViewLocalHistory] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<ActionFeedback>("idle");
  const [destroyFeedback, setDestroyFeedback] = useState<ActionFeedback>("idle");
  const [inviteFeedback, setInviteFeedback] = useState<InviteFeedback>("idle");
  const [destroying, setDestroying] = useState(false);
  const [inviteAccess, setInviteAccess] = useState<InviteAccess>(isInviteGuest ? "checking" : "granted");
  const [removedFromRoom, setRemovedFromRoom] = useState(false);
  const [inviteDuration, setInviteDuration] = useState<InviteDurationDraft>({
    amount: "10",
    unit: "minutes"
  });
  const [sessionId] = useState(() => {
    const stored = safeStorageGet("local", sessionKey(roomId)) ?? safeStorageGet("session", sessionKey(roomId));
    if (stored) {
      safeStorageSet("local", sessionKey(roomId), stored);
      return stored;
    }
    const next = generateSessionId();
    safeStorageSet("local", sessionKey(roomId), next);
    return next;
  });
  const reconnectTokenRef = useRef(safeStorageGet("local", reconnectTokenKey(roomId, sessionId)) ?? "");
  const [restoringSession] = useState(() => Boolean(reconnectTokenRef.current));
  useEffect(() => {
    let active = true;
    Promise.all([loadHistoryPage(roomId, sessionId), loadHistoryContext(roomId, sessionId)]).then(([page, context]) => {
      if (!active) return;
      historyCursorRef.current = page.messages[0];
      const pageIds = new Set(page.messages.map(message => message.id));
      setHiddenHistoryIds(new Set(context.filter(message => !pageIds.has(message.id)).map(message => message.id)));
      setHasMoreHistory(page.hasMore);
      setMessages(current => mergeHistoryMessages(current, [...page.messages, ...context]));
      setHistoryLoaded(true);
    }).catch(() => {
      if (active) setError("无法打开本地记录。请允许浏览器使用 IndexedDB 后刷新页面。");
    });
    return () => { active = false; };
  }, [roomId, sessionId]);

  const creatorToken = storedCreatorToken;
  const socketRef = useRef<WebSocket | null>(null);
  const roomKeyRef = useRef<CryptoKey | null>(null);
  const roomKeysRef = useRef(new Map<number, CryptoKey>());
  const keyEpochRef = useRef(1);
  const keyReadyRef = useRef(false);
  const membershipVersionRef = useRef(0);
  const keyWorkGenerationRef = useRef(0);
  const identityKeyRef = useRef<string>("");
  const identityPrivateKeyRef = useRef<CryptoKey | null>(null);
  const agreementPrivateKeyRef = useRef<CryptoKey | null>(null);
  const agreementPublicKeyRef = useRef<string>("");
  const peerIdentityKeysRef = useRef(new Map<string, string>());
  const peersRef = useRef(new Map<string, PeerDescriptor>());
  const joinedRef = useRef(false);
  // Mirror of the latest room status so the socket close handler (captured once
  // by the connection effect) can distinguish a live-room drop from an
  // already-closed room without reading a stale `room` value.
  const roomStatusRef = useRef<RoomMetadata["status"] | null>(null);
  const { chatLogRef, awayFromLatest, newMessageCount, jumpToLatest, handleConversationScroll, preserveHistoryPosition } =
    useConversationScroll(visibleMessages, ready, conversationFind.open || concealment.hidden);
  const messageRef = useRef(new Map<string, AuthenticatedPeerEvent>());
  const pendingEnvelopesRef = useRef(new Map<string, { event: AuthenticatedPeerEvent; animate: boolean; recoverImageReplay?: boolean }>());
  const replayGuardRef = useRef<ReplayGuard | null>(null);
  const eventReplayGuardRef = useRef<ReplayGuard | null>(null);
  if (!replayGuardRef.current) {
    replayGuardRef.current = new ReplayGuard(
      10000,
      window.sessionStorage,
      replayStateKey(roomId, sessionId, "message")
    );
  }
  if (!eventReplayGuardRef.current) {
    eventReplayGuardRef.current = new ReplayGuard(
      10000,
      window.sessionStorage,
      replayStateKey(roomId, sessionId, "event")
    );
  }
  const measuredInviteHandoffsRef = useRef(new Set<string>());
  const shouldRequestSyncRef = useRef(false);
  // Files being served by this client (we are the sender), kept in memory so we
  // can stream chunks on demand when a peer requests them.
  const outgoingFilesRef = useRef(new Map<string, File>());
  const outgoingFileHashesRef = useRef(new Map<string, string>());
  const outgoingFileEpochsRef = useRef(new Map<string, number>());
  // Files being received by this client, accumulating decrypted chunks.
  const incomingFilesRef = useRef(new Map<string, IncomingFile>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Object URLs created for received files, revoked on expiry/unmount.
  const objectUrlsRef = useRef(new Set<string>());

  async function sendPeerData(payload: PeerDataEvent, toSessionId?: string, isCurrent?: () => boolean) {
    const socket = socketRef.current;
    const privateKey = identityPrivateKeyRef.current;
    if (socket?.readyState !== WebSocket.OPEN || !joinedRef.current || !privateKey || (isCurrent && !isCurrent())) return null;
    const data = await createAuthenticatedPeerEvent(
      privateKey,
      roomId,
      sessionId,
      toSessionId ?? null,
      payload
    );
    // Signing yields to the browser; the connection may close before it finishes.
    if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN || !joinedRef.current || (isCurrent && !isCurrent())) return null;
    socket.send(JSON.stringify({ type: "peer_data", toSessionId, data }));
    eventReplayGuardRef.current?.markLocal(data.eventId);
    return data;
  }

  async function sendTranscript(peerId: string) {
    const transcript = [...messageRef.current.values()]
      .sort((left, right) => left.sentAt - right.sentAt)
      .slice(-MAX_TRANSCRIPT_SYNC_MESSAGES);
    for (const batch of transcriptBatches(transcript)) {
      await waitForSocketDrain();
      await sendPeerData({
        type: "sync_response", messages: batch, completeness: "peer-partial",
        truncated: messageRef.current.size > MAX_TRANSCRIPT_SYNC_MESSAGES
      }, peerId);
    }
  }

  function currentKeyLeader(): PeerDescriptor | undefined {
    return [...peersRef.current.values()].sort((left, right) =>
      Number(right.creator) - Number(left.creator) ||
      left.connectedAt - right.connectedAt ||
      left.sessionId.localeCompare(right.sessionId)
    )[0];
  }

  // Crypto can finish after a disconnect, a new membership, or effect cleanup.
  function captureKeyWork(keyEpoch: number, leader: PeerDescriptor): () => boolean {
    const socket = socketRef.current;
    const generation = keyWorkGenerationRef.current;
    return () => {
      const currentLeader = currentKeyLeader();
      return generation === keyWorkGenerationRef.current &&
        socket !== null && socketRef.current === socket && socket.readyState === WebSocket.OPEN &&
        joinedRef.current && roomStatusRef.current === "open" &&
        membershipVersionRef.current === keyEpoch &&
        currentLeader?.sessionId === leader.sessionId &&
        currentLeader.identityKey === leader.identityKey &&
        currentLeader.agreementKey === leader.agreementKey;
    };
  }

  async function rotateRoomKey(keyEpoch: number) {
    const leader = currentKeyLeader();
    const agreementPrivateKey = agreementPrivateKeyRef.current;
    if (!leader || leader.sessionId !== sessionId || !agreementPrivateKey) return;
    const isCurrent = captureKeyWork(keyEpoch, leader);
    if (!isCurrent()) return;
    const roomSecretForEpoch = generateRoomSecret();
    const nextKey = await deriveRoomKey(roomSecretForEpoch);
    if (!isCurrent()) return;
    roomKeysRef.current.set(keyEpoch, nextKey);
    roomKeyRef.current = nextKey;
    keyEpochRef.current = keyEpoch;
    await Promise.all([...peersRef.current.values()]
      .filter((peer) => peer.sessionId !== sessionId)
      .map(async (peer) => {
        const wrapped = await wrapRoomSecret(
          agreementPrivateKey,
          peer.agreementKey,
          roomId,
          keyEpoch,
          sessionId,
          peer.sessionId,
          roomSecretForEpoch
        );
        if (!isCurrent()) return;
        await sendPeerData({
          type: "key_rotation",
          keyEpoch,
          senderAgreementKey: agreementPublicKeyRef.current,
          ...wrapped
        }, peer.sessionId, isCurrent);
      }));
    if (!isCurrent()) return;
    keyReadyRef.current = true;
    setKeyReady(true);
    setConnection(t("connected"));
  }

  function beginMembershipChange(keyEpoch: number) {
    if (keyEpoch <= membershipVersionRef.current) return;
    membershipVersionRef.current = keyEpoch;
    keyReadyRef.current = false;
    setKeyReady(false);
    setConnection(t("securing"));
    void rotateRoomKey(keyEpoch);
  }

  function clearRoomSecurityState(preserveSession = false, preserveBrowserData = false) {
    conversationFind.close();
    setPreviewImage(null);
    imageAssemblerRef.current.clear();
    for (const [fileId, transfer] of incomingFilesRef.current) removeIncomingFile(fileId, transfer);
    if (!preserveBrowserData) {
      replayGuardRef.current?.clear();
      eventReplayGuardRef.current?.clear();
    }
    roomKeysRef.current.clear();
    pendingEnvelopesRef.current.clear();
    keyReadyRef.current = false;
    setKeyReady(false);
    if (!preserveSession && !preserveBrowserData) {
      reconnectTokenRef.current = "";
      safeStorageRemove("local", reconnectTokenKey(roomId, sessionId));
      safeStorageRemove("local", identityKeyPairKey(roomId, sessionId));
      safeStorageRemove("local", sessionKey(roomId));
      safeStorageRemove("session", identityKeyPairKey(roomId, sessionId));
      safeStorageRemove("session", sessionKey(roomId));
    }
  }

  async function refreshInvites() {
    if (!creatorToken) {
      return;
    }
    try {
      const nextInvites = await listInvites(roomId, creatorToken);
      currentInvitesRef.current = nextInvites;
      setInvites(nextInvites);
    } catch {
      // Keep the last known invite state if the refresh fails.
    }
  }

  function updateFileMessage(fileId: string, patch: Partial<UiFile>) {
    startTransition(() => {
      setMessages((current) =>
        current.map((message) =>
          message.kind === "file" && message.file?.fileId === fileId
            ? { ...message, file: { ...message.file, ...patch } }
            : message
        )
      );
    });
  }

  function removeIncomingFile(fileId: string, entry = incomingFilesRef.current.get(fileId)) {
    if (!entry) return;
    if (entry.timeoutId !== undefined) window.clearTimeout(entry.timeoutId);
    entry.timeoutId = undefined;
    if (incomingFilesRef.current.get(fileId) === entry) incomingFilesRef.current.delete(fileId);
  }

  function armFileTimeout(fileId: string, entry: IncomingFile) {
    if (!entry.requested || incomingFilesRef.current.get(fileId) !== entry) return;
    if (entry.timeoutId !== undefined) window.clearTimeout(entry.timeoutId);
    const timeoutId = window.setTimeout(() => {
      // A cleared/queued callback must not remove a replacement or refreshed transfer.
      if (incomingFilesRef.current.get(fileId) !== entry || entry.timeoutId !== timeoutId) return;
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      void sendPeerData({ type: "file_cancel", fileId, reason: "timeout" }, entry.senderSessionId);
    }, 30_000);
    entry.timeoutId = timeoutId;
  }

  async function waitForSocketDrain() {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    const maxBuffer = 4 * 1024 * 1024;
    while (socket.bufferedAmount > maxBuffer && socket.readyState === WebSocket.OPEN) {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
  }

  // Sender side: stream an outgoing file to the requesting peer as encrypted chunks.
  async function serveFile(fileId: string, requesterSessionId: string) {
    const file = outgoingFilesRef.current.get(fileId);
    const keyEpoch = outgoingFileEpochsRef.current.get(fileId);
    const key = typeof keyEpoch === "number" ? roomKeysRef.current.get(keyEpoch) : undefined;
    if (!file || !key) {
      return;
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    const totalChunks = Math.max(1, Math.ceil(buffer.byteLength / FILE_CHUNK_BYTES));
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * FILE_CHUNK_BYTES;
      const slice = buffer.subarray(start, Math.min(start + FILE_CHUNK_BYTES, buffer.byteLength));
      const { ciphertext, nonce } = await encryptBytes(key, slice);
      await waitForSocketDrain();
      const delivered = await sendPeerData(
        { type: "file_chunk", fileId, chunkIndex: index, totalChunks, ciphertext, nonce, keyEpoch: keyEpoch! },
        requesterSessionId
      );
      if (!delivered) {
        return;
      }
    }
    const sha256 = outgoingFileHashesRef.current.get(fileId);
    if (sha256) await sendPeerData({ type: "file_complete", fileId, sha256 }, requesterSessionId);
  }

  // Receiver side: decrypt and store an incoming chunk, updating transfer progress.
  async function receiveChunk(payload: PeerFileChunk) {
    const key = roomKeysRef.current.get(payload.keyEpoch);
    if (!key) {
      return;
    }
    const entry = incomingFilesRef.current.get(payload.fileId);
    if (!entry?.requested) return;
    if (entry.keyEpoch !== payload.keyEpoch) return;
    if (entry.chunks.length !== payload.totalChunks) {
      entry.chunks = new Array<Uint8Array | undefined>(payload.totalChunks);
      entry.received = 0;
      entry.receivedBytes = 0;
      entry.totalChunks = payload.totalChunks;
    }
    if (!entry.chunks[payload.chunkIndex]) {
      try {
        const chunk = await decryptBytes(key, payload.ciphertext, payload.nonce);
        if (incomingFilesRef.current.get(payload.fileId) !== entry) return;
        if (entry.receivedBytes + chunk.byteLength > entry.size || chunk.byteLength > FILE_CHUNK_BYTES) {
          throw new Error("File chunk exceeds declared bounds.");
        }
        entry.chunks[payload.chunkIndex] = chunk;
        entry.received += 1;
        entry.receivedBytes += chunk.byteLength;
      } catch {
        if (incomingFilesRef.current.get(payload.fileId) !== entry) return;
        removeIncomingFile(payload.fileId, entry);
        updateFileMessage(payload.fileId, { state: "error" });
        return;
      }
    }
    updateFileMessage(payload.fileId, {
      state: "transferring",
      progress: entry.totalChunks ? entry.received / entry.totalChunks : 0
    });
    armFileTimeout(payload.fileId, entry);
  }

  // Receiver side: reassemble a completed file into a downloadable blob URL.
  async function finalizeIncoming(fileId: string, announcedSha256: string) {
    const entry = incomingFilesRef.current.get(fileId);
    if (!entry?.requested) return;
    if (entry.timeoutId !== undefined) window.clearTimeout(entry.timeoutId);
    entry.timeoutId = undefined;
    if (entry.totalChunks === 0 || entry.received < entry.totalChunks) {
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      return;
    }
    const parts = entry.chunks.filter((chunk): chunk is Uint8Array => Boolean(chunk));
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const digest = await sha256Base64Url(bytes);
    if (incomingFilesRef.current.get(fileId) !== entry) return;
    if (bytes.byteLength !== entry.size || digest !== entry.sha256 || digest !== announcedSha256) {
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      await sendPeerData({ type: "file_cancel", fileId, reason: "integrity" }, entry.senderSessionId);
      return;
    }
    const blob = new Blob(parts as BlobPart[], { type: entry.mimeType });
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);
    removeIncomingFile(fileId, entry);
    updateFileMessage(fileId, { state: "ready", progress: 1, url });
  }

  async function handleAttachFiles(fileList: FileList | null) {
    if (!fileList || !room || room.status !== "open" || !keyReadyRef.current) {
      return;
    }
    for (const file of Array.from(fileList)) {
      if (file.size > MAX_FILE_BYTES) {
        setError(t("fileTooLarge", { name: file.name, limit: formatBytes(MAX_FILE_BYTES) }));
        continue;
      }
      const fileId = generateMessageId();
      const sentAt = Date.now();
      const mimeType = file.type || "application/octet-stream";
      const expiresAfterReadSeconds = room.disappearAfterReadSeconds ?? null;
      const expiresAt =
        typeof expiresAfterReadSeconds === "number"
          ? sentAt + expiresAfterReadSeconds * 1000
          : undefined;
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = await sha256Base64Url(fileBytes);
      outgoingFilesRef.current.set(fileId, file);
      outgoingFileHashesRef.current.set(fileId, sha256);
      outgoingFileEpochsRef.current.set(fileId, keyEpochRef.current);
      setError(null);
      jumpToLatest();
      startTransition(() => {
        setMessages((current) =>
          upsertMessage(current, {
            id: fileId,
            senderSessionId: sessionId,
            sentAt,
            expiresAt,
            kind: "file",
            file: {
              fileId,
              name: file.name,
              mimeType,
              size: file.size,
              state: "sent",
              progress: 1,
              outgoing: true
            }
          })
        );
      });
      const delivered = await sendPeerData({
        type: "file_offer",
        fileId,
        senderSessionId: sessionId,
        name: file.name,
        mimeType,
        size: file.size,
        sentAt,
        expiresAfterReadSeconds,
        sha256,
        keyEpoch: keyEpochRef.current
      });
      if (!delivered) {
        setError(t("fileDeliveryPending"));
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleRequestFile(fileId: string, senderSessionId: string) {
    const entry = incomingFilesRef.current.get(fileId);
    if (!entry || entry.senderSessionId !== senderSessionId || entry.requested) return;
    entry.requested = true;
    armFileTimeout(fileId, entry);
    updateFileMessage(fileId, { state: "transferring", progress: 0 });
    const requested = await sendPeerData({ type: "file_request", fileId }, senderSessionId);
    if (!requested && incomingFilesRef.current.get(fileId) === entry) {
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      setError(t("fileRequestFailed"));
    }
  }

  useEffect(() => {
    if (!roomSecret) {
      setError(t("missingSecret"));
      return;
    }

    let active = true;
    let reconnectAllowed = true;
    let bootstrapping = false;
    let slowRetry: ReturnType<typeof setTimeout> | null = null;
    const connectionAllowed = () => active && reconnectAllowed &&
      (roomStatusRef.current === null || roomStatusRef.current === "open");
    const reconnect = new ReconnectScheduler(
      connectionAllowed,
      () => { void bootstrap(); },
      (delay) => {
        setCanRetryConnection(false);
        setConnection(t("reconnecting", { seconds: Math.ceil(delay / 1000) }));
      }
    );
    function clearSlowRetry() {
      if (slowRetry !== null) clearTimeout(slowRetry);
      slowRetry = null;
    }
    function scheduleReconnect() {
      if (reconnect.schedule()) return true;
      // Keep recovery automatic after the fast retry budget, even when a server
      // outage does not produce a browser `online` event. Manual retry stays available.
      if (reconnect.canRetry && slowRetry === null) {
        slowRetry = setTimeout(() => {
          slowRetry = null;
          reconnect.retryNow();
        }, 30000);
      }
      return false;
    }
    function stopReconnecting() {
      for (const [fileId, transfer] of incomingFilesRef.current) removeIncomingFile(fileId, transfer);
      keyWorkGenerationRef.current += 1;
      reconnectAllowed = false;
      reconnect.cancel();
      clearSlowRetry();
      if (active) setCanRetryConnection(false);
    }
    stopConnectionRef.current = stopReconnecting;
    const onOnline = () => {
      if (!joinedRef.current && reconnect.canRetry) {
        clearSlowRetry();
        reconnect.retryNow();
      }
    };
    const onOffline = () => {
      if (connectionAllowed()) socketRef.current?.close();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    retryConnectionRef.current = () => {
      if (!reconnect.canRetry) return;
      const focusTarget = retryFocusTargetRef.current;
      focusTarget?.focus({ preventScroll: true });
      preserveRetryFocusRef.current = Boolean(focusTarget && document.activeElement === focusTarget);
      setCanRetryConnection(false);
      setConnectionError(null);
      setConnection(t("connecting"));
      clearSlowRetry();
      reconnect.retryNow();
    };
    const tick = window.setInterval(() => setNow(Date.now()), 1000);

    async function bootstrap() {
      if (!connectionAllowed() || bootstrapping ||
        (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN)) return;
      bootstrapping = true;
      if (reconnectTokenRef.current) setConnection(t("restoringSession"));
      try {
        const [metadata, key, identity] = await Promise.all([
          loadRoomMetadata(roomId),
          deriveRoomKey(roomSecret),
          loadIdentityKeyPair(roomId, sessionId)
        ]);
        if (!connectionAllowed()) {
          return;
        }
        roomKeyRef.current = key;
        roomKeysRef.current.set(0, key);
        identityPrivateKeyRef.current = identity.privateKey;
        identityKeyRef.current = identity.publicKey;
        agreementPrivateKeyRef.current = identity.agreementPrivateKey;
        agreementPublicKeyRef.current = identity.agreementPublicKey;
        peerIdentityKeysRef.current.set(sessionId, identity.publicKey);
        roomStatusRef.current = metadata.status;
        setRoom(metadata);
        if (metadata.status !== "open") {
          stopReconnecting();
          clearRoomSecurityState(true, true);
          setReady(true);
          setConnection(t("closed"));
          setRoomNotice(roomStateMessage(metadata.status));
          return;
        }

        const restoring = Boolean(reconnectTokenRef.current);
        if (!reconnectTokenRef.current) {
          // Save the secret before admission: losing the first `joined` frame
          // must not strand a seat whose one-time invite was already consumed.
          reconnectTokenRef.current = generateRoomSecret();
          safeStorageSet("local", reconnectTokenKey(roomId, sessionId), reconnectTokenRef.current);
        }
        const socket = new WebSocket(wsUrl(`/api/rooms/${roomId}/ws`));
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (!connectionAllowed() || socketRef.current !== socket) return;
          setConnection(t(restoring ? "restoringSession" : "deriving"));
          joinedRef.current = false;
          socket.send(
            JSON.stringify({
              type: "join",
              sessionId,
              identityKey: identityKeyRef.current,
              agreementKey: agreementPublicKeyRef.current,
              creatorToken: creatorToken || undefined,
              inviteToken: inviteToken || undefined,
              reconnectToken: reconnectTokenRef.current || undefined
            })
          );
        });

        socket.addEventListener("close", (closeEvent) => {
          if (!active || socketRef.current !== socket) return;
          keyWorkGenerationRef.current += 1;
          joinedRef.current = false;
          keyReadyRef.current = false;
          setKeyReady(false);
          if (!reconnectAllowed) return;
          if (isInviteGuest && closeEvent.code === 4403) {
            stopReconnecting();
            setInviteAccess((current) => {
              if (current === "claimed" || current === "used") {
                return current;
              }
              if (closeEvent.reason === "invite claimed") {
                return "claimed";
              }
              if (closeEvent.reason === "invite used") {
                return "used";
              }
              return "invalid";
            });
            setError(null);
            setRoom(null);
            setRoomNotice(null);
            setReady(true);
            return;
          }
          if (scheduleReconnect()) return;
          setCanRetryConnection(reconnect.canRetry);
          setConnection(roomStatusRef.current === "open" ? t("disconnected") : t("closed"));
        });

        socket.addEventListener("error", () => {
          if (!connectionAllowed() || socketRef.current !== socket) return;
          setConnection(t("connectionError"));
        });

        socket.addEventListener("message", async (event) => {
          if (!connectionAllowed() || socketRef.current !== socket) return;
          const payload = JSON.parse(String(event.data)) as ServerEvent;
          if (payload.type === "joined") {
            if (payload.reconnectToken) {
              reconnectTokenRef.current = payload.reconnectToken;
              safeStorageSet("local", reconnectTokenKey(roomId, sessionId), payload.reconnectToken);
            }
            joinedRef.current = true;
            reconnect.reset();
            clearSlowRetry();
            setCanRetryConnection(false);
            setConnectionError(null);
            setError(null);
            startTransition(() => {
              setInviteAccess("granted");
              setRoom(payload.room);
              setPresence(current => samePresence(current, payload.presence) ? current : payload.presence);
              setReady(true);
            });
            if (creatorToken) {
              void refreshInvites();
            }
            peersRef.current.clear();
            peersRef.current.set(sessionId, payload.self);
            for (const peer of payload.peers) {
              peersRef.current.set(peer.sessionId, peer);
              peerIdentityKeysRef.current.set(peer.sessionId, peer.identityKey);
            }
            beginMembershipChange(payload.room.membershipVersion);
            shouldRequestSyncRef.current = payload.peers.length > 0;
            if (payload.peers.length > 0 && keyReadyRef.current) {
              await sendPeerData({ type: "sync_request" });
            }
            return;
          }

          if (payload.type === "presence") {
            startTransition(() => setPresence(current => samePresence(current, payload.presence) ? current : payload.presence));
            if (creatorToken) {
              void refreshInvites();
            }
            return;
          }

          if (payload.type === "peer_joined") {
            peerIdentityKeysRef.current.set(payload.peer.sessionId, payload.peer.identityKey);
            peersRef.current.set(payload.peer.sessionId, payload.peer);
            beginMembershipChange(payload.membershipVersion);
            startTransition(() =>
              setPresence((current) => current.connectedSessionIds.includes(payload.peer.sessionId) ? current : ({
                count: current.count + 1,
                connectedSessionIds: [...current.connectedSessionIds, payload.peer.sessionId]
              }))
            );
            if (creatorToken) {
              void refreshInvites();
            }
            if (messageRef.current.size > 0) {
              await sendTranscript(payload.peer.sessionId);
            }
            return;
          }

          if (payload.type === "peer_left") {
            peersRef.current.delete(payload.sessionId);
            beginMembershipChange(payload.membershipVersion);
            startTransition(() =>
              setPresence((current) => {
                if (!current.connectedSessionIds.includes(payload.sessionId)) return current;
                const nextIds = current.connectedSessionIds.filter((id) => id !== payload.sessionId);
                return {
                  count: nextIds.length,
                  connectedSessionIds: nextIds
                };
              })
            );
            if (creatorToken) {
              void refreshInvites();
            }
            for (const [fileId, transfer] of incomingFilesRef.current) {
              if (transfer.senderSessionId === payload.sessionId) {
                removeIncomingFile(fileId, transfer);
                updateFileMessage(fileId, { state: "error" });
              }
            }
            return;
          }

          if (payload.type === "peer_data") {
            await handlePeerData(payload.fromSessionId, payload.data, socket);
            return;
          }

          if (payload.type === "room_state") {
            stopReconnecting();
            roomStatusRef.current = payload.status;
            startTransition(() => {
              setRoom((current) =>
                current
                  ? {
                      ...current,
                      status: payload.status
                    }
                  : current
              );
              setRoomNotice(roomStateMessage(payload.status, payload.reason));
              setDestroying(false);
              setDestroyFeedback(payload.status === "destroyed" ? "success" : "idle");
              setConnection(t("closed"));
            });
            clearRoomSecurityState(true, true);
            await sendPeerData({ type: "peer_destroy" });
            return;
          }

          if (payload.type === "participant_kicked") {
            if (payload.sessionId === sessionId) {
              stopReconnecting();
              const replaced = payload.reason === "session-replaced";
              setRemovedFromRoom(!replaced);
              setRoomNotice(null);
              setError(replaced ? t("sessionReplaced") : null);
              setConnection(t("closed"));
              joinedRef.current = false;
              // Another tab now owns this session. Do not erase its shared credentials.
              clearRoomSecurityState(replaced);
              socket.close();
            }
            if (creatorToken) {
              void refreshInvites();
            }
            return;
          }

          if (payload.type === "error") {
            if (
              payload.code === "invite_required" ||
              payload.code === "invite_claimed" ||
              payload.code === "invite_used"
            ) {
              stopReconnecting();
              setInviteAccess(
                payload.code === "invite_claimed"
                  ? "claimed"
                  : payload.code === "invite_used"
                    ? "used"
                    : "invalid"
              );
              setError(null);
              setRoom(null);
              setRoomNotice(null);
              setReady(true);
              socket.close(4403, "invalid-invite");
              return;
            }
            if (payload.code === "peer_missing") {
              return;
            }
            if (["room_full", "reconnect_required", "identity_mismatch", "invalid_join", "room_unavailable"].includes(payload.code)) {
              stopReconnecting();
              setReady(true);
              setConnection(t("disconnected"));
            }
            setError(payload.message);
          }
        });
      } catch (cause) {
        if (!connectionAllowed()) return;
        if (cause instanceof RoomMetadataError && cause.kind === "missing") {
          stopReconnecting();
          clearRoomSecurityState(true, true);
          joinedRef.current = false;
          setRoom(null);
          setConnection(t("closed"));
          setNotFound(true);
          setReady(true);
          return;
        }
        if (cause instanceof RoomMetadataError && cause.kind === "temporary") {
          if (scheduleReconnect()) return;
          setCanRetryConnection(reconnect.canRetry);
          setConnection(t("disconnected"));
          setConnectionError(t("failedJoinRoom"));
          return;
        }
        setCanRetryConnection(false);
        setConnection(t("disconnected"));
        setError(cause instanceof RoomMetadataError ? t("failedJoinRoom") :
          cause instanceof Error ? cause.message : t("failedJoinRoom"));
      } finally {
        bootstrapping = false;
      }
    }

    async function verifyPeerEvent(
      event: AuthenticatedPeerEvent,
      relaySenderId?: string,
      recoverImageReplay = false
    ): Promise<boolean> {
      if (
        event.roomId !== roomId ||
        (relaySenderId && event.senderSessionId !== relaySenderId) ||
        (event.targetSessionId !== null && event.targetSessionId !== sessionId) ||
        event.sentAt > Date.now() + 5 * 60 * 1000
      ) return false;
      const encodedKey = peerIdentityKeysRef.current.get(event.senderSessionId);
      if (!encodedKey) return false;
      try {
        const verify = async () => {
          const key = await importIdentityPublicKey(encodedKey);
          if (!(await verifyAuthenticatedPeerEvent(key, event))) throw new Error("Peer signature verification failed.");
        };
        // Only sync recovery may reverify chat events; addEnvelope permits replayed
        // content exclusively for bounded image parts, never ordinary/state messages.
        if (recoverImageReplay && event.payload.type === "chat_message") { await verify(); return true; }
        return await eventReplayGuardRef.current!.accept(event.eventId, null, verify);
      } catch {
        return false;
      }
    }

    async function addEnvelope(event: AuthenticatedPeerEvent, animate = false, recoverImageReplay = false) {
      if (event.payload.type !== "chat_message") return;
      const envelope = event.payload.envelope;
      const messageKey = roomKeysRef.current.get(envelope.keyEpoch);
      if (!messageKey) {
        // WebSocket callbacks are async: a chat event may finish verification
        // before the preceding key-rotation event finishes unwrapping its key.
        if (pendingEnvelopesRef.current.size < MAX_TRANSCRIPT_SYNC_MESSAGES) {
          pendingEnvelopesRef.current.set(envelope.messageId, { event, animate, recoverImageReplay });
        }
        return;
      }
      pendingEnvelopesRef.current.delete(envelope.messageId);

      try {
        const received = await receiveTextMessage(
          messageKey, roomId, envelope, replayGuardRef.current!, event.senderSessionId
        );
        let content = received;
        if (!content && recoverImageReplay) {
          // Rebuild expired in-memory assemblies from authenticated sync parts
          // when this client still owns that epoch key. Complete images are insert-only.
          if (envelope.senderSessionId !== event.senderSessionId) return;
          const plaintext = await decryptMessage(messageKey, roomId, envelope);
          if (!plaintext.startsWith(IMAGE_CHUNK_PREFIX) || envelope.expiresAfterReadSeconds !== null) return;
          content = { plaintext };
        }
        if (!content) return;
        const part = imageAssemblerRef.current.accept(content.plaintext, envelope.senderSessionId, envelope.sentAt);
        messageRef.current.set(envelope.messageId, event);
        if (part.type === "pending") return;
        const plaintext = part.plaintext;
        decodeImage(plaintext); // Reject malformed reserved image data before persistence/render.
        const { expiresAt } = content;
        const interaction = decodeInteraction(plaintext);
        const message: HistoryMessage = {
          id: part.type === "image" ? part.id : interaction?.id ?? envelope.messageId,
          senderSessionId: envelope.senderSessionId, plaintext,
          sentAt: envelope.sentAt, expiresAt, kind: "text", delivery: "sent"
        };
        if (part.type === "image") {
          // Authenticated inner IDs must not replace existing local messages or imports.
          if (!await saveReceivedImage(roomId, sessionId, message)) return;
        } else await saveHistory(roomId, sessionId, [message]);
        // Transcript sync is history, not a new arrival. Keep this marker out of
        // persisted data so refresh and history pagination never replay motion.
        const visible = animate ? { ...message, entrance: { until: Date.now() + 250 } } : message;
        startTransition(() => setMessages((current) => upsertMessage(current, visible)));
      } catch (cause) {
        setError(
          cause instanceof InvalidMessageEnvelopeError
            ? t("alteredMessage")
            : cause instanceof Error && cause.message === "Message replay limit reached."
            ? t("replayLimit")
            : t("authFailed")
        );
      }
    }

    async function handlePeerData(peerId: string, event: AuthenticatedPeerEvent, sourceSocket: WebSocket) {
      const verified = await verifyPeerEvent(event, peerId);
      if (!connectionAllowed() || socketRef.current !== sourceSocket || !joinedRef.current) return;
      if (!verified) {
        setError(t("authFailed"));
        return;
      }
      const payload = event.payload;
      if (payload.type === "key_rotation") {
        const leader = currentKeyLeader();
        const agreementPrivateKey = agreementPrivateKeyRef.current;
        if (
          !leader ||
          event.senderSessionId !== leader.sessionId ||
          payload.senderAgreementKey !== leader.agreementKey ||
          payload.keyEpoch !== membershipVersionRef.current ||
          payload.keyEpoch <= keyEpochRef.current ||
          !agreementPrivateKey
        ) return;
        const isCurrent = captureKeyWork(payload.keyEpoch, leader);
        if (!isCurrent()) return;
        try {
          const nextSecret = await unwrapRoomSecret(
            agreementPrivateKey,
            payload.senderAgreementKey,
            roomId,
            payload.keyEpoch,
            event.senderSessionId,
            sessionId,
            payload.ciphertext,
            payload.nonce
          );
          if (!isCurrent()) return;
          const nextKey = await deriveRoomKey(nextSecret);
          if (!isCurrent() || payload.keyEpoch <= keyEpochRef.current) return;
          roomKeysRef.current.set(payload.keyEpoch, nextKey);
          roomKeyRef.current = nextKey;
          keyEpochRef.current = payload.keyEpoch;
          keyReadyRef.current = true;
          setKeyReady(true);
          setConnection(t("connected"));
          for (const pending of pendingEnvelopesRef.current.values()) await addEnvelope(pending.event, pending.animate, pending.recoverImageReplay);
          if (shouldRequestSyncRef.current) await sendPeerData({ type: "sync_request" });
        } catch {
          if (isCurrent()) setError(t("authFailed"));
        }
        return;
      }
      if (payload.type === "chat_message") {
        await addEnvelope(event, true);
        return;
      }

      if (payload.type === "sync_request") {
        await sendTranscript(peerId);
        return;
      }

      if (payload.type === "sync_response") {
        if (
          payload.completeness !== "peer-partial" ||
          payload.messages.length > MAX_TRANSCRIPT_SYNC_MESSAGES
        ) return;
        shouldRequestSyncRef.current = false;
        setRoomNotice(
          payload.messages.length === 0
            ? t("syncEmpty")
            : payload.truncated
              ? t("syncTruncated")
              : t("syncPartial")
        );
        for (const syncedEvent of payload.messages.slice(-MAX_TRANSCRIPT_SYNC_MESSAGES)) {
          if (await verifyPeerEvent(syncedEvent, undefined, true)) await addEnvelope(syncedEvent, false, true);
        }
        return;
      }

      if (payload.type === "file_offer") {
        if (
          payload.senderSessionId !== event.senderSessionId ||
          payload.size < 0 ||
          payload.size > MAX_FILE_BYTES ||
          !/^[A-Za-z0-9_-]{43}$/.test(payload.sha256)
        ) {
          setError(t("authFailed"));
          return;
        }
        const expiresAt =
          typeof payload.expiresAfterReadSeconds === "number"
            ? payload.sentAt + payload.expiresAfterReadSeconds * 1000
            : undefined;
        if (typeof expiresAt === "number" && expiresAt <= Date.now()) {
          return;
        }
        removeIncomingFile(payload.fileId);
        incomingFilesRef.current.set(payload.fileId, {
          requested: false,
          name: payload.name,
          mimeType: payload.mimeType || "application/octet-stream",
          size: payload.size,
          totalChunks: 0,
          received: 0,
          receivedBytes: 0,
          chunks: [],
          senderSessionId: payload.senderSessionId,
          sha256: payload.sha256,
          keyEpoch: payload.keyEpoch
        });
        startTransition(() => {
          setMessages((current) =>
            upsertMessage(current, {
              id: payload.fileId,
              senderSessionId: payload.senderSessionId,
              sentAt: payload.sentAt,
              expiresAt,
              kind: "file",
              file: {
                fileId: payload.fileId,
                name: payload.name,
                mimeType: payload.mimeType || "application/octet-stream",
                size: payload.size,
                state: "offered",
                progress: 0,
                outgoing: false
              }
            })
          );
        });
        return;
      }

      if (payload.type === "file_request") {
        void serveFile(payload.fileId, peerId);
        return;
      }

      if (payload.type === "file_chunk") {
        const incoming = incomingFilesRef.current.get(payload.fileId);
        if (
          !incoming ||
          incoming.senderSessionId !== event.senderSessionId ||
          !Number.isSafeInteger(payload.chunkIndex) ||
          !Number.isSafeInteger(payload.totalChunks) ||
          payload.chunkIndex < 0 ||
          payload.totalChunks < 1 ||
          payload.chunkIndex >= payload.totalChunks ||
          payload.totalChunks > Math.ceil(MAX_FILE_BYTES / FILE_CHUNK_BYTES) ||
          payload.totalChunks !== Math.max(1, Math.ceil(incoming.size / FILE_CHUNK_BYTES)) ||
          payload.keyEpoch !== incoming.keyEpoch
        ) {
          return;
        }
        await receiveChunk(payload);
        return;
      }

      if (payload.type === "file_complete") {
        const incoming = incomingFilesRef.current.get(payload.fileId);
        if (!incoming || incoming.senderSessionId !== event.senderSessionId) return;
        await finalizeIncoming(payload.fileId, payload.sha256);
        return;
      }

      if (payload.type === "file_cancel") {
        removeIncomingFile(payload.fileId);
        updateFileMessage(payload.fileId, { state: "error" });
        return;
      }

      if (payload.type === "peer_destroy") {
        stopReconnecting();
        setRoomNotice(t("peerDestroyed"));
        setConnection(t("closed"));
        clearRoomSecurityState(true, true);
      }
    }

    void bootstrap();

    return () => {
      active = false;
      stopReconnecting();
      retryConnectionRef.current = null;
      stopConnectionRef.current = null;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(tick);
      socketRef.current?.close();
      for (const [fileId, transfer] of incomingFilesRef.current) removeIncomingFile(fileId, transfer);
    };
  }, [creatorToken, inviteToken, roomId, roomSecret, sessionId]);

  useEffect(() => {
    if (copyFeedback !== "success") {
      return;
    }
    const timeout = window.setTimeout(() => setCopyFeedback("idle"), 1600);
    return () => window.clearTimeout(timeout);
  }, [copyFeedback]);

  useEffect(() => {
    if (inviteFeedback === "idle") {
      return;
    }
    const timeout = window.setTimeout(() => setInviteFeedback("idle"), 1600);
    return () => window.clearTimeout(timeout);
  }, [inviteFeedback]);

  useEffect(() => {
    if (destroyFeedback !== "success") {
      return;
    }
    const timeout = window.setTimeout(() => setDestroyFeedback("idle"), 2200);
    return () => window.clearTimeout(timeout);
  }, [destroyFeedback]);

  useEffect(() => {
    if (!ready || room?.status !== "open") {
      return;
    }
    const interval = window.setInterval(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && joinedRef.current) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 10000);
    return () => window.clearInterval(interval);
  }, [ready, room?.status]);

  useEffect(() => {
    startTransition(() => {
      setMessages((current) =>
        current.filter((message) => {
          const keep = message.kind === "text" || !message.expiresAt || message.expiresAt > now;
          if (!keep && message.kind === "file") {
            if (message.file?.url) {
              URL.revokeObjectURL(message.file.url);
              objectUrlsRef.current.delete(message.file.url);
            }
            outgoingFilesRef.current.delete(message.id);
            outgoingFileHashesRef.current.delete(message.id);
            removeIncomingFile(message.id);
          }
          return keep;
        })
      );
    });
    for (const [messageId, envelope] of messageRef.current.entries()) {
      const message = envelope.payload.type === "chat_message" ? envelope.payload.envelope : null;
      const expiresAt =
        typeof message?.expiresAfterReadSeconds === "number"
          ? message.sentAt + message.expiresAfterReadSeconds * 1000
          : undefined;
      if (typeof expiresAt === "number" && expiresAt <= now) {
        messageRef.current.delete(messageId);
      }
    }
  }, [now]);

  useEffect(() => {
    void refreshInvites();
  }, [creatorToken, roomId]);

  useEffect(() => {
    roomStatusRef.current = room?.status ?? null;
  }, [room?.status]);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);

  async function loadEarlierHistory() {
    if (!historyLoaded || !hasMoreHistory || loadingHistoryRef.current) return;
    loadingHistoryRef.current = true;
    setLoadingHistory(true);
    try {
      const page = await loadHistoryPage(roomId, sessionId, historyCursorRef.current);
      preserveHistoryPosition();
      if (page.messages.length) {
        historyCursorRef.current = page.messages[0];
        setHiddenHistoryIds(current => {
          const hidden = new Set(current);
          for (const message of page.messages) hidden.delete(message.id);
          return hidden;
        });
      }
      setHasMoreHistory(page.hasMore);
      setMessages(current => mergeHistoryMessages(current, page.messages));
    } catch { setError("无法加载更早记录，请重试。"); }
    finally { loadingHistoryRef.current = false; setLoadingHistory(false); }
  }

  function openArchive(mode: "export" | "import") {
    setShowMore(false);
    setArchivePassword("");
    setArchiveConfirmation("");
    setArchiveFile(null);
    setArchiveError(null);
    setArchiveFeedback(null);
    setArchiveMode(mode);
  }

  async function handleArchive() {
    if (archiveBusy || !archivePassword || !archiveMode) return;
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      if (archiveMode === "export") {
        validateExportPasswords(archivePassword, archiveConfirmation);
        const content = await encryptHistory(await loadHistory(roomId, sessionId), archivePassword, sessionId);
        const url = URL.createObjectURL(new Blob([content], { type: "application/octet-stream" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `chat-${new Date().toISOString().slice(0, 10)}.achat`;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setArchiveFeedback("完整聊天记录已加密导出。");
      } else {
        if (!archiveFile) throw new Error("请选择 .achat 记录文件。");
        const previousIds = messagesRef.current.map(message => message.id);
        const saved = await decryptHistory(await archiveFile.text(), archivePassword);
        const added = await importHistory(roomId, sessionId, saved);
        const page = await loadHistoryPage(roomId, sessionId);
        historyCursorRef.current = page.messages[0];
        const pageIds = new Set(page.messages.map(message => message.id));
        setHiddenHistoryIds(new Set(previousIds.filter(id => !pageIds.has(id))));
        setHasMoreHistory(page.hasMore);
        jumpToLatest();
        setMessages(current => mergeHistoryMessages(current, page.messages));
        setArchiveFeedback(`已导入 ${added} 条记录，重复记录已跳过。导入内容仅在本机显示。`);
      }
      setArchiveMode(null);
      setArchivePassword("");
      setArchiveConfirmation("");
      setArchiveFile(null);
    } catch (cause) {
      setArchiveError(cause instanceof Error ? cause.message : "记录处理失败，请重试。");
    } finally { setArchiveBusy(false); }
  }

  async function transmitMessage(message: HistoryMessage & { entrance?: MessageEntrance }): Promise<boolean> {
    if (message.imported) return false;
    const key = roomKeyRef.current;
    const leader = currentKeyLeader();
    if (!key || !leader || !keyReadyRef.current || roomStatusRef.current !== "open" || presence.count < 2) return false;
    const keyEpoch = keyEpochRef.current;
    const keyWorkIsCurrent = captureKeyWork(keyEpoch, leader);
    const isCurrent = () => keyWorkIsCurrent() && roomKeyRef.current === key;
    if (!isCurrent()) return false;
    for (const { envelope, plaintext } of createMessageTransmissions(message, keyEpoch)) {
      await waitForSocketDrain();
      if (!isCurrent()) return false;
      Object.assign(envelope, await encryptMessage(key, roomId, envelope, plaintext));
      if (!isCurrent()) return false;
      replayGuardRef.current!.markLocal(envelope.messageId, null);
      const sentEvent = await sendPeerData({ type: "chat_message", envelope }, undefined, isCurrent);
      if (!sentEvent) return false;
      messageRef.current.set(envelope.messageId, sentEvent);
    }
    // Outbox entries can come from the UI list; do not persist its motion marker.
    const { entrance: _entrance, ...saved } = message;
    const sent: HistoryMessage = { ...saved, delivery: "sent" };
    await saveHistory(roomId, sessionId, [sent]);
    setMessages((current) => upsertMessage(current, sent));
    return true;
  }

  function sendText(plaintext: string): Promise<boolean> {
    // Serialize taps and outbox work: rapid likes must not be dropped by the send lock.
    const queued = outgoingQueueRef.current.then(() => persistAndSendText(plaintext));
    outgoingQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async function persistAndSendText(plaintext: string): Promise<boolean> {
    if (!historyLoaded || roomStatusRef.current !== "open") return false;
    setSending(true);
    try {
      const interaction = decodeInteraction(plaintext);
      const id = interaction?.id ?? generateMessageId();
      const previous = messagesRef.current.find((message) => message.id === id);
      if (previous) return true;
      const message: HistoryMessage = {
        id, transportId: interaction ? generateMessageId() : id,
        senderSessionId: sessionId, plaintext, sentAt: Date.now(), kind: "text", delivery: "pending"
      };
      // Persist the reply before sending: refresh/replayed requests cannot cause another answer.
      await saveHistory(roomId, sessionId, [message]);
      const visible = { ...message, entrance: { until: Date.now() + 250 } };
      messagesRef.current = upsertMessage(messagesRef.current, visible);
      setMessages((current) => upsertMessage(current, visible));
      try { await transmitMessage(message); }
      catch { setError("消息已保存在本机，发送失败。请重试或等待重新连接。"); }
      if (!interaction || !isStateInteraction(interaction)) jumpToLatest();
      return true;
    } catch {
      setError("本地记录保存失败，消息未发送。请检查浏览器存储权限或空间。");
      return false;
    } finally {
      setSending(false);
    }
  }

  function flushOutbox() {
    const queued = outgoingQueueRef.current.then(drainOutbox);
    outgoingQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async function drainOutbox() {
    if (!historyLoaded || !keyReadyRef.current || presence.count < 2) return;
    setSending(true);
    try {
      for (const message of messagesRef.current) {
        if (!message.imported && message.kind === "text" && message.delivery === "pending" && message.senderSessionId === sessionId) {
          if (!await transmitMessage(message as HistoryMessage)) break;
        }
      }
    } catch { setError("发送失败，本地待发送消息已保留。请重试。"); }
    finally { setSending(false); }
  }

  useEffect(() => { void flushOutbox(); }, [keyReady, presence.count, historyLoaded]);

  async function handleSend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    const revision = draftRevisionRef.current;
    if (text && await sendText(text) && revision === draftRevisionRef.current) setDraft("");
  }

  async function handleSendImages(files: FileList | null) {
    if (!files || imageBusy) return;
    setImageBusy(true);
    setShowMore(false);
    try {
      for (const file of Array.from(files)) {
        const plaintext = encodeImage(await readChatImage(file));
        if (!await sendText(plaintext)) break;
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "图片发送失败，请重试。"); }
    finally { setImageBusy(false); if (imageInputRef.current) imageInputRef.current.value = ""; }
  }

  async function sendInteraction(value: Interaction) {
    return sendText(encodeInteraction(value));
  }

  function openInteraction(kind: "notice" | "poll" | "pin" | "hidden") {
    setComposerKind(kind);
    setShowMore(false);
    setShowInteractions(true);
  }

  async function editMessage(start: number, end: number, replacement: string) {
    if (!editingMessage || editingMessage.senderSessionId === sessionId ||
        deriveInteractionState(messagesRef.current.filter(message => !message.imported)).edits.has(editingMessage.id)) return false;
    return sendInteraction({ type: "message.edit", id: `edit:${editingMessage.id}`, replyTo: editingMessage.id, start, end, replacement });
  }

  function exitRoom() {
    stopConnectionRef.current?.();
    socketRef.current?.close();
    window.location.assign("/");
  }

  async function handleCopyLink() {
    if (await copyText(window.location.href)) {
      setCopyFeedback("success");
      setError(null);
      return;
    }
    setError(t("clipboardLinkFailed"));
  }

  function recordInviteHandoff(token: string) {
    if (measuredInviteHandoffsRef.current.has(token)) {
      return;
    }
    measuredInviteHandoffsRef.current.add(token);
    recordGrowthEvent("invite_share_handoff");
  }

  function inviteActionIsCurrent(action: number, token: string) {
    return action === inviteActionRef.current && roomStatusRef.current === "open" &&
      canShareInvite(currentInvitesRef.current.find((invite) => invite.token === token), Date.now());
  }

  async function handleShareInvite(event: React.MouseEvent<HTMLButtonElement>) {
    const trigger = event.currentTarget;
    const focusOwner = document.activeElement;
    const action = ++inviteActionRef.current;
    setManualInvite(null);
    setRoomNotice(null);
    setError(null);
    if (!creatorToken) {
      return;
    }
    try {
      const inviteTtlMs = parseInviteDurationDraft(inviteDuration);
      const invite = await createInvite(roomId, creatorToken, inviteTtlMs);
      if (action !== inviteActionRef.current || roomStatusRef.current !== "open") return;
      currentInvitesRef.current = [invite, ...currentInvitesRef.current];
      setInvites(currentInvitesRef.current);
      if (!inviteActionIsCurrent(action, invite.token)) return;
      const inviteUrl = buildInviteUrl(roomId, invite.token, roomSecret);
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({
            title: "elm.chat invite",
            text: t("inviteShareText"),
            url: inviteUrl
          });
          recordInviteHandoff(invite.token);
          if (!inviteActionIsCurrent(action, invite.token)) return;
          setInviteFeedback("shared");
          setRoomNotice(t("sharedInviteNotice"));
          setError(null);
          return;
        } catch (cause) {
          if (!inviteActionIsCurrent(action, invite.token)) return;
          if (cause instanceof DOMException && cause.name === "AbortError") {
            setInviteFeedback("idle");
            setRoomNotice(t("createdInviteNotice"));
            setError(null);
            return;
          }
        }
      }
      if (await copyText(inviteUrl)) {
        recordInviteHandoff(invite.token);
        if (!inviteActionIsCurrent(action, invite.token)) return;
        setInviteFeedback("copied");
        setRoomNotice(t("copiedInviteNotice"));
        setError(null);
        return;
      }
      if (!inviteActionIsCurrent(action, invite.token)) return;
      setManualInvite({ token: invite.token, trigger, focusOwner });
      setInviteFeedback("idle");
    } catch (cause) {
      if (action !== inviteActionRef.current || roomStatusRef.current !== "open") return;
      setError(cause instanceof Error ? cause.message : t("createInviteFailed"));
    }
  }

  async function handleCopyInvite(token: string, trigger: HTMLButtonElement) {
    const focusOwner = document.activeElement;
    const action = ++inviteActionRef.current;
    setManualInvite(null);
    setRoomNotice(null);
    setError(null);
    if (await copyText(buildInviteUrl(roomId, token, roomSecret))) {
      recordInviteHandoff(token);
      if (!inviteActionIsCurrent(action, token)) return;
      setInviteFeedback("copied");
      setRoomNotice(t("copiedInviteNotice"));
      setError(null);
      return;
    }
    if (!inviteActionIsCurrent(action, token)) return;
    setManualInvite({ token, trigger, focusOwner });
  }

  async function handleNativeShareInvite(token: string, trigger: HTMLButtonElement) {
    const focusOwner = document.activeElement;
    const action = ++inviteActionRef.current;
    setManualInvite(null);
    setRoomNotice(null);
    setError(null);
    if (typeof navigator.share !== "function") {
      return;
    }
    try {
      await navigator.share({
        title: "elm.chat invite",
        text: t("inviteShareText"),
        url: buildInviteUrl(roomId, token, roomSecret)
      });
      recordInviteHandoff(token);
      if (!inviteActionIsCurrent(action, token)) return;
      setInviteFeedback("shared");
      setRoomNotice(t("sharedInviteNotice"));
      setError(null);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        if (!inviteActionIsCurrent(action, token)) return;
        setManualInvite({ token, trigger, focusOwner });
      }
    }
  }

  async function handleRevokeInvite(token: string) {
    // Removing an invite supersedes any copy/share still awaiting browser APIs.
    inviteActionRef.current += 1;
    if (!creatorToken) {
      return;
    }
    try {
      await revokeInvite(roomId, creatorToken, token);
      setInvites((current) =>
        current.map((invite) =>
          invite.token === token ? { ...invite, revokedAt: Date.now() } : invite
        )
      );
      setRoomNotice(t("removedInviteNotice"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("revokeInviteFailed"));
    }
  }

  function handleKickParticipant(targetSessionId: string) {
    if (!creatorToken || targetSessionId === sessionId) {
      return;
    }
    socketRef.current?.send(
      JSON.stringify({
        type: "kick_participant",
        creatorToken,
        targetSessionId
      })
    );
  }

  async function handleDestroy() {
    if (!creatorToken) {
      return;
    }
    try {
      setDestroying(true);
      setDestroyFeedback("idle");
      const next = await destroyRoom(roomId, creatorToken);
      await sendPeerData({ type: "peer_destroy" });
      setRoomNotice(null);
      setRoom(next);
    } catch (cause) {
      setDestroying(false);
      setError(cause instanceof Error ? cause.message : t("destroyRoomFailed"));
    }
  }

  const presentCount = presence.count;
  const sortedPresenceIds = [...presence.connectedSessionIds].sort((left, right) =>
    left === sessionId ? -1 : right === sessionId ? 1 : left.localeCompare(right)
  );
  const messagePolicyLabel =
    typeof room?.disappearAfterReadSeconds === "number"
      ? t("messagesVanish", { duration: formatStaticDuration(room.disappearAfterReadSeconds) })
      : t("messagesStay");
  const idleDeadline =
    typeof room?.inactivityTimeoutMs === "number"
      ? room.lastActivityAt + room.inactivityTimeoutMs
      : null;
  const roomDeadline =
    typeof room?.expiresAt === "number" && typeof idleDeadline === "number"
      ? Math.min(room.expiresAt, idleDeadline)
      : typeof room?.expiresAt === "number"
        ? room.expiresAt
        : idleDeadline;
  const roomPolicyLabel =
    typeof roomDeadline === "number"
      ? t("roomExpires", { duration: formatRelativeDuration(roomDeadline) })
      : t("roomStays");
  const isCreator = Boolean(creatorToken);
  const manualInviteRecord = invites.find((invite) => invite.token === manualInvite?.token);
  const showManualInvite = isCreator && room?.status === "open" &&
    canShareInvite(manualInviteRecord, Math.max(now, Date.now()));
  function dismissManualInvite() {
    inviteActionRef.current += 1;
    setManualInvite(null);
  }

  useEffect(() => {
    if (removedFromRoom || notFound || (room && room.status !== "open") ||
      ["invalid", "claimed", "used"].includes(inviteAccess)) {
      conversationFind.close();
      concealment.reset();
    }
  }, [removedFromRoom, notFound, room?.status, inviteAccess]);

  if (removedFromRoom) {
    return <RemovedFromRoomScreen focusRef={setRetryFocusTarget} />;
  }

  if (inviteAccess === "invalid" || inviteAccess === "claimed" || inviteAccess === "used") {
    return <InvalidInviteScreen reason={inviteAccess} focusRef={setRetryFocusTarget} />;
  }

  const localOnly = notFound || Boolean(ready && room && room.status !== "open");

  if (notFound && !viewLocalHistory) {
    return (
      <RoomGoneScreen
        fromInvite={isInviteGuest}
        reason={t("roomNotFound")}
        onViewHistory={() => setViewLocalHistory(true)}
        historyLoaded={historyLoaded}
        focusRef={setRetryFocusTarget}
      />
    );
  }

  if (ready && room && room.status !== "open" && !viewLocalHistory) {
    return (
      <RoomGoneScreen
        fromInvite={isInviteGuest}
        reason={roomNotice ?? roomStateMessage(room.status)}
        onViewHistory={() => setViewLocalHistory(true)}
        historyLoaded={historyLoaded}
        focusRef={setRetryFocusTarget}
      />
    );
  }

  if (!localOnly && !concealment.hidden && isInviteGuest && (inviteAccess !== "granted" || !room || !ready)) {
    return <InviteCheckingScreen connection={connection} error={connectionError ?? error} restoring={restoringSession}
      focusRef={setRetryFocusTarget}
      onRetry={canRetryConnection ? () => retryConnectionRef.current?.() : undefined} />;
  }

  const pending = historyLoaded && !localOnly ? pendingInteractions(messages.filter((m): m is HistoryMessage => !m.imported && m.kind === "text" && typeof m.plaintext === "string"), sessionId) : [];
  const pendingCount = messages.filter((message) => !message.imported && message.delivery === "pending").length;
  const inviteLink = invites.find((invite) => canShareInvite(invite, now));
  return <main className="room-shell">
    {localOnly && <p className="local-note" role="status">房间已失效，本地记录仍保留；此处仅供查看、导入和导出。<a href="/">创建新房间</a></p>}
    <header className="room-header">
      <div><h1>匿名聊天</h1><p className="room-subtitle">{!historyLoaded ? "正在读取本地记录…" : localOnly ? "仅本地记录 · 房间已失效" : !ready ? restoringSession ? t("restoringSession") : "正在连接…" : !keyReady ? connection : presence.count > 1 ? "对方在线 · 端到端加密" : "等待对方上线 · 端到端加密"}</p></div>
      <div className="room-actions">
        <ThemeToggle />
        {!localOnly && isCreator && <button className="secondary-button" onClick={handleShareInvite} ref={inviteTriggerRef} disabled={!ready || presence.count >= 2}>邀请</button>}
        <button className="secondary-button" onClick={exitRoom}>退出房间</button>
      </div>
    </header>
    {!localOnly && interactionState.pin && <aside className="pinned-area" aria-label="共享置顶">
      <div className="pinned-bubble" style={{ backgroundColor: interactionState.pin.color, color: contrastColor(interactionState.pin.color) }}>
        <span className="pin-mark" aria-hidden="true">⌁</span><p>{interactionState.pin.text}</p>
        <button type="button" aria-label="编辑置顶" onClick={() => openInteraction("pin")} disabled={!historyLoaded}>编辑</button>
        <button type="button" aria-label="删除置顶" onClick={() => void sendInteraction({ type: "pin.delete", id: generateMessageId() })} disabled={!historyLoaded}>×</button>
      </div>
    </aside>}
    {!localOnly && inviteLink && isCreator && <div className="invite-panel">
      <label htmlFor="invite-link">邀请链接（10 分钟内一次有效）</label>
      <input id="invite-link" readOnly value={buildInviteUrl(roomId, inviteLink.token, roomSecret)} onFocus={(event) => event.target.select()} />
      <button className="secondary-button" onClick={(event) => handleCopyInvite(inviteLink.token, event.currentTarget)}>{inviteFeedback === "copied" ? "已复制" : "复制链接"}</button>
    </div>}
    {canRetryConnection && <button className="secondary-button" onClick={() => retryConnectionRef.current?.()}>重新连接</button>}
    {error && <p className="error-text room-error" role="alert">{error}</p>}
    {connectionError && <p className="error-text room-error" role="alert">{connectionError}</p>}
    <section className="chat-log" aria-label="聊天记录" aria-live="polite" role="log" ref={chatLogRef} onScroll={() => {
      handleConversationScroll();
      if (chatLogRef.current && chatLogRef.current.scrollTop < 80) void loadEarlierHistory();
    }}>
      <div className="chat-thread">
        {hasMoreHistory && <button type="button" className="secondary-button" disabled={loadingHistory} onClick={() => void loadEarlierHistory()}>{loadingHistory ? "正在加载…" : "加载更早记录"}</button>}
        {historyLoaded && visibleMessages.length === 0 && <p className="system-line">没有消息，打个招呼吧。</p>}
        <VirtualMessageList messages={visibleMessages} scrollRef={chatLogRef} navigationRef={virtualMessagesRef} renderMessage={message => <MessageBubble key={message.id} message={message}
          mine={message.imported && message.mine !== undefined ? message.mine : message.senderSessionId === sessionId} likes={message.imported ? message.likes ?? 0 : interactionState.likes.get(message.id) ?? 0}
          confirmed={interactionState.acknowledged.has(message.id)} answer={interactionState.answers.get(message.id)}
          edit={interactionState.edits.get(message.id)}
          onLike={() => sendInteraction({ type: "message.like", id: generateMessageId(), replyTo: message.id })}
          onEdit={() => setEditingMessage(message)} onPreviewImage={setPreviewImage} />} />
      </div>
    </section>
    {awayFromLatest && <button className="jump-to-latest" onClick={jumpToLatest}>回到最新消息 {newMessageCount || ""}</button>}
    {showMore && <div className="more-dismiss" onClick={() => setShowMore(false)} aria-hidden="true" />}
    <input className="sr-only" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple ref={imageInputRef} tabIndex={-1} aria-label="选择要发送的图片" disabled={imageBusy || !historyLoaded || room?.status !== "open"} onChange={event => void handleSendImages(event.target.files)} />
    <form className="composer" onSubmit={handleSend}>
      {pendingCount > 0 && <div className="outbox-status" role="status">{pendingCount} 条消息待发送 <button type="button" onClick={() => void flushOutbox()} disabled={sending || !keyReady || presence.count < 2}>重试发送</button></div>}
      <div className="composer-tools">
        <button className={`secondary-button composer-plus${showMore ? " is-open" : ""}`} type="button" aria-label="更多功能" aria-expanded={showMore} aria-controls="chat-more-menu" disabled={!historyLoaded} onClick={() => setShowMore(!showMore)}>+</button>
        {showMore && <div id="chat-more-menu" className="more-menu" role="menu" aria-label="聊天工具" onKeyDown={event => { if (event.key === "Escape") setShowMore(false); }}>
          <div className="more-menu-group" role="group" aria-label="消息互动">
            <button type="button" role="menuitem" disabled={localOnly} onClick={() => { setShowMore(false); void sendInteraction({ type: "dice", id: generateMessageId(), value: Math.floor(Math.random() * 6) + 1 }); }}><span aria-hidden="true">⚄</span>摇骰子</button>
            <button type="button" role="menuitem" disabled={imageBusy || !keyReady || room?.status !== "open"} onClick={() => { setShowMore(false); imageInputRef.current?.click(); }}><span aria-hidden="true">▧</span>{imageBusy ? "正在处理图片…" : "发送图片"}</button>
          </div>
          <div className="more-menu-group" role="group" aria-label="更多工具">
            <button type="button" role="menuitem" disabled={localOnly} onClick={() => openInteraction("notice")}><span aria-hidden="true">◷</span>发送提醒</button>
            <button type="button" role="menuitem" disabled={localOnly} onClick={() => openInteraction("poll")}><span aria-hidden="true">☷</span>单选调查</button>
            <button type="button" role="menuitem" disabled={localOnly} onClick={() => openInteraction("pin")}><span aria-hidden="true">⌁</span>置顶气泡</button>
            <button type="button" role="menuitem" disabled={localOnly} onClick={() => openInteraction("hidden")}><span aria-hidden="true">◉</span>隐藏信息</button>
          </div>
          <div className="more-menu-group" role="group" aria-label="记录备份">
            <button type="button" role="menuitem" onClick={() => openArchive("import")}><span aria-hidden="true">↑</span>导入记录</button>
            <button type="button" role="menuitem" onClick={() => openArchive("export")}><span aria-hidden="true">↓</span>导出记录</button>
          </div>
        </div>}
      </div>
      <textarea aria-label="消息" placeholder="输入消息…" rows={1} maxLength={4000} value={draft} disabled={!historyLoaded || room?.status !== "open"} onChange={(event) => { draftRevisionRef.current += 1; setDraft(event.target.value); }} onKeyDown={handleComposerKeyDown} />
      <button className="primary-button" onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus} disabled={sending || !draft.trim() || !historyLoaded || !keyReady}>发送</button>
    </form>
    {archiveFeedback && <p className="local-note" role="status">{archiveFeedback}</p>}
    {archiveMode && <div className="interaction-overlay" role="dialog" aria-modal="true" aria-labelledby="archive-title">
      <form className="interaction-panel" onSubmit={event => { event.preventDefault(); void handleArchive(); }}>
        <h2 id="archive-title">{archiveMode === "export" ? "导出记录" : "导入记录"}</h2>
        <p>记录仅在本机加密和解密。请妥善保存密码，丢失后无法恢复。</p>
        {archiveMode === "import" && <label>记录文件<input type="file" accept=".achat" required disabled={archiveBusy} onChange={event => setArchiveFile(event.target.files?.[0] ?? null)} /></label>}
        <label>{archiveMode === "export" ? "设置密码" : "输入密码"}<input type="password" autoFocus required autoComplete={archiveMode === "export" ? "new-password" : "off"} value={archivePassword} disabled={archiveBusy} onChange={event => setArchivePassword(event.target.value)} /></label>
        {archiveMode === "export" && <label>再次输入密码<input type="password" required autoComplete="new-password" value={archiveConfirmation} disabled={archiveBusy} onChange={event => setArchiveConfirmation(event.target.value)} /></label>}
        {archiveError && <p className="error-text" role="alert">{archiveError}</p>}
        <button className="primary-button" disabled={archiveBusy}>{archiveBusy ? "正在处理…" : archiveMode === "export" ? "加密并导出" : "解密并导入"}</button>
        <button type="button" disabled={archiveBusy} onClick={() => { setArchiveMode(null); setArchivePassword(""); setArchiveConfirmation(""); setArchiveFile(null); }}>取消</button>
      </form>
    </div>}
    <p className="local-note">记录仅在本机 · <a href="/source.zip">源码 / AGPL-3.0</a></p>
    {previewImage && <ImagePreview image={previewImage} onClose={() => setPreviewImage(null)} />}
    {showInteractions && <InteractionComposer initialKind={composerKind} initialPin={interactionState.pin} onSend={sendInteraction} onClose={() => setShowInteractions(false)} />}
    {editingMessage && <MessageEditDialog text={editingMessage.plaintext ?? ""} onSubmit={editMessage} onClose={() => setEditingMessage(null)} />}
    {pending[0] && <InteractionPrompt key={pending[0].id} interaction={pending[0]} onReply={sendInteraction} onExit={exitRoom} />}
  </main>;
}
