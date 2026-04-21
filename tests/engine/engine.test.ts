import { describe, expect, it } from 'vitest';
import { boolOption, stringOption } from '../../src/engine/engine.js';

describe('boolOption', () => {
  const cases: Array<[string, unknown, boolean, boolean]> = [
    ['native true', true, true, true],
    ['native false', false, false, true],
    ['string "true"', 'true', true, true],
    ['string "TRUE"', 'TRUE', true, true],
    ['string "yes"', 'yes', true, true],
    ['string "1"', '1', true, true],
    ['string "false"', 'false', false, true],
    ['string "FALSE"', 'FALSE', false, true],
    ['string "no"', 'no', false, true],
    ['string "0"', '0', false, true],
    ['number 1', 1, true, true],
    ['number 0', 0, false, true],
    ['string "maybe"', 'maybe', false, false],
    ['null', null, false, false],
    ['undefined value', undefined, false, false],
    ['object', { x: 1 }, false, false],
  ];

  for (const [label, raw, expectedValue, expectedFound] of cases) {
    it(label, () => {
      const res = boolOption({ k: raw }, 'k');
      expect(res.value).toBe(expectedValue);
      expect(res.found).toBe(expectedFound);
    });
  }

  it('missing key → not found', () => {
    expect(boolOption({}, 'k')).toEqual({ value: false, found: false });
    expect(boolOption(undefined, 'k')).toEqual({ value: false, found: false });
  });
});

describe('stringOption', () => {
  it('returns the value when present and a string', () => {
    expect(stringOption({ k: 'hello' }, 'k')).toEqual({ value: 'hello', found: true });
  });
  it('returns not-found when key missing', () => {
    expect(stringOption({}, 'k')).toEqual({ value: '', found: false });
    expect(stringOption(undefined, 'k')).toEqual({ value: '', found: false });
  });
  it('returns not-found when value is not a string', () => {
    expect(stringOption({ k: 42 }, 'k')).toEqual({ value: '', found: false });
    expect(stringOption({ k: true }, 'k')).toEqual({ value: '', found: false });
  });
});
