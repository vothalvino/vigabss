const {
  findUnsafeReason, compileSafeRegex, MAX_REGEX_PATTERN_LENGTH,
} = require('../src/utils/safeRegex');

describe('safeRegex', () => {
  test.each([
    ['(a+)+$'],
    ['(a*)*b'],
    ['(\\w+\\s?)*$'],
    ['(?:x{2,})+'],
    ['((ab)+c)*'],
    ['(a+){2,}'],
    ['(a)\\1'],
    ['(?<n>a)\\k<n>'],
  ])('rejects %p', (pattern) => {
    expect(findUnsafeReason(pattern)).not.toBeNull();
    expect(compileSafeRegex(pattern).ok).toBe(false);
  });

  test.each([
    ['^/ip service set telnet disabled=(yes|no)$'],
    ['password=\\S+'],
    ['(ab)+'],
    ['(a+)?b'],
    ['(a{1,3})+'],
    ['[(a+)]+'],
    ['\\(a+\\)+'],
    ['(?:snmp community)\\s+\\w+'],
  ])('accepts %p', (pattern) => {
    expect(findUnsafeReason(pattern)).toBeNull();
    expect(compileSafeRegex(pattern).ok).toBe(true);
  });

  test('enforces the length cap', () => {
    expect(findUnsafeReason('a'.repeat(MAX_REGEX_PATTERN_LENGTH))).toBeNull();
    expect(findUnsafeReason('a'.repeat(MAX_REGEX_PATTERN_LENGTH + 1))).toMatch(/exceeds/);
  });

  test('reports invalid syntax', () => {
    const out = compileSafeRegex('(unclosed');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/invalid regular expression/);
  });

  test('rejects non-string / empty input', () => {
    expect(findUnsafeReason('')).not.toBeNull();
    expect(findUnsafeReason(undefined)).not.toBeNull();
  });
});
