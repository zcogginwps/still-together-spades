// WebSocket wrapper that survives the phone locking, the browser backgrounding
// the tab, and the usual cellular hiccups. It re-joins the same seat on its own.
export class Net extends EventTarget {
  constructor() {
    super();
    this.socket = null;
    this.ready = false;
    this.attempt = 0;
    this.queue = [];
    this.rejoin = null;          // { code, name, playerId } replayed after a drop
    this.intentionalClose = false;
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  connect() {
    this.intentionalClose = false;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;

    const socket = new WebSocket(this.url());
    this.socket = socket;

    socket.onopen = () => {
      this.ready = true;
      this.attempt = 0;
      this.emit('open');
      if (this.rejoin) this.raw({ t: 'join', ...this.rejoin });
      const pending = this.queue.splice(0);
      for (const msg of pending) this.raw(msg);
    };

    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.emit('message', msg);
      this.emit(msg.t, msg);
    };

    socket.onclose = () => {
      this.ready = false;
      this.emit('close');
      if (this.intentionalClose) return;
      this.attempt += 1;
      const wait = Math.min(800 * 2 ** (this.attempt - 1), 8000) + Math.random() * 400;
      setTimeout(() => this.connect(), wait);
    };

    socket.onerror = () => { /* onclose handles the retry */ };
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  raw(msg) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Send now if we can, otherwise hold it until the socket is back. */
  send(msg) {
    if (!this.raw(msg)) {
      this.queue.push(msg);
      this.connect();
    }
  }

  setRejoin(info) { this.rejoin = info; }

  close() {
    this.intentionalClose = true;
    this.rejoin = null;
    try { this.socket?.close(); } catch { /* already gone */ }
  }
}
