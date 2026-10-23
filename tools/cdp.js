'use strict';
// Tiny Chrome DevTools Protocol client over --remote-debugging-pipe (no npm deps).

const { spawn } = require('child_process');

class Browser {
  constructor(exe, args) {
    this.proc = spawn(exe, [...args, '--remote-debugging-pipe'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    this.out = this.proc.stdio[3];
    this.in = this.proc.stdio[4];
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    let buf = '';
    this.in.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
          else resolve(msg.result);
        } else if (msg.method) {
          for (const l of this.listeners) l(msg);
        }
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.out.write(JSON.stringify(msg) + '\0');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 60000);
      t.unref?.();
    });
  }

  on(fn) { this.listeners.push(fn); }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  async evaluate(sessionId, expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  close() {
    this.pending.clear();
    try { this.out.destroy(); } catch { /* ignore */ }
    try { this.in.destroy(); } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* already gone */ }
  }
}

module.exports = { Browser };
