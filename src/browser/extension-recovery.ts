/**
 * A stale daemon connection record can report a connected extension that does not
 * advertise a capability the extension actually ships. The handshake is sent once per
 * WebSocket, so reconnecting is enough to refresh it — no manual extension reload.
 */
export interface ExtensionRecoveryDeps {
  /** Share one recovery attempt between concurrent uploads in this profile. */
  contextId?: string;
  /** Close the current extension socket so it re-handshakes on reconnect. */
  requestReconnect: () => Promise<boolean>;
  /** Current capability list for the extension connection, or undefined when unknown. */
  fetchCapabilities: () => Promise<string[] | undefined>;
  sleep?: (ms: number) => Promise<void>;
  /** Total time to wait for the refreshed handshake. */
  timeoutMs?: number;
  /** Delay between capability polls. */
  intervalMs?: number;
}

export const EXTENSION_RECOVERY_TIMEOUT_MS = 10_000;
export const EXTENSION_RECOVERY_INTERVAL_MS = 250;

const recoveringProfiles = new Map<string, Promise<boolean>>();

export async function recoverExtensionCapability(
  capability: string,
  deps: ExtensionRecoveryDeps,
): Promise<boolean> {
  const key = deps.contextId ? `${deps.contextId}:${capability}` : undefined;
  if (!key) return attemptRecovery(capability, deps);
  const existing = recoveringProfiles.get(key);
  if (existing) return existing;
  const attempt = attemptRecovery(capability, deps);
  recoveringProfiles.set(key, attempt);
  try { return await attempt; }
  finally { recoveringProfiles.delete(key); }
}

async function attemptRecovery(
  capability: string,
  deps: ExtensionRecoveryDeps,
): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? EXTENSION_RECOVERY_TIMEOUT_MS;
  const intervalMs = deps.intervalMs ?? EXTENSION_RECOVERY_INTERVAL_MS;

  const advertised = await deps.fetchCapabilities().catch(() => undefined);
  if (advertised?.includes(capability)) return true;

  try {
    if (!await deps.requestReconnect()) return false;
  } catch {
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const capabilities = await deps.fetchCapabilities().catch(() => undefined);
    if (capabilities?.includes(capability)) return true;
  }
  return false;
}

/** True when the daemon refused a command because the extension did not advertise a capability. */
export function isExtensionCapabilityMissing(error: unknown): boolean {
  if (error instanceof Error && 'code' in error) {
    return /^extension_capability_missing$/i.test(String(error.code ?? ''))
      || /does not advertise/i.test(error.message);
  }
  return /does not advertise/i.test(error instanceof Error ? error.message : String(error));
}
