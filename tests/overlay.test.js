import { describe, it, expect, afterEach } from 'vitest';
import { XA } from './helpers/load.js';

const hosts = () => document.querySelectorAll('#x-archive-overlay-host');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { document.body.innerHTML = ''; });

describe('overlay mount race', () => {
  it('concurrent show/update/mount calls produce exactly one host', async () => {
    const o = new XA.content.Overlay({});
    const css = deferred();
    o.loadCss = () => css.promise;

    const p1 = o.mount();
    const p2 = o.mount();
    o.show();
    o.update({ state: 'running', posts: 3, activeElapsedMs: 1000 });
    const p3 = o.mount();

    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    expect(hosts()).toHaveLength(0);

    css.resolve('.x{}');
    await p1;
    await flush();

    expect(hosts()).toHaveLength(1);
    expect(o.host).toBeTruthy();
    expect(o.els.count.textContent).toBe('3');
  });

  it('remove during a pending mount leaves zero hosts; a later show mounts normally', async () => {
    const o = new XA.content.Overlay({});
    const css = deferred();
    o.loadCss = () => css.promise;

    const pending = o.mount();
    o.show();
    o.update({ state: 'running', posts: 5, activeElapsedMs: 2000 });
    o.remove();
    css.resolve('.x{}');
    await pending;
    await flush();
    await flush();

    expect(hosts()).toHaveLength(0);
    expect(o.host).toBeNull();
    expect(o.visible).toBe(false);
    expect(o.mountPromise).toBeNull();

    const css2 = deferred();
    o.loadCss = () => css2.promise;
    o.show();
    const remount = o.mountPromise;
    expect(remount).toBeTruthy();
    css2.resolve('.x{}');
    await remount;
    await flush();

    expect(hosts()).toHaveLength(1);
    expect(o.host).toBeTruthy();
    expect(o.visible).toBe(true);
  });

  it('a second overlay instance removes a stale duplicate host on append', async () => {
    const stray = document.createElement('div');
    stray.id = 'x-archive-overlay-host';
    document.body.appendChild(stray);

    const o = new XA.content.Overlay({});
    o.loadCss = async () => '.x{}';
    await o.mount();
    await flush();

    const all = hosts();
    expect(all).toHaveLength(1);
    expect(all[0]).not.toBe(stray);
  });
});
