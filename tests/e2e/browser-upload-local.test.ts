/** Real CLI core + daemon + extension + Chrome. Only disposable about:blank
 * and loopback .test fixtures; never opens a platform or uses a user profile.
 * npm run build && npm run build:extension
 * BYCLI_UPLOAD_E2E=1 CHROME_PATH=... npx vitest run --project e2e tests/e2e/browser-upload-local.test.ts
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { Page } from '../../src/browser/page.js';
import { CDPBridge } from '../../src/browser/cdp.js';
import * as daemonClient from '../../src/browser/daemon-client.js';
import { sameDescription } from '../../clis/weixin-channels/_shared/description.js';

let directory = '', daemon: ChildProcess, chrome: ChildProcess, port = 0, fixtureBuildId = '';
const root = resolve(import.meta.dirname, '../..');
const originalPort = process.env.BYCLI_DAEMON_PORT, originalConfig = process.env.BYCLI_CONFIG_DIR;
let page: Page;
let diagnostic = '';
let lastStatus: unknown;
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value !== undefined) return value; } catch { /* startup only */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Upload smoke timed out: ${label}; last_status=${JSON.stringify(lastStatus)}; ${diagnostic}`);
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
beforeAll(async () => {
  const executable = process.env.CHROME_PATH;
  if (!executable) throw new Error('Set CHROME_PATH to an extension-capable Chromium executable');
  directory = await mkdtemp(join(tmpdir(), 'bycli-upload-e2e-'));
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  process.env.BYCLI_DAEMON_PORT = String(port); process.env.BYCLI_CONFIG_DIR = join(directory, 'config');
  const temporary = join(directory, 'tmp'); await mkdir(temporary);
  const environment = { ...process.env, TMPDIR: temporary, BYCLI_CDP_ENDPOINT: '', BYCLI_PROFILE: '', BYCLI_CONTEXT_ID: '' };
  daemon = spawn(process.execPath, [join(root, 'dist/src/daemon.js')], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stdout?.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-4000); });
  daemon.stderr?.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-4000); });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/ping`)).ok ? true : undefined, 'daemon');
  const extension = join(directory, 'extension'); await mkdir(extension);
  for (const file of ['manifest.json', 'popup.html', 'popup.js', 'icons', 'dist']) await cp(join(root, 'extension', file), join(extension, file), { recursive: true });
  const script = join(extension, 'dist/background.js');
  let bundle = await readFile(script, 'utf8');
  const info = JSON.parse(await readFile(join(extension, 'dist/build-info.json'), 'utf8'));
  const patched = bundle.replace('const DAEMON_PORT = 19825;', `const DAEMON_PORT = ${port};`);
  if (patched === bundle) throw new Error('Isolated bridge port patch did not match');
  fixtureBuildId = createHash('sha256').update(patched).digest('hex');
  bundle = patched.replaceAll(info.buildId, fixtureBuildId); await writeFile(script, bundle);
  await writeFile(join(extension, 'dist/build-info.json'), JSON.stringify({ ...info, buildId: fixtureBuildId, scriptSha256: createHash('sha256').update(bundle).digest('hex') }));
  chrome = spawn(executable, [`--user-data-dir=${join(directory, 'profile')}`, '--remote-debugging-port=0', '--headless=new',
    '--host-resolver-rules=MAP bycli-dialog.test 127.0.0.1',
    '--no-first-run', '--no-proxy-server', '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--disable-features=DisableLoadExtensionCommandLineSwitch', '--enable-unsafe-extension-debugging', 'about:blank'], { env: environment, stdio: 'ignore' });
  const endpoint = await until(async () => {
    const lines = (await readFile(join(directory, 'profile/DevToolsActivePort'), 'utf8')).trim().split('\n');
    return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
  }, 'Chrome');
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(endpoint), timer = setTimeout(() => { socket.close(); reject(new Error('Extension loading timed out')); }, 10_000);
    socket.once('error', reject);
    socket.once('open', () => socket.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: extension } })));
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString()); if (message.id !== 1) return;
      clearTimeout(timer); socket.close(); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve();
    });
  });
  // Inspect the actual worker, including startup exceptions, when hello never arrives.
  const inspectWorker = async () => new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(endpoint); let sequence = 0;
    const pending = new Map<number, (message: any) => void>();
    const timer = setTimeout(() => { socket.close(); resolve('worker diagnostic timed out'); }, 3000);
    const rpc = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>(done => {
      const id = ++sequence; pending.set(id, done); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? {sessionId} : {}) }));
    });
    socket.on('message', bytes => { const message = JSON.parse(bytes.toString()); pending.get(message.id)?.(message); });
    socket.on('error', reject);
    socket.on('open', async () => {
      try {
        const targets = await rpc('Target.getTargets');
        const worker = targets.result?.targetInfos?.find((t: any) => t.type === 'service_worker');
        if (!worker) { resolve(JSON.stringify(targets)); return; }
        const attached = await rpc('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
        const probe = await rpc('Runtime.evaluate', { expression: `(async()=>({ build:globalThis.__BYCLI_RUNTIME_BUILD_ID__, ping:await fetch('http://127.0.0.1:${port}/ping').then(r=>r.status).catch(e=>String(e)) }))()`, returnByValue: true, awaitPromise: true }, attached.result?.sessionId);
        resolve(JSON.stringify(probe));
      } catch (error) { resolve(String(error)); }
      finally { clearTimeout(timer); socket.close(); }
    });
  });
  try {
  await until(async () => {
    const status = await (await fetch(`http://127.0.0.1:${port}/status`, { headers: { 'X-byCLI': '1' } })).json() as any;
    lastStatus = status;
    return status.extensionBuildId === fixtureBuildId ? status : undefined;
  }, 'executing extension build identity');
  } catch (error) { throw new Error(`${String(error)}; worker=${await inspectWorker()}`); }
  page = new Page('upload-fixture');
}, 45_000);
afterAll(async () => {
  await stop(chrome); await stop(daemon);
  if (originalPort === undefined) delete process.env.BYCLI_DAEMON_PORT; else process.env.BYCLI_DAEMON_PORT = originalPort;
  if (originalConfig === undefined) delete process.env.BYCLI_CONFIG_DIR; else process.env.BYCLI_CONFIG_DIR = originalConfig;
  if (directory) await rm(directory, { recursive: true, force: true });
});
it('injects video and image into nested open shadows, and rejects missing/ambiguous targets without changing the selected file', async () => {
  await page.evaluate(`document.body.innerHTML = '<wujie-app></wujie-app>'; const root = document.querySelector('wujie-app').attachShadow({mode:'open'}); root.innerHTML = '<nested-app></nested-app>'; root.querySelector('nested-app').attachShadow({mode:'open'}).innerHTML = '<input id="video" type="file" accept="video/*"><input id="cover" type="file" accept="image/*">';`);
  for (const [id, name] of [['video', 'video.mp4'], ['cover', 'cover.jpg']]) {
    const file = join(directory, name); await writeFile(file, `local ${id} fixture`);
    expect(await page.uploadFiles(`#${id}`, [file])).toMatchObject({ uploaded: true, files: 1, file_names: [name] });
  }
  await expect(page.uploadFiles('input[type=file]', [join(directory, 'cover.jpg')])).rejects.toMatchObject({ code: 'selector_ambiguous' });
  await expect(page.setFileInput([join(directory, 'cover.jpg')], '#missing')).rejects.toMatchObject({ code: 'upload_not_started' });
  expect(await page.evaluate(`document.querySelector('wujie-app').shadowRoot.querySelector('nested-app').shadowRoot.querySelector('#video').files[0].name`)).toBe('video.mp4');
}, 30_000);

it.each(['clear', 'replace'])('observes the consumed image after a real change handler %ss its input without reinjecting', async mode => {
  await page.evaluate(`(() => {
    document.body.innerHTML = '<wujie-app></wujie-app>';
    const root = document.querySelector('wujie-app').attachShadow({mode:'open'});
    root.innerHTML = '<input id="consumed-cover" type="file" accept="image/png"><img id="preview">';
    window.__imageReady = false; window.__changeCount = 0;
    const input = root.querySelector('input'), image = root.querySelector('img');
    image.onload = () => { window.__imageReady = image.naturalWidth === 1; };
    input.addEventListener('change', () => {
      window.__changeCount++; const selected = input.files[0];
      window.__selectedName = selected.name; image.src = URL.createObjectURL(selected);
      input.value = '';
      if (${JSON.stringify(mode)} === 'replace') input.replaceWith(input.cloneNode());
    });
  })()`);
  const data = await page.evaluate<string>(`(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; return canvas.toDataURL('image/png').split(',')[1]; })()`);
  const file = join(directory, `consumed-${mode}.png`); await writeFile(file, Buffer.from(data, 'base64'));
  const native = vi.spyOn(page, 'setFileInput');
  try {
    expect(await page.uploadFiles('#consumed-cover', [file])).toMatchObject({ uploaded: true, files: 1, file_names: [], file_list_verified: false });
    await until(async () => await page.evaluate<boolean>('window.__imageReady') ? true : undefined, 'consumed image preview');
    expect(await page.evaluate('window.__changeCount')).toBe(1);
    expect(await page.evaluate('window.__selectedName')).toBe(`consumed-${mode}.png`);
    expect(native).toHaveBeenCalledTimes(1);
  } finally { native.mockRestore(); }
}, 30_000);

it('keeps generic native fill exact while Channels accepts terminal rich-editor line breaks', async () => {
  // A local rendering contract, not a capture or a live Channels page.
  await page.evaluate(`(() => { document.body.innerHTML = '<wujie-app></wujie-app>';
    const root = document.querySelector('wujie-app').attachShadow({mode:'open'});
    root.innerHTML = '<div id="description" contenteditable="true" style="white-space:pre-wrap;min-height:80px"></div>';
    const editor = root.querySelector('#description');
    editor.addEventListener('input', () => editor.append(document.createElement('br'))); })()`);
  const nativeType = vi.spyOn(page, 'nativeType');
  try {
    for (const text of ['第一段。\n第二段 #数据治理', '第一段。\n第二段 #数据治理\n']) {
      const filled = await page.fillText('#description', text);
      expect(filled).toMatchObject({ filled: true, verified: false, mode: 'contenteditable' });
      expect(filled.actual).not.toBe(text);
      expect(sameDescription(filled.actual, text)).toBe(true);
      expect(sameDescription(filled.actual, text.replace('数据治理', '其他内容'))).toBe(false);
    }
    expect(nativeType).toHaveBeenCalledTimes(2);
    for (const result of nativeType.mock.results) {
      expect(result.type).toBe('return');
      await expect(result.value).resolves.toBeUndefined();
    }
  } finally { nativeType.mockRestore(); }
}, 30_000);

it('accepts real ordinary dialogs and a beforeunload during guarded navigation, and recovers an already open dialog', async () => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><body style="margin:0"><button style="width:200px;height:70px">Activate</button><div>Local dialog fixture</div></body>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://bycli-dialog.test:${(server.address() as { port: number }).port}`;
  const stopPolicy = vi.spyOn(daemonClient, 'sendCommandOnce');
  try {
    console.info('dialog-fixture: initial navigation');
    await page.goto(origin + '/editor', { stealth: false });
    console.info('dialog-fixture: starting scope');
    await page.withAcceptedDialogs(origin, async () => {
      console.info('dialog-fixture: confirm');
      expect(await page.evaluate(`confirm('Local confirmation')`)).toBe(true);
      await page.evaluate(`alert('Local alert')`);
      await page.nativeClick(50, 30); // Real user activation required by Chrome.
      expect(await page.evaluate(`navigator.userActivation.hasBeenActive`)).toBe(true);
      await page.evaluate(`window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; });`);
      console.info('dialog-fixture: beforeunload navigation');
      await page.goto(origin + '/drafts', { stealth: false });
      console.info('dialog-fixture: navigation completed');
      expect(await page.evaluate(`location.pathname`)).toBe('/drafts');
    }, 15000);
    const firstStop = stopPolicy.mock.calls.findIndex(([action, params]) => action === 'dialog-policy' && params?.op === 'stop');
    expect(firstStop).toBeGreaterThanOrEqual(0);
    await expect(stopPolicy.mock.results[firstStop].value).resolves.toMatchObject({ accepted: 3, beforeUnload: 1 });

    // A previously timed-out caller may have left a modal open. Merely tracking
    // it must not dismiss it; a fresh matching scope explicitly accepts it.
    console.info('dialog-fixture: existing modal recovery');
    const existing = page.evaluate(`confirm('Already open local confirmation')`);
    let settled = false; void existing.then(() => { settled = true; }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    await page.withAcceptedDialogs(origin, async () => { expect(await existing).toBe(true); }, 10000);

    // Independently exercise the direct-CDP provider on this same disposable
    // fixture. No real site or user browser is involved.
    console.info('dialog-fixture: direct CDP provider');
    const devtoolsPort = (await readFile(join(directory, 'profile/DevToolsActivePort'), 'utf8')).trim().split('\n')[0];
    const bridge = new CDPBridge();
    try {
      const direct = await bridge.connect({ cdpEndpoint: `ws://127.0.0.1:${devtoolsPort}/devtools/page/${page.getActivePage()}` });
      const send = vi.spyOn(bridge, 'send');
      await direct.withAcceptedDialogs!(origin, async () => {
        expect(await direct.evaluate(`confirm('Direct local confirmation')`)).toBe(true);
        await direct.evaluate(`alert('Direct local alert')`);
        await direct.nativeClick!(50, 30);
        expect(await direct.evaluate(`navigator.userActivation.hasBeenActive`)).toBe(true);
        await direct.evaluate(`window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; });`);
        await direct.goto(origin + '/direct-drafts');
        expect(await direct.evaluate(`location.pathname`)).toBe('/direct-drafts');
      }, 15000);
      expect(send.mock.calls.filter(([method]) => method === 'Page.handleJavaScriptDialog')).toHaveLength(3);
      console.info('dialog-fixture: cold CDP connection with existing modal');
      const pending = direct.evaluate(`confirm('Cold connection local confirmation')`);
      void pending.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 200));
      const coldBridge = new CDPBridge();
      try {
        await expect(coldBridge.connect({ cdpEndpoint: `ws://127.0.0.1:${devtoolsPort}/devtools/page/${page.getActivePage()}`, timeout: 1 })).rejects.toThrow('existing browser dialog');
      } finally { await coldBridge.close(); }
      // The original connection knows the type and origin and can recover it.
      await direct.withAcceptedDialogs!(origin, async () => { expect(await pending).toBe(true); }, 10000);
      console.info('dialog-fixture: original connection recovered cold modal');
    } finally { await bridge.close(); }
    // Saved-draft resume must resolve the current owned lease before arming
    // dialogs, instead of pinning the durable operation's closed target.
    const closedTarget = page.getActivePage();
    // Keep another owned tab so close removes the target rather than retaining
    // the container's last tab as a reusable about:blank placeholder.
    await new Page('sibling-fixture').evaluate('true');
    await page.closeTab(closedTarget);
    page = new Page('upload-fixture');
    await page.withAcceptedDialogs(origin, async () => {
      await page.goto(origin + '/drafts-reopened', { stealth: false });
      expect(await page.evaluate('location.pathname')).toBe('/drafts-reopened');
    }, 10000);
    expect(page.getActivePage()).not.toBe(closedTarget);
  } finally {
    stopPolicy.mockRestore();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30_000);
