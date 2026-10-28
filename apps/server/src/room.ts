import {
  DEFAULT_DISAPPEAR_AFTER_READ_SECONDS,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  MAX_CONNECTIONS_PER_ROOM,
  type ClientEvent,
  type CreateRoomResponse,
  type ErrorEventPayload,
  type JoinPayload,
  type KickParticipantPayload,
  type ParticipantKickedEvent,
  type PeerDataRelayEvent,
  type PeerDataRelayPayload,
  type PeerDescriptor,
  type PeerJoinedEvent,
  type PeerLeftEvent,
  type PresenceEvent,
  type PresenceSnapshot,
  type RoomInvite,
  type RoomMetadata,
  type RoomStateEvent,
  type ServerEvent
} from "@elm-chat/shared";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RoomContext, RoomSocket } from "./room-runtime.js";
import { roomExpiryReason } from "./expiry.js";

type RoomStorage = RoomMetadata & {
  creatorToken: string;
  admittedSessions: (Pick<AttachmentRecord, "sessionId" | "identityKey" | "agreementKey"> & {
    creator: boolean;
    reconnectTokenHash?: string;
    reconnectRevoked?: boolean;
  })[];
};

// Session identity is attached to each accepted socket; an empty sessionId
// marks a connection that has not completed the authenticated join yet.
type AttachmentRecord = {
  sessionId: string;
  creator: boolean;
  identityKey: string;
  agreementKey: string;
  connectedAt: number;
};

type RoomBootstrap = Pick<
  CreateRoomResponse,
  | "roomId"
  | "createdAt"
  | "expiresAt"
  | "inactivityTimeoutMs"
  | "maxAgeMs"
  | "disappearAfterReadSeconds"
  | "creatorToken"
>;

const ROOM_META_KEY = "room:meta";
const INVITES_KEY = "room:invites";
const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1000;
const JOIN_TIMEOUT_MS = 15 * 1000;
const MAX_ADMITTED_PARTICIPANTS = 2;

type InviteAdmission =
  | { ok: true; invite?: RoomInvite; newlyClaimed: boolean }
  | { ok: false; code: string; message: string; closeReason: string };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function errorEvent(code: string, message: string): ErrorEventPayload {
  return { type: "error", code, message };
}

async function safeJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export class Room {
  private roomMeta: RoomStorage | null = null;
  private invites = new Map<string, RoomInvite>();
  private storageReady: Promise<void>;

  constructor(private readonly ctx: RoomContext) {
    this.storageReady = this.ctx.blockConcurrencyWhile(async () => {
      this.roomMeta = (await this.ctx.storage.get<RoomStorage>(ROOM_META_KEY)) ?? null;
      this.invites = new Map((await this.ctx.storage.get<[string, RoomInvite][]>(INVITES_KEY)) ?? []);
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.storageReady;

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/internal/bootstrap") {
      return this.bootstrapRoom(await safeJson<RoomBootstrap>(request));
    }

    if (request.method === "GET" && url.pathname === "/internal/metadata") {
      return this.handleMetadata();
    }

    if (request.method === "POST" && url.pathname === "/internal/destroy") {
      const payload = await safeJson<{ creatorToken: string }>(request);
      return this.destroyRoom("destroyed", payload.creatorToken);
    }

    if (request.method === "POST" && url.pathname === "/internal/invites/create") {
      const payload = await safeJson<{ creatorToken: string; ttlMs?: number }>(request);
      return this.createInvite(payload.creatorToken, payload.ttlMs);
    }

    if (request.method === "GET" && url.pathname === "/internal/invites") {
      const creatorToken = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1] ?? "";
      return this.listInvites(creatorToken);
    }

    if (request.method === "POST" && url.pathname === "/internal/invites/revoke") {
      const payload = await safeJson<{ creatorToken: string; token: string }>(request);
      return this.revokeInvite(payload.creatorToken, payload.token);
    }

    return jsonResponse({ error: "Not found." }, 404);
  }

  // The HTTP server runs this check and socket acceptance in the same room queue.
  async socketStatus(): Promise<Response | null> {
    await this.storageReady;
    if (await this.expireIfDue() || !this.roomMeta || this.roomMeta.status !== "open") {
      return jsonResponse({ error: "Room is unavailable." }, 410);
    }
    if (this.openWebSockets().length >= MAX_CONNECTIONS_PER_ROOM) {
      return jsonResponse({ error: "Room is full." }, 409);
    }
    return null;
  }

  async acceptSocket(socket: RoomSocket): Promise<void> {
    await this.storageReady;
    socket.serializeAttachment({
      sessionId: "",
      creator: false,
      identityKey: "",
      agreementKey: "",
      connectedAt: Date.now()
    } satisfies AttachmentRecord);
    await this.scheduleNextAlarm();
  }

  async alarm(): Promise<void> {
    await this.storageReady;
    if (await this.expireIfDue()) return;
    const now = Date.now();
    for (const socket of this.openWebSockets()) {
      const attachment = socket.deserializeAttachment() as AttachmentRecord | null;
      if (attachment?.sessionId === "" && attachment.connectedAt + JOIN_TIMEOUT_MS <= now) {
        socket.close(4408, "join timeout");
      }
    }
    await this.scheduleNextAlarm();
  }

  async webSocketMessage(ws: RoomSocket, message: string | ArrayBuffer): Promise<void> {
    await this.storageReady;
    if (await this.expireIfDue() || ws.readyState !== 1) return;
    if (typeof message !== "string") {
      ws.send(JSON.stringify(errorEvent("binary_not_supported", "Binary payloads are not supported.")));
      return;
    }

    let parsed: ClientEvent;
    try {
      parsed = JSON.parse(message) as ClientEvent;
    } catch {
      ws.send(JSON.stringify(errorEvent("invalid_json", "Message must be valid JSON.")));
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      ws.send(JSON.stringify(errorEvent("invalid_event", "Message must be a room event.")));
      return;
    }

    const attachment = ws.deserializeAttachment() as AttachmentRecord | null;
    if (parsed.type !== "join" && !attachment?.sessionId) {
      ws.send(JSON.stringify(errorEvent("join_required", "Join before sending room events.")));
      ws.close(4403, "join required");
      return;
    }

    switch (parsed.type) {
      case "join":
        await this.ctx.blockConcurrencyWhile(() => this.handleJoin(ws, parsed));
        break;
      case "peer_data":
        await this.handlePeerData(ws, parsed);
        break;
      case "destroy":
        await this.destroyRoom("destroyed", parsed.creatorToken);
        break;
      case "kick_participant":
        await this.kickParticipant(ws, parsed);
        break;
      case "ping":
        await this.markRoomActivity();
        break;
    }
  }

  async webSocketClose(ws: RoomSocket): Promise<void> {
    await this.storageReady;
    const attachment = ws.deserializeAttachment() as AttachmentRecord | null;
    if (!attachment?.sessionId) {
      await this.scheduleNextAlarm();
      return;
    }

    // Runtime close handlers may remove the old socket before this queued
    // callback runs. A live replacement still owns the same member presence.
    if (this.isConnected(attachment.sessionId)) return;

    if (this.roomMeta?.status === "open") {
      this.roomMeta.membershipVersion += 1;
      await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    }
    await this.markRoomActivity();
    this.broadcast({
      type: "peer_left",
      sessionId: attachment.sessionId,
      membershipVersion: this.roomMeta?.membershipVersion ?? 0
    } satisfies PeerLeftEvent);
    await this.broadcastPresence();
  }

  private async bootstrapRoom(bootstrap: RoomBootstrap): Promise<Response> {
    if (this.roomMeta) {
      return jsonResponse({ error: "Room already initialized." }, 409);
    }

    const meta: RoomStorage = {
      roomId: bootstrap.roomId,
      createdAt: bootstrap.createdAt,
      expiresAt: bootstrap.expiresAt,
      inactivityTimeoutMs: bootstrap.inactivityTimeoutMs === undefined ? DEFAULT_INACTIVITY_TIMEOUT_MS : bootstrap.inactivityTimeoutMs,
      maxAgeMs: bootstrap.maxAgeMs ?? null,
      disappearAfterReadSeconds:
        bootstrap.disappearAfterReadSeconds === undefined ? DEFAULT_DISAPPEAR_AFTER_READ_SECONDS : bootstrap.disappearAfterReadSeconds,
      status: "open",
      participantCount: 0,
      creatorJoined: false,
      lastActivityAt: bootstrap.createdAt,
      membershipVersion: 0,
      admittedSessions: [],
      creatorToken: bootstrap.creatorToken
    };

    this.roomMeta = meta;
    await this.ctx.storage.put(ROOM_META_KEY, meta);
    await this.scheduleNextAlarm();
    return jsonResponse(this.publicMetadata(meta), 201);
  }

  private handleMetadata(): Response {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }

    return jsonResponse(this.publicMetadata(this.roomMeta));
  }

  private async handleJoin(ws: RoomSocket, payload: JoinPayload): Promise<void> {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      ws.send(JSON.stringify(errorEvent("room_unavailable", "Room is unavailable.")));
      ws.close(4404, "room unavailable");
      return;
    }

    const existing = ws.deserializeAttachment() as AttachmentRecord | null;
    if (existing?.sessionId) {
      ws.send(JSON.stringify(errorEvent("already_joined", "Session already joined.")));
      return;
    }

    if (
      !existing ||
      existing.connectedAt + JOIN_TIMEOUT_MS <= Date.now() ||
      typeof payload.sessionId !== "string" ||
      !payload.sessionId ||
      typeof payload.identityKey !== "string" ||
      !/^[A-Za-z0-9_-]{87}$/.test(payload.identityKey) ||
      typeof payload.agreementKey !== "string" ||
      !/^[A-Za-z0-9_-]{87}$/.test(payload.agreementKey)
    ) {
      ws.send(JSON.stringify(errorEvent("invalid_join", "Join was invalid or timed out.")));
      ws.close(4408, "invalid join");
      return;
    }

    // Seats belong to admitted identities, not live sockets: disconnecting must
    // not let another invitation turn this one-to-one room into a group.
    const admittedSessions = this.roomMeta.admittedSessions;
    const admitted = admittedSessions.find((session) => session.sessionId === payload.sessionId);
    if (admitted && (
      admitted.identityKey !== payload.identityKey || admitted.agreementKey !== payload.agreementKey
    )) {
      ws.send(JSON.stringify(errorEvent("identity_mismatch", "The session is already bound to another identity key.")));
      ws.close(4403, "identity mismatch");
      return;
    }
    if (!admitted && admittedSessions.length >= MAX_ADMITTED_PARTICIPANTS) {
      ws.send(JSON.stringify(errorEvent("room_full", "This room already has two participants.")));
      ws.close(4409, "room full");
      return;
    }

    const creatorCredential = payload.creatorToken === this.roomMeta.creatorToken;
    const tokenHash = (token: string) => createHash("sha256")
      .update(JSON.stringify([this.roomMeta!.roomId, payload.sessionId, token])).digest("hex");
    const presentedHash = typeof payload.reconnectToken === "string" ? tokenHash(payload.reconnectToken) : "";
    if (admitted && (admitted.reconnectRevoked || !(
      admitted.reconnectTokenHash
        ? presentedHash.length === admitted.reconnectTokenHash.length &&
          timingSafeEqual(Buffer.from(presentedHash), Buffer.from(admitted.reconnectTokenHash))
        : false
    ))) {
      ws.send(JSON.stringify(errorEvent("reconnect_required", "Your saved session could not be verified. A valid recovery credential is required.")));
      ws.close(4403, "reconnect required");
      return;
    }
    // Recovery authenticates the original seat, independent of invite expiry.
    const creator = admitted ? admitted.creator : creatorCredential;
    const admission: InviteAdmission = admitted
      ? { ok: true, newlyClaimed: false }
      : await this.reserveInviteForJoin(creator, payload);
    if (!admission.ok) {
      ws.send(JSON.stringify(errorEvent(admission.code, admission.message)));
      ws.close(4403, admission.closeReason);
      return;
    }
    // A first admission may save its random credential before joining, so a
    // dropped joined acknowledgement cannot strand the already-reserved seat.
    const proposedToken = typeof payload.reconnectToken === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(payload.reconnectToken) ? payload.reconnectToken : undefined;
    const reconnectToken = admitted?.reconnectTokenHash
      ? payload.reconnectToken!
      : proposedToken ?? randomBytes(32).toString("base64url");

    // Clear the superseded attachment before closing: its late close/message
    // callbacks must not remove the replacement or relay old session events.
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as AttachmentRecord | null;
      if (socket !== ws && attachment?.sessionId === payload.sessionId) {
        this.sendIfOpen(socket, JSON.stringify({
          type: "participant_kicked",
          sessionId: payload.sessionId,
          reason: "session-replaced"
        } satisfies ParticipantKickedEvent));
        socket.serializeAttachment({ ...attachment, sessionId: "" } satisfies AttachmentRecord);
        if (socket.readyState < 2) socket.close(4403, "session replaced");
      }
    }

    const session: AttachmentRecord = {
      sessionId: payload.sessionId,
      creator,
      connectedAt: Date.now(),
      identityKey: payload.identityKey,
      agreementKey: payload.agreementKey
    };
    if (!admitted) {
      admittedSessions.push({
        sessionId: payload.sessionId,
        identityKey: payload.identityKey,
        agreementKey: payload.agreementKey,
        creator,
        reconnectTokenHash: tokenHash(reconnectToken)
      });
    } else {
      admitted.creator = creator;
      admitted.reconnectTokenHash = tokenHash(reconnectToken);
    }
    ws.serializeAttachment(session satisfies AttachmentRecord);

    if (creator) {
      this.roomMeta.creatorJoined = true;
    }
    this.roomMeta.participantCount = this.connectedSessionIds().length;
    this.roomMeta.membershipVersion += 1;
    this.roomMeta.lastActivityAt = Date.now();
    await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);

    if (admission.invite && !admission.invite.consumedAt) {
      const admittedAt = Date.now();
      admission.invite.admittedAt = admittedAt;
      admission.invite.consumedAt = admittedAt;
      admission.invite.consumedBySessionId = payload.sessionId;
      this.invites.set(admission.invite.token, admission.invite);
      await this.persistInvites();
    }

    const peers = this.connectedSessions()
      .filter((peer) => peer.sessionId !== payload.sessionId)
      .sort((left, right) => left.connectedAt - right.connectedAt)
      .map((peer) => this.describePeer(peer));

    ws.send(
      JSON.stringify({
        type: "joined",
        reconnectToken,
        room: this.publicMetadata(this.roomMeta),
        sessionId: payload.sessionId,
        creator,
        self: this.describePeer(session),
        peers,
        presence: this.presenceSnapshot()
      } satisfies ServerEvent)
    );

    this.broadcastToOtherParticipants(payload.sessionId, {
      type: "peer_joined",
      peer: this.describePeer(session),
      membershipVersion: this.roomMeta.membershipVersion
    } satisfies PeerJoinedEvent);

    await this.broadcastPresence();
    await this.markRoomActivity();
  }

  private async reserveInviteForJoin(
    creator: boolean,
    payload: JoinPayload
  ): Promise<InviteAdmission> {
    if (creator) {
      return { ok: true, newlyClaimed: false };
    }

    const invite = payload.inviteToken ? this.invites.get(payload.inviteToken) : undefined;
    const now = Date.now();
    if (!invite || invite.revokedAt || invite.expiresAt <= now) {
      return {
        ok: false,
        code: "invite_required",
        message: "A valid one-time invite is required.",
        closeReason: "invite required"
      };
    }

    if (invite.consumedAt) {
      return {
        ok: false,
        code: "invite_used",
        message: "This one-time invite has already admitted another session.",
        closeReason: "invite used"
      };
    }

    if (invite.claimedAt) {
      if (invite.claimedBySessionId === payload.sessionId) {
        return { ok: true, invite, newlyClaimed: false };
      }
      return {
        ok: false,
        code: "invite_claimed",
        message: "This one-time invite is already being used by another session.",
        closeReason: "invite claimed"
      };
    }

    invite.claimedAt = now;
    invite.claimedBySessionId = payload.sessionId;
    this.invites.set(invite.token, invite);
    await this.persistInvites();
    return { ok: true, invite, newlyClaimed: true };
  }

  private async handlePeerData(ws: RoomSocket, payload: PeerDataRelayPayload): Promise<void> {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      ws.send(JSON.stringify(errorEvent("room_unavailable", "Room is unavailable.")));
      return;
    }

    const attachment = ws.deserializeAttachment() as AttachmentRecord | null;
    if (!attachment?.sessionId) {
      ws.send(JSON.stringify(errorEvent("join_required", "Join before relaying peer data.")));
      return;
    }

    const data = payload.data;
    if (
      !data ||
      data.protocolVersion !== 1 ||
      data.roomId !== this.roomMeta.roomId ||
      data.senderSessionId !== attachment.sessionId ||
      data.targetSessionId !== (payload.toSessionId ?? null) ||
      typeof data.eventId !== "string" ||
      typeof data.signature !== "string" ||
      !data.payload ||
      typeof data.payload.type !== "string"
    ) {
      ws.send(JSON.stringify(errorEvent("invalid_peer_event", "Peer event authentication metadata is invalid.")));
      return;
    }

    const event = {
      type: "peer_data",
      fromSessionId: attachment.sessionId,
      data: payload.data
    } satisfies PeerDataRelayEvent;

    if (payload.toSessionId) {
      if (!this.isConnected(payload.toSessionId)) {
        ws.send(JSON.stringify(errorEvent("peer_missing", "Peer is no longer connected.")));
        return;
      }
      this.broadcastToSessions([payload.toSessionId], event);
    } else {
      this.broadcastToOtherParticipants(attachment.sessionId, event);
    }

    await this.markRoomActivity();
  }

  private async kickParticipant(ws: RoomSocket, payload: KickParticipantPayload): Promise<void> {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      ws.send(JSON.stringify(errorEvent("room_unavailable", "Room is unavailable.")));
      return;
    }
    if (payload.creatorToken !== this.roomMeta.creatorToken) {
      ws.send(JSON.stringify(errorEvent("unauthorized", "Only the creator can kick participants.")));
      return;
    }
    const target = payload.targetSessionId;
    if (!this.isConnected(target)) {
      ws.send(JSON.stringify(errorEvent("peer_missing", "Participant is no longer connected.")));
      return;
    }
    await this.disconnectSession(target, "removed-by-creator", "kicked");
  }

  private async createInvite(creatorToken: string, ttlMs?: number): Promise<Response> {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }
    if (creatorToken !== this.roomMeta.creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }
    const now = Date.now();
    const token = randomUUID();
    const invite: RoomInvite = {
      token,
      createdAt: now,
      expiresAt: now + Math.max(60_000, ttlMs ?? DEFAULT_INVITE_TTL_MS)
    };
    this.invites.set(token, invite);
    await this.persistInvites();
    return jsonResponse(invite, 201);
  }

  private listInvites(creatorToken: string): Response {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }
    if (creatorToken !== this.roomMeta.creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }
    return jsonResponse(
      [...this.invites.values()].sort((left, right) => right.createdAt - left.createdAt)
    );
  }

  private async revokeInvite(creatorToken: string, token: string): Promise<Response> {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }
    if (creatorToken !== this.roomMeta.creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }
    const invite = this.invites.get(token);
    if (!invite) {
      return jsonResponse({ error: "Invite not found." }, 404);
    }
    invite.revokedAt = Date.now();
    this.invites.set(token, invite);
    await this.persistInvites();
    if (invite.consumedBySessionId) {
      await this.disconnectSession(invite.consumedBySessionId, "invite-revoked", "invite revoked");
    }
    return jsonResponse(invite);
  }

  private async destroyRoom(reason: string, creatorToken: string): Promise<Response> {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }

    if (creatorToken !== this.roomMeta.creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }

    await this.transitionRoom("destroyed", reason);
    return jsonResponse(this.publicMetadata(this.roomMeta));
  }

  private async transitionRoom(status: "expired" | "destroyed", reason: string): Promise<void> {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      return;
    }

    this.roomMeta.status = status;
    this.roomMeta.destroyedAt = Date.now();
    this.roomMeta.lastActivityAt = Date.now();
    await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    await this.ctx.storage.deleteAlarm();

    this.broadcast({
      type: "room_state",
      status,
      expiresAt: this.roomMeta.expiresAt,
      reason
    } satisfies RoomStateEvent);

    for (const socket of this.ctx.getWebSockets()) {
      socket.close(4000, status);
    }
  }

  private async expireIfDue(): Promise<boolean> {
    if (!this.roomMeta || this.roomMeta.status !== "open") return false;
    const reason = roomExpiryReason(this.roomMeta, Date.now(), this.connectedSessionIds().length);
    if (!reason) return false;
    await this.transitionRoom("expired", reason);
    return true;
  }

  private async markRoomActivity(): Promise<void> {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      return;
    }
    this.roomMeta.lastActivityAt = Date.now();
    await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      return;
    }

    const candidates = [
      this.roomMeta.expiresAt,
      typeof this.roomMeta.inactivityTimeoutMs === "number"
        ? this.roomMeta.lastActivityAt + this.roomMeta.inactivityTimeoutMs
        : undefined,
      ...this.openWebSockets()
        .map((socket) => socket.deserializeAttachment() as AttachmentRecord | null)
        .filter((attachment): attachment is AttachmentRecord => attachment?.sessionId === "")
        .map((attachment) => attachment.connectedAt + JOIN_TIMEOUT_MS)
    ].filter((value): value is number => typeof value === "number");

    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  private async persistInvites(): Promise<void> {
    await this.ctx.storage.put(INVITES_KEY, [...this.invites.entries()]);
  }

  private async broadcastPresence(): Promise<void> {
    if (!this.roomMeta) {
      return;
    }

    this.roomMeta.participantCount = this.connectedSessionIds().length;
    await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    this.broadcast({
      type: "presence",
      presence: this.presenceSnapshot()
    } satisfies PresenceEvent);
  }

  private async disconnectSession(
    targetSessionId: string,
    reason: string,
    closeReason: string
  ): Promise<void> {
    const admitted = this.roomMeta?.admittedSessions?.find(session => session.sessionId === targetSessionId);
    if (admitted) {
      admitted.reconnectRevoked = true;
      delete admitted.reconnectTokenHash;
    }
    this.broadcastToSessions([targetSessionId], {
      type: "participant_kicked",
      sessionId: targetSessionId,
      reason
    } satisfies ParticipantKickedEvent);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as AttachmentRecord | null;
      if (attachment?.sessionId === targetSessionId) {
        socket.serializeAttachment({ ...attachment, sessionId: "" } satisfies AttachmentRecord);
        socket.close(4403, closeReason);
      }
    }
    if (this.roomMeta?.status === "open") {
      this.roomMeta.membershipVersion += 1;
      await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    }
    this.broadcast({
      type: "peer_left",
      sessionId: targetSessionId,
      membershipVersion: this.roomMeta?.membershipVersion ?? 0
    } satisfies PeerLeftEvent);
    await this.broadcastPresence();
    await this.markRoomActivity();
  }

  private broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as AttachmentRecord | null;
      if (!attachment?.sessionId) continue;
      this.sendIfOpen(socket, payload);
    }
  }

  private broadcastToOtherParticipants(senderSessionId: string, event: ServerEvent): void {
    const targets = this.connectedSessionIds().filter((sessionId) => sessionId !== senderSessionId);
    this.broadcastToSessions(targets, event);
  }

  private broadcastToSessions(sessionIds: string[], event: ServerEvent): void {
    const payload = JSON.stringify(event);
    const allowed = new Set(sessionIds);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as AttachmentRecord | null;
      if (attachment?.sessionId && allowed.has(attachment.sessionId)) {
        this.sendIfOpen(socket, payload);
      }
    }
  }

  private sendIfOpen(socket: RoomSocket, payload: string): void {
    if (socket.readyState !== 1) {
      return;
    }
    try {
      socket.send(payload);
    } catch {
      // A peer can close between the readyState check and send. Its close
      // callback will update presence, so one failed broadcast should not fail
      // the room event that triggered it.
    }
  }

  private presenceSnapshot(): PresenceSnapshot {
    const ids = this.connectedSessionIds();
    return {
      count: ids.length,
      connectedSessionIds: ids
    };
  }

  // Source of truth for connected participants, derived from live sockets.
  // Deduplicated by session id.
  private connectedSessions(): AttachmentRecord[] {
    const seen = new Set<string>();
    const sessions: AttachmentRecord[] = [];
    for (const socket of this.openWebSockets()) {
      const attachment = socket.deserializeAttachment() as AttachmentRecord | null;
      if (attachment?.sessionId && !seen.has(attachment.sessionId)) {
        seen.add(attachment.sessionId);
        sessions.push(attachment);
      }
    }
    return sessions;
  }

  private connectedSessionIds(): string[] {
    return this.connectedSessions().map((session) => session.sessionId);
  }

  private openWebSockets(): RoomSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === 1);
  }

  private isConnected(sessionId: string): boolean {
    return this.connectedSessions().some((session) => session.sessionId === sessionId);
  }

  private describePeer(peer: AttachmentRecord): PeerDescriptor {
    return {
      sessionId: peer.sessionId,
      creator: peer.creator,
      connectedAt: peer.connectedAt,
      identityKey: peer.identityKey,
      agreementKey: peer.agreementKey
    };
  }

  private publicMetadata(meta: RoomStorage): RoomMetadata {
    return {
      roomId: meta.roomId,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      inactivityTimeoutMs: meta.inactivityTimeoutMs,
      maxAgeMs: meta.maxAgeMs,
      disappearAfterReadSeconds: meta.disappearAfterReadSeconds,
      status: meta.status,
      participantCount: this.connectedSessionIds().length,
      creatorJoined: meta.creatorJoined,
      lastActivityAt: meta.lastActivityAt,
      membershipVersion: meta.membershipVersion,
      destroyedAt: meta.destroyedAt
    };
  }
}
