import { describe, expect, it } from 'vitest';
import { sameDescription } from './_shared/description.js';

describe('Channels description rendering equivalence', () => {
  it.each([
    ['正文\n#话题\n', '正文\n#话题'],
    ['正文\n#话题\n\n', '正文\n#话题\n'],
    ['正文\r\n#话题\r\n', '正文\n#话题'],
  ])('accepts only rendered line-ending differences', (actual, expected) => {
    expect(sameDescription(actual, expected)).toBe(true);
  });
  it.each([
    [' 正文', '正文'], ['正文 ', '正文'], ['正文\n #话题', '正文\n#话题'],
    ['正文\n\n#话题', '正文\n#话题'], ['正文#话题', '正文\n#话题'],
    ['正文\n#其他话题\n', '正文\n#话题'], [null, '正文'], [undefined, '正文'],
  ])('rejects body, paragraph, space or missing-value changes', (actual, expected) => {
    expect(sameDescription(actual, expected)).toBe(false);
  });
});
