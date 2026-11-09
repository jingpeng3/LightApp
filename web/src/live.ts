import { useEffect, useState, useSyncExternalStore } from "react";
import type { Change } from "./api";

type Listener = (change: Change) => void;
export type LiveStatus = "connecting" | "live" | "offline";

const listeners = new Set<Listener>();
const statusListeners = new Set<() => void>();
let status: LiveStatus = "connecting";
let lastSeq: number | null = null;

function setStatus(next: LiveStatus) {
  status = next;
  statusListeners.forEach((fn) => fn());
}

/** 订阅所有实时变更。返回取消订阅函数。 */
export function onChange(fn: Listener) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function useLiveStatus() {
  return useSyncExternalStore(
    (fn) => {
      statusListeners.add(fn);
      return () => void statusListeners.delete(fn);
    },
    () => status,
  );
}

/** 订阅变更的 hook；fn 每次渲染都可以是新函数。 */
export function useChanges(fn: Listener) {
  const [ref] = useState(() => ({ fn }));
  ref.fn = fn;
  useEffect(() => onChange((c) => ref.fn(c)), [ref]);
}

/** 订阅某个域的变更；断线后指数退避重连，并用 since 补拉漏掉的事件。切换域时先停掉旧连接再调用。 */
export function startLive(domain: string) {
  lastSeq = null;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let delay = 500;

  const connect = () => {
    setStatus("connecting");
    const url = new URL("/api/ws", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("domain", domain);
    if (lastSeq !== null) url.searchParams.set("since", String(lastSeq));
    ws = new WebSocket(url);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "hello") {
        lastSeq = msg.seq;
        delay = 500;
        setStatus("live");
      } else if (msg.type === "change") {
        if (lastSeq !== null && msg.change.seq <= lastSeq) return;
        lastSeq = msg.change.seq;
        listeners.forEach((fn) => fn(msg.change));
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      ws = null;
      setStatus("offline");
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (ws) {
      ws.onmessage = ws.onclose = null;
      ws.close();
    }
  };
}
