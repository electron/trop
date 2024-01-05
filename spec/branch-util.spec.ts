import { BranchMatcher, getBackportPattern } from '../src/utils/branch-util';

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

describe('BranchMatcher', () => {
  it('matches supported branches', () => {
    const bm = new BranchMatcher(/^(\d+)-x-y$/, 3);
    expect(bm.isBranchSupported('3-x-y')).toBeTruthy();
    expect(bm.isBranchSupported('192-x-y')).toBeTruthy();
    expect(bm.isBranchSupported('z-x-y')).toBeFalsy();
    expect(bm.isBranchSupported('foo')).toBeFalsy();
    expect(bm.isBranchSupported('3-x-y-z')).toBeFalsy();
    expect(bm.isBranchSupported('x3-x-y')).toBeFalsy();
    expect(bm.isBranchSupported('')).toBeFalsy();
  });

  it('sorts and filters release branches', () => {
    const bm = new BranchMatcher(/^(\d+)-x-y$/, 2);
    expect(
      bm.getSupportedBranches([
        '3-x-y',
        '6-x-y',
        '5-x-y',
        'unrelated',
        '4-x-y',
      ]),
    ).toStrictEqual(['5-x-y', '6-x-y']);
  });

  it('when one group is undefined, the branch with fewer groups wins', () => {
    const bm = new BranchMatcher(/^(\d+)-(?:(\d+)-x|x-y)$/, 2);
    expect(bm.getSupportedBranches(['6-x-y', '5-1-x', '5-x-y'])).toStrictEqual([
      '5-x-y',
      '6-x-y',
    ]);
  });

  it('can sort non-numeric groups', () => {
    const bm = new BranchMatcher(/^0\.([A-Z])$/, 2);
    expect(bm.getSupportedBranches(['0.F', '0.H', '0.G'])).toStrictEqual([
      '0.G',
      '0.H',
    ]);
  });
});
