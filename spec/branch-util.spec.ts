import { getBackportPattern } from '../src/utils/branch-util';

describe('getBackportPattern', () => {
  it('matches backport patterns correctly', () => {
    const examples = [
      'Backport of https://github.com/electron/electron/pull/27514',
      'Manually backport https://github.com/electron/electron/pull/27514',
      'Manual backport of https://github.com/electron/electron/pull/27514',
      'Manually backport #27514',
      'Manually backport of #27514',
      'Manual backport of #27514',
      'Backport of #27514',
    ];

    for (const example of examples) {
      const pattern = getBackportPattern();
      expect(pattern.test(example)).toEqual(true);
    }
  });
});
