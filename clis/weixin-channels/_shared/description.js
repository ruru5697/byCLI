// Native rich-text rendering can add terminal line breaks that are not part
// of the description body. Keep this platform-specific: generic fillText must
// continue reporting its exact actual value and verification result.
export function sameDescription(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const canonical = text => text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return canonical(actual) === canonical(expected);
}
