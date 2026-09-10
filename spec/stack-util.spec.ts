import { describe, expect, it } from 'vitest';

import { getEffectiveBaseRef, StackablePR } from '../src/utils/stack-util';

describe('getEffectiveBaseRef', () => {
  const pr = { base: { ref: 'fix/some-parent' } } as StackablePR;

  it('returns the base ref of a PR that is not in a stack', () => {
    expect(getEffectiveBaseRef(pr)).toEqual('fix/some-parent');
    expect(getEffectiveBaseRef({ ...pr, stack: null })).toEqual(
      'fix/some-parent',
    );
  });

  it('returns the base ref of the stack for a stacked PR', () => {
    const stacked = {
      ...pr,
      stack: {
        number: 8,
        size: 2,
        position: 2,
        base: { ref: 'main', sha: 'DEF' },
      },
    };
    expect(getEffectiveBaseRef(stacked)).toEqual('main');
  });
});
