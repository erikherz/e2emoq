// Live chat client: connects to the per-stream ChatRoom Durable Object over WebSocket,
// renders messages, and lets the user pick an ephemeral display name. Used by both the
// broadcaster and viewers. Returns a teardown function.
//
// Security: all strings are rendered with textContent (never innerHTML), so message text
// and names can never inject markup.
//
// END-TO-END ENCRYPTED. Name and text are sealed together before they leave the page, under
// a key derived from the share link's #k= fragment through a different HKDF context than
// the video. The Durable Object relays a blob it cannot read, so chat is exactly as private
// as the stream it accompanies.

import type { User } from "../auth";
import { openText, sealText } from "../crypto/media-crypto";

/** What travels: an opaque envelope. */
interface WireMsg {
  id: string;
  ct: string;
  ts: number;
}

/** What we render, after opening the envelope. */
interface ChatMsg {
  id: string;
  name: string;
  text: string;
  ts: number;
}

const NAME_KEY = "earthseed-chat-name";

function loadName(user: User | null): string {
  const saved = localStorage.getItem(NAME_KEY);
  if (saved && saved.trim()) return saved.trim();
  if (user?.name) return user.name;
  return `Guest-${Math.random().toString(16).slice(2, 6)}`;
}

export interface ChatHandle {
  destroy: () => void;
}

export function initChat(opts: {
  streamId: string;
  container: HTMLElement;
  user: User | null;
  /**
   * Chat key, derived from the same link secret as the media key. A GETTER, not a value:
   * the broadcaster only learns the stream salt at go-live (which may be after this panel
   * opens), and regenerating a passcode re-keys mid-session. Deriving per use means chat
   * always follows the same inputs as the video instead of pinning stale ones.
   */
  chatKey: () => Promise<CryptoKey>;
}): ChatHandle {
  const { streamId, container, user } = opts;
  let displayName = loadName(user);

  container.innerHTML = `
    <div class="chat-head">
      <span class="chat-title">Live chat</span>
      <button class="chat-name-btn" type="button" title="Change your display name"></button>
    </div>
    <div class="chat-msgs" role="log" aria-live="polite"></div>
    <form class="chat-form">
      <input class="chat-text" type="text" maxlength="500" placeholder="Say something…" autocomplete="off" />
      <button class="chat-send" type="submit" aria-label="Send">➤</button>
    </form>
  `;

  const nameBtn = container.querySelector(".chat-name-btn") as HTMLButtonElement;
  const head = container.querySelector(".chat-head") as HTMLElement;
  const msgsEl = container.querySelector(".chat-msgs") as HTMLElement;
  const form = container.querySelector(".chat-form") as HTMLFormElement;
  const input = container.querySelector(".chat-text") as HTMLInputElement;

  const renderNameBtn = () => {
    nameBtn.textContent = `${displayName} ✎`;
  };
  renderNameBtn();

  // Inline display-name editor: swap the name button for an input; Enter/blur commits.
  nameBtn.addEventListener("click", () => {
    const editor = document.createElement("input");
    editor.type = "text";
    editor.maxLength = 32;
    editor.value = displayName;
    editor.className = "chat-name-edit";
    nameBtn.replaceWith(editor);
    editor.focus();
    editor.select();
    const commit = () => {
      const next = editor.value.trim().slice(0, 32);
      if (next) {
        displayName = next;
        localStorage.setItem(NAME_KEY, displayName);
      }
      renderNameBtn();
      editor.replaceWith(nameBtn);
    };
    editor.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { renderNameBtn(); editor.replaceWith(nameBtn); }
    });
    editor.addEventListener("blur", commit);
  });

  const nearBottom = () => msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 48;

  const appendMessage = (m: ChatMsg) => {
    const stick = nearBottom();
    const row = document.createElement("div");
    row.className = "chat-msg";
    const name = document.createElement("span");
    name.className = "chat-msg-name";
    name.textContent = m.name;
    const text = document.createElement("span");
    text.className = "chat-msg-text";
    text.textContent = m.text;
    row.append(name, text);
    msgsEl.appendChild(row);
    // Keep the DOM bounded for long sessions.
    while (msgsEl.childElementCount > 200) msgsEl.removeChild(msgsEl.firstChild as Node);
    if (stick) msgsEl.scrollTop = msgsEl.scrollHeight;
  };

  // --- WebSocket with reconnect/backoff ---
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (online: boolean) => {
    head.classList.toggle("chat-offline", !online);
  };

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/streams/${streamId}/chat`);

    ws.addEventListener("open", () => {
      retry = 0;
      setStatus(true);
    });
    ws.addEventListener("message", (ev) => {
      let data: { type?: string; messages?: WireMsg[] } & Partial<WireMsg>;
      try { data = JSON.parse(ev.data as string); } catch { return; }

      // Messages sealed under a different key — history from before a salt rotation or a
      // passcode change — simply do not open. Skipping them silently is right: they are not
      // errors, they are messages this viewer was never meant to read.
      const show = async (m: WireMsg) => {
        const plain = await openText(await opts.chatKey(), m.ct);
        if (!plain) return;
        try {
          const { name, text } = JSON.parse(plain) as { name: string; text: string };
          if (text) appendMessage({ id: m.id, name: name || "Guest", text, ts: m.ts });
        } catch { /* not a message we understand */ }
      };

      if (data.type === "history" && Array.isArray(data.messages)) {
        msgsEl.replaceChildren();
        const list = data.messages;
        // Sequential so history keeps its order despite each open being async.
        void (async () => { for (const m of list) await show(m); })();
      } else if (data.type === "msg" && data.id && data.ct) {
        void show(data as WireMsg);
      }
    });
    ws.addEventListener("close", () => {
      setStatus(false);
      if (closed) return;
      // Exponential backoff capped at 10s.
      const delay = Math.min(10000, 500 * 2 ** retry++);
      reconnectTimer = setTimeout(connect, delay);
    });
    ws.addEventListener("error", () => ws?.close());
  };
  connect();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    input.value = ""; // clear immediately; sealing is async and the user has moved on
    // Name and text are sealed TOGETHER, so the display name is no more visible to the
    // server than the message is.
    void opts
      .chatKey()
      .then((k) => sealText(k, JSON.stringify({ name: displayName, text })))
      .then((ct) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "msg", ct }));
      });
  });

  return {
    destroy() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
      container.replaceChildren();
    },
  };
}
