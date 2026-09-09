import type {
  HealthStatus,
  ProcessingJobKind,
  ProcessingProgress,
} from "../types";
import { appLog } from "./logger";
import {
  onServiceOriginChange,
  resolveServiceOrigin,
  serviceAuthSubprotocol,
} from "./serviceOrigin";

export interface JobEvent extends ProcessingProgress {
  jobId: string;
  kind: ProcessingJobKind;
}

type Frame = Record<string, unknown> & { topic?: string; seq?: number };

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8000;

const jobListeners = new Set<(event: JobEvent) => void>();
const healthListeners = new Set<(status: HealthStatus) => void>();
const connectionListeners = new Set<(connected: boolean) => void>();
const lastSeq = new Map<string, number>();

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectDelayMs = RECONNECT_MIN_MS;
let connected = false;
let started = false;

function eventUrl(): string {
  const origin = resolveServiceOrigin() || window.location.origin;
  return `${origin.replace(/^http/, "ws")}/api/events`;
}

function setConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  connectionListeners.forEach((listener) => listener(next));
}

/**
 * Frames are advisory. Anything older than what we have already applied is
 * discarded, and a gap is harmless because callers re-read state over HTTP.
 */
function isFresh(frame: Frame): boolean {
  const topic = typeof frame.topic === "string" ? frame.topic : "";
  const seq = typeof frame.seq === "number" ? frame.seq : 0;
  if (!topic) return false;
  const previous = lastSeq.get(topic) ?? 0;
  if (seq !== 0 && seq <= previous) return false;
  lastSeq.set(topic, seq);
  return true;
}

function handleFrame(frame: Frame): void {
  if (!isFresh(frame)) return;
  if (frame.topic === "job") {
    jobListeners.forEach((listener) => listener(frame as unknown as JobEvent));
    return;
  }
  if (frame.topic === "health") {
    healthListeners.forEach((listener) =>
      listener(frame as unknown as HealthStatus),
    );
  }
}

function scheduleReconnect(): void {
  if (!started || reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
}

function connect(): void {
  // Absent in non-browser test environments; callers then stay on the HTTP
  // path, which is exactly the pre-existing behavior.
  if (!started || typeof WebSocket === "undefined") return;
  try {
    const authProtocol = serviceAuthSubprotocol();
    socket = authProtocol
      ? new WebSocket(eventUrl(), [authProtocol])
      : new WebSocket(eventUrl());
  } catch (error) {
    appLog.warn("events.channel.open-failed", {
      error: error instanceof Error ? error.message : error,
    });
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    reconnectDelayMs = RECONNECT_MIN_MS;
    lastSeq.clear();
    setConnected(true);
    appLog.info("events.channel.opened");
  };
  socket.onmessage = (message) => {
    try {
      handleFrame(JSON.parse(String(message.data)) as Frame);
    } catch {
      // A malformed frame is ignored; HTTP remains authoritative.
    }
  };
  socket.onclose = () => {
    socket = null;
    setConnected(false);
    scheduleReconnect();
  };
  socket.onerror = () => socket?.close();
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  onServiceOriginChange(() => {
    // Retarget immediately rather than waiting out the backoff.
    reconnectDelayMs = RECONNECT_MIN_MS;
    socket?.close();
  });
  connect();
}

export function isChannelConnected(): boolean {
  return connected;
}

export function subscribeToJobEvents(
  listener: (event: JobEvent) => void,
): () => void {
  ensureStarted();
  jobListeners.add(listener);
  return () => jobListeners.delete(listener);
}

export function subscribeToHealthEvents(
  listener: (status: HealthStatus) => void,
): () => void {
  ensureStarted();
  healthListeners.add(listener);
  return () => healthListeners.delete(listener);
}

export function subscribeToChannelState(
  listener: (connected: boolean) => void,
): () => void {
  ensureStarted();
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

/**
 * Resolve as soon as this job reports a transition, or when `timeoutMs`
 * elapses. With no channel it is a plain sleep, which is the original cadence.
 */
export function waitForJobEvent(
  jobId: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribe();
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    const unsubscribe = subscribeToJobEvents((event) => {
      if (event.jobId === jobId) finish();
    });
  });
}
