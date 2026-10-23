/** Explicit, expiring acceptance of ordinary dialogs on one tab and origin. */
type Policy = {
  token: string; lease: string; tabId: number; origin: string;
  accepted: number; beforeUnload: number; failure?: string;
  dispose: () => void;
};
const policies = new Map<string, Policy>();
const ordinary = new Set(['alert', 'confirm', 'beforeunload']);
const pendingDialogs = new Map<number, { source: chrome.debugger.Debuggee; detail: { type?: string; url?: string } }>();
let tracking = false;

/** Remember existing dialogs without accepting them outside an operation. */
export function registerDialogTracking(): void {
  if (tracking) return;
  tracking = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    if (method === 'Page.javascriptDialogOpening') {
      const detail = params as { type?: string; url?: string };
      pendingDialogs.set(source.tabId, { source, detail: { type: detail?.type, url: detail?.url } });
    } else if (method === 'Page.javascriptDialogClosed') pendingDialogs.delete(source.tabId);
  });
  chrome.debugger.onDetach.addListener(source => { if (source.tabId !== undefined) pendingDialogs.delete(source.tabId); });
  chrome.tabs.onRemoved.addListener(tabId => pendingDialogs.delete(tabId));
}

export function hasDialogPolicy(tabId: number): boolean {
  return [...policies.values()].some(policy => policy.tabId === tabId);
}

export function clearDialogPolicies(): void {
  for (const policy of [...policies.values()]) policy.dispose();
}

export function assertDialogPolicy(token: string, lease: string, tabId?: number): void {
  const policy = policies.get(token);
  if (!policy || policy.lease !== lease || policy.tabId !== tabId) throw new Error('Dialog policy expired or page/lease changed; inspect the retained editor before resuming');
  if (policy.failure) throw new Error(policy.failure);
}

export function stopDialogPolicy(token: string, lease: string): { accepted: number; beforeUnload: number } {
  const policy = policies.get(token);
  if (!policy) return { accepted: 0, beforeUnload: 0 };
  if (policy.lease !== lease) throw new Error('Dialog policy belongs to another browser lease');
  policy.dispose();
  return { accepted: policy.accepted, beforeUnload: policy.beforeUnload };
}

export async function startDialogPolicy(token: string, lease: string, tabId: number, origin: string, timeoutMs: number): Promise<void> {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('Dialog policy requires an exact HTTP(S) origin');
  if (!/^[\w-]{1,100}$/.test(token) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1860000) throw new Error('Invalid dialog policy token or timeout');
  const existing = policies.get(token);
  if (existing) { assertDialogPolicy(token, lease, tabId); return; }
  if (hasDialogPolicy(tabId)) throw new Error('A dialog policy is already active on this tab');
  let active = true;
  let open = false;
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  let interruptSetup!: (error: Error) => void;
  const setupInterrupted = new Promise<never>((_resolve, reject) => { interruptSetup = reject; });
  const policy: Policy = { token, lease, tabId, origin, accepted: 0, beforeUnload: 0, dispose: () => {
    active = false;
    interruptSetup(new Error('Dialog policy stopped or expired'));
    clearTimeout(timer);
    if (setupTimer) clearTimeout(setupTimer);
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    policies.delete(token);
  } };
  const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (!active || source.tabId !== tabId) return;
    if (method === 'Page.javascriptDialogClosed') { open = false; return; }
    if (method !== 'Page.javascriptDialogOpening' || open) return;
    open = true;
    const event = params as { type?: string; url?: string } | undefined;
    let matches = false;
    try { matches = new URL(event?.url ?? '').origin === origin; } catch { /* unverified origin */ }
    if (!matches || !ordinary.has(event?.type ?? '')) {
      policy.failure = 'Browser dialog requires manual input or belongs to another origin; it was not accepted';
      interruptSetup(new Error(policy.failure));
      return;
    }
    // Preserve the emitting frame session. Never accept a dialog on another tab.
    void chrome.debugger.sendCommand(source, 'Page.handleJavaScriptDialog', { accept: true }).then(() => {
      policy.accepted++;
      if (event?.type === 'beforeunload') policy.beforeUnload++;
    }, () => { policy.failure = 'Browser dialog acceptance failed; inspect the retained editor'; });
  };
  const onDetach = (source: chrome.debugger.Debuggee) => { if (source.tabId === tabId) policy.dispose(); };
  const onRemoved = (id: number) => { if (id === tabId) policy.dispose(); };
  const timer = setTimeout(() => policy.dispose(), timeoutMs);
  policies.set(token, policy);
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  chrome.tabs.onRemoved.addListener(onRemoved);
  try {
    const pending = pendingDialogs.get(tabId);
    if (pending) onEvent(pending.source, 'Page.javascriptDialogOpening', pending.detail);
    setupTimer = setTimeout(() => interruptSetup(new Error('Dialog setup timed out; an unobserved existing modal may need manual cancellation before resuming')), 3000);
    await Promise.race([chrome.debugger.sendCommand({ tabId }, 'Page.enable'), setupInterrupted]);
    clearTimeout(setupTimer);
  }
  catch (error) { policy.dispose(); throw error; }
}
