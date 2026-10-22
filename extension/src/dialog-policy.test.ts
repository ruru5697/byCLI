import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function event() {
  const listeners = new Set<(...args: any[]) => void>();
  return { addListener: vi.fn((fn: (...args: any[]) => void) => listeners.add(fn)),
    removeListener: vi.fn((fn: (...args: any[]) => void) => listeners.delete(fn)),
    fire: (...args: any[]) => { for (const fn of [...listeners]) fn(...args); }, listeners };
}
const origin = 'https://channels.weixin.qq.com';

describe('operation-scoped dialog policy', () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  async function setup() {
    const onEvent = event(), onDetach = event(), onRemoved = event();
    const sendCommand = vi.fn(async (_target: chrome.debugger.Debuggee, _method: string, _params?: Record<string, unknown>) => ({}));
    vi.stubGlobal('chrome', { debugger: { onEvent, onDetach, sendCommand }, tabs: { onRemoved } });
    const policy = await import('./dialog-policy');
    return { ...policy, onEvent, onDetach, onRemoved, sendCommand };
  }
  it('accepts all ordinary same-origin dialogs on the exact tab, only once per opening', async () => {
    const p = await setup();
    await p.startDialogPolicy('token', 'lease', 1, origin, 1000);
    for (const type of ['alert', 'confirm', 'beforeunload']) {
      const detail = { type, url: origin + '/platform/post/create' };
      p.onEvent.fire({ tabId: 2 }, 'Page.javascriptDialogOpening', detail);
      p.onEvent.fire({ tabId: 1 }, 'Page.javascriptDialogOpening', detail);
      p.onEvent.fire({ tabId: 1 }, 'Page.javascriptDialogOpening', detail);
      p.onEvent.fire({ tabId: 1 }, 'Page.javascriptDialogClosed', {});
    }
    await Promise.resolve();
    expect(p.sendCommand.mock.calls.filter(call => call[1] === 'Page.handleJavaScriptDialog')).toHaveLength(3);
    expect(p.stopDialogPolicy('token', 'lease')).toEqual({ accepted: 3, beforeUnload: 1 });
    expect(p.onEvent.listeners.size).toBe(0);
    p.onEvent.fire({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'confirm', url: origin });
    expect(p.sendCommand).toHaveBeenCalledTimes(4);
  });
  it.each([{ type: 'prompt', url: origin }, { type: 'confirm', url: 'https://other.example' }])('leaves unsupported/other-origin dialogs for manual handling: %j', async detail => {
    const p = await setup(); await p.startDialogPolicy('token', 'lease', 1, origin, 1000);
    p.onEvent.fire({ tabId: 1 }, 'Page.javascriptDialogOpening', detail);
    expect(() => p.assertDialogPolicy('token', 'lease', 1)).toThrow('manual input or belongs to another origin');
    expect(p.sendCommand).toHaveBeenCalledTimes(1);
    p.stopDialogPolicy('token', 'lease');
  });
  it.each(['expiry', 'detach', 'close'])('removes authority and listeners on %s', async how => {
    const p = await setup(); await p.startDialogPolicy('token', 'lease', 1, origin, 1000);
    if (how === 'expiry') await vi.advanceTimersByTimeAsync(1000);
    if (how === 'detach') p.onDetach.fire({ tabId: 1 });
    if (how === 'close') p.onRemoved.fire(1);
    expect(() => p.assertDialogPolicy('token', 'lease', 1)).toThrow('expired or page/lease changed');
    expect(p.onEvent.listeners.size).toBe(0); expect(p.onDetach.listeners.size).toBe(0); expect(p.onRemoved.listeners.size).toBe(0);
  });
  it('fences tokens to their lease and tab and refuses overlaps', async () => {
    const p = await setup(); await p.startDialogPolicy('token', 'lease', 1, origin, 1000);
    expect(() => p.assertDialogPolicy('token', 'another', 1)).toThrow();
    expect(() => p.assertDialogPolicy('token', 'lease', 2)).toThrow();
    expect(() => p.stopDialogPolicy('token', 'another')).toThrow();
    await expect(p.startDialogPolicy('another', 'lease', 1, origin, 1000)).rejects.toThrow('already active');
    await p.startDialogPolicy('token', 'lease', 1, origin, 1000); // Idempotent setup retry.
    expect(p.sendCommand).toHaveBeenCalledTimes(1);
    p.stopDialogPolicy('token', 'lease');
  });
  it('registers before Page.enable can replay an existing dialog', async () => {
    const p = await setup();
    p.sendCommand.mockImplementation(async (_target: any, method: string) => {
      if (method === 'Page.enable') p.onEvent.fire({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'beforeunload', url: origin });
      return {};
    });
    await p.startDialogPolicy('token', 'lease', 1, origin, 1000);
    expect(p.stopDialogPolicy('token', 'lease')).toEqual({ accepted: 1, beforeUnload: 1 });
  });
  it('remembers an existing dialog without accepting it until a matching operation starts', async () => {
    const p = await setup(); p.registerDialogTracking();
    p.onEvent.fire({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'beforeunload', url: origin });
    expect(p.sendCommand).not.toHaveBeenCalled();
    await p.startDialogPolicy('token', 'lease', 1, origin, 1000);
    await Promise.resolve();
    expect(p.stopDialogPolicy('token', 'lease')).toEqual({ accepted: 1, beforeUnload: 1 });
  });
  it('releases every scope on bridge disconnect so reconnect can resume immediately', async () => {
    const p = await setup();
    await p.startDialogPolicy('first', 'lease-1', 1, origin, 1000);
    await p.startDialogPolicy('second', 'lease-2', 2, origin, 1000);
    p.clearDialogPolicies();
    expect(p.hasDialogPolicy(1)).toBe(false); expect(p.hasDialogPolicy(2)).toBe(false);
    await p.startDialogPolicy('new', 'lease-1', 1, origin, 1000);
    p.stopDialogPolicy('new', 'lease-1');
  });
  it('bounds setup when Chrome cannot describe an old unobserved modal', async () => {
    const p = await setup(); p.sendCommand.mockImplementation(() => new Promise(() => {}));
    const starting = p.startDialogPolicy('token', 'lease', 1, origin, 10000);
    const rejected = expect(starting).rejects.toThrow('unobserved existing modal');
    await vi.advanceTimersByTimeAsync(3000); await rejected;
    expect(p.hasDialogPolicy(1)).toBe(false); expect(p.onEvent.listeners.size).toBe(0);
  });
});
