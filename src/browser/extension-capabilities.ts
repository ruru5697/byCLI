export const FILE_INPUT_SHADOW_CAPABILITY = 'file-input-shadow-v1';
export const DIALOG_POLICY_CAPABILITY = 'dialog-policy-v1';
export const FOCUS_WINDOW_CAPABILITY = 'focus-window-v1';
export const IMA_READER_CAPABILITY = 'ima-reader-v1';
export const CONSOLE_CAPTURE_CAPABILITY = 'console-capture-v1';
export const EXTENSION_CAPABILITY_MISSING_ERROR_CODE = 'extension_capability_missing';
export const EXTENSION_CAPABILITY_MISSING_HTTP_STATUS = 412;

const IMA_READER_ACTIONS = new Set([
  'ima-auth-start',
  'ima-auth-read',
  'ima-reader-request',
  'ima-media-request',
  'ima-auth-release',
]);

export function normalizeExtensionCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))];
}

export function requiredExtensionCapability(command: { action?: unknown; op?: unknown; dialogToken?: unknown }): string | undefined {
  if (command.action === 'dialog-policy') return DIALOG_POLICY_CAPABILITY;
  if (command.action === 'set-file-input') return FILE_INPUT_SHADOW_CAPABILITY;
  if (command.action === 'console-messages') return CONSOLE_CAPTURE_CAPABILITY;
  if (command.action === 'tabs' && command.op === 'focus') return FOCUS_WINDOW_CAPABILITY;
  return typeof command.action === 'string' && IMA_READER_ACTIONS.has(command.action)
    ? IMA_READER_CAPABILITY
    : undefined;
}

export function missingRequiredExtensionCapability(
  command: { action?: unknown; op?: unknown; dialogToken?: unknown },
  capabilities: readonly string[],
): string | undefined {
  if (command.dialogToken && !capabilities.includes(DIALOG_POLICY_CAPABILITY)) return DIALOG_POLICY_CAPABILITY;
  const required = requiredExtensionCapability(command);
  return required && !capabilities.includes(required) ? required : undefined;
}

export function extensionCapabilityHint(capability: string): string {
  if (capability === DIALOG_POLICY_CAPABILITY) return 'Update and reload the Browser Bridge extension with scoped dialog support; keep the original operation and resume without uploading again.';
  if (capability === CONSOLE_CAPTURE_CAPABILITY) {
    return 'Update and reload the byCLI Browser Bridge extension with console capture support, then retry.';
  }
  if (capability === FOCUS_WINDOW_CAPABILITY) {
    return 'Update and reload the byCLI Browser Bridge extension, then retry the login flow.';
  }
  if (capability === IMA_READER_CAPABILITY) {
    return 'Update and reload the byCLI Browser Bridge extension with private ima reader support, then retry.';
  }
  return 'Update and reload the byCLI Browser Bridge extension, then retry.';
}
