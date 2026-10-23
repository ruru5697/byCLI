import { describe, it, expect, vi } from 'vitest';
import { recoverExtensionCapability, isExtensionCapabilityMissing } from './extension-recovery.js';
import { BrowserCommandError } from './daemon-client.js';

const noSleep = async () => {};

describe('extension capability recovery', () => {
  it('does nothing when the capability is already advertised', async () => {
    const requestReconnect = vi.fn();
    await expect(recoverExtensionCapability('file-input-shadow-v1', {
      requestReconnect,
      fetchCapabilities: async () => ['file-input-shadow-v1'],
      sleep: noSleep,
    })).resolves.toBe(true);
    expect(requestReconnect).not.toHaveBeenCalled();
  });

  it('reconnects and waits for the refreshed handshake', async () => {
    const requestReconnect = vi.fn(async () => true);
    let calls = 0;
    const fetchCapabilities = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? [] : ['file-input-shadow-v1'];
    });
    await expect(recoverExtensionCapability('file-input-shadow-v1', {
      requestReconnect,
      fetchCapabilities,
      sleep: noSleep,
    })).resolves.toBe(true);
    expect(requestReconnect).toHaveBeenCalledTimes(1);
  });

  it('gives up after the timeout instead of looping forever', async () => {
    let now = 0;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await expect(recoverExtensionCapability('file-input-shadow-v1', {
        requestReconnect: async () => true,
        fetchCapabilities: async () => [],
        sleep: async (ms) => { now += ms; },
        timeoutMs: 1_000,
        intervalMs: 250,
      })).resolves.toBe(false);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('reports failure when the daemon cannot drop the socket', async () => {
    await expect(recoverExtensionCapability('file-input-shadow-v1', {
      requestReconnect: async () => { throw new Error('daemon down'); },
      fetchCapabilities: async () => [],
      sleep: noSleep,
    })).resolves.toBe(false);
  });

  it('treats an unreachable status endpoint as unknown, not as success', async () => {
    await expect(recoverExtensionCapability('file-input-shadow-v1', {
      requestReconnect: async () => true,
      fetchCapabilities: async () => { throw new Error('offline'); },
      sleep: noSleep,
      timeoutMs: 1,
    })).resolves.toBe(false);
  });
});

describe('capability-missing detection', () => {
  it('recognises the daemon error code', () => {
    expect(isExtensionCapabilityMissing(new BrowserCommandError('nope', 'extension_capability_missing'))).toBe(true);
  });

  it('recognises the legacy message shape', () => {
    expect(isExtensionCapabilityMissing(new Error('Connected Browser Bridge does not advertise file-input-shadow-v1.'))).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isExtensionCapabilityMissing(new Error('setFileInput returned no count'))).toBe(false);
    expect(isExtensionCapabilityMissing(new BrowserCommandError('timeout', 'command_timeout'))).toBe(false);
  });
});


describe('profile recovery coordination',()=>{
 it('stops immediately when the daemon refuses reconnection',async()=>{
  const fetchCapabilities=vi.fn(async()=>[]),sleep=vi.fn();
  await expect(recoverExtensionCapability('file-input-shadow-v1',{requestReconnect:async()=>false,fetchCapabilities,sleep})).resolves.toBe(false);
  expect(fetchCapabilities).toHaveBeenCalledTimes(1);expect(sleep).not.toHaveBeenCalled();
 });
 it('shares a recovery between simultaneous uploads in one profile',async()=>{
  let ready=false;
  const requestReconnect=vi.fn(async()=>{ready=true;return true;});
  const deps={contextId:'profile-a',requestReconnect,fetchCapabilities:async()=>ready?['file-input-shadow-v1']:[],sleep:noSleep};
  await expect(Promise.all([recoverExtensionCapability('file-input-shadow-v1',deps),recoverExtensionCapability('file-input-shadow-v1',deps)])).resolves.toEqual([true,true]);
  expect(requestReconnect).toHaveBeenCalledTimes(1);
  ready=false;
  await recoverExtensionCapability('file-input-shadow-v1',deps);
  expect(requestReconnect).toHaveBeenCalledTimes(2);
 });
 it('keeps recovery attempts for different profiles independent',async()=>{
  const deps=()=>{let ready=false;return {requestReconnect:vi.fn(async()=>{ready=true;return true;}),fetchCapabilities:async()=>ready?['file-input-shadow-v1']:[],sleep:noSleep};};
  const a=deps(),b=deps();
  await Promise.all([recoverExtensionCapability('file-input-shadow-v1',{...a,contextId:'profile-a'}),recoverExtensionCapability('file-input-shadow-v1',{...b,contextId:'profile-b'})]);
  expect(a.requestReconnect).toHaveBeenCalledTimes(1);expect(b.requestReconnect).toHaveBeenCalledTimes(1);
 });
});
