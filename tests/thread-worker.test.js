import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  it('rejects a concurrent job and still handles cancel before the busy guard', () => {
    const worker = {
      busy: true,
      processJob: vi.fn(),
      requestCancel: vi.fn()
    };
    const busyResponse = vi.fn();
    expect(XA.content.threadHelpers.handleThreadJobMessage(worker, { job: { id: 'next' } }, busyResponse)).toBe(false);
    expect(busyResponse).toHaveBeenCalledWith({ ok: false, error: 'fulfillment worker is already busy' });
    expect(worker.processJob).not.toHaveBeenCalled();

    const cancelResponse = vi.fn();
    expect(XA.content.threadHelpers.handleThreadJobMessage(worker, { action: 'cancel' }, cancelResponse)).toBe(false);
    expect(worker.requestCancel).toHaveBeenCalledOnce();
    expect(cancelResponse).toHaveBeenCalledWith({ ok: true });
  });

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

  it('marks an unclassified render timeout as blocked', async () => {
    document.body.innerHTML = '';
    const worker = new XA.content.ThreadWorker();
    worker.waitForArticles = async () => false;
    await worker.processJob({ id: 'run1:789', statusId: '789', url: 'https://x.com/alice/status/789' });
    const result = msgs.find((message) => message.type === M.XAR_THREAD_RESULT);
    expect(result.diagnostics.blockedReason).toBe('render_timeout');
    expect(result.diagnostics.error).toMatch(/no posts rendered/);
  });

  it('marks unexpected worker errors as blocked', async () => {
    const worker = new XA.content.ThreadWorker();
    worker.waitForArticles = async () => { throw new Error('unexpected extraction error'); };
    await worker.processJob({ id: 'run1:790', statusId: '790', url: 'https://x.com/alice/status/790' });
    const result = msgs.find((message) => message.type === M.XAR_THREAD_RESULT);
    expect(result.diagnostics.blockedReason).toBe('worker_error');
    expect(result.diagnostics.error).toBe('unexpected extraction error');
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
