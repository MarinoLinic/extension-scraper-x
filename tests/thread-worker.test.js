import { describe, it, expect, beforeEach } from 'vitest';
import { XA } from './helpers/load.js';
import '../src/content/thread-controller.js';

const M = XA.messages.MSG;

let msgs;

beforeEach(() => {
  msgs = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => { msgs.push(msg); if (cb) cb(); }
    }
  };
});

describe('thread worker cancellation', () => {
  it('reports a cancelled result immediately instead of hanging the queue', async () => {
    const w = new XA.content.ThreadWorker();
    const p = w.processJob({
      id: 'run1:123', statusId: '123',
      url: 'https://x.com/alice/status/123', authorHandle: 'alice'
    });
    w.cancelled = true;
    await p;
    const res = msgs.find((m) => m.type === M.XAR_THREAD_RESULT);
    expect(res).toBeTruthy();
    expect(res.jobId).toBe('run1:123');
    expect(res.diagnostics.cancelled).toBe(true);
    expect(res.diagnostics.error).toBeTruthy();
  });

  it('still reports a cancelled result when no articles ever render', async () => {
    const w = new XA.content.ThreadWorker();
    const p = w.processJob({
      id: 'run1:456', statusId: '456',
      url: 'https://x.com/alice/status/456', authorHandle: 'alice'
    });
    setTimeout(() => { w.cancelled = true; }, 50);
    await p;
    const res = msgs.find((m) => m.type === M.XAR_THREAD_RESULT);
    expect(res).toBeTruthy();
    expect(res.diagnostics.cancelled).toBe(true);
    expect(res.posts).toEqual([]);
  });
});
