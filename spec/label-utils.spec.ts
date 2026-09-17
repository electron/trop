import { describe, expect, it } from 'vitest';

import { SEMVER_LABELS } from '../src/constants';
import { getHighestSemverLabel } from '../src/utils/label-utils';

describe('getHighestSemverLabel', () => {
  it('ranks major above minor above patch', () => {
    expect(
      getHighestSemverLabel(SEMVER_LABELS.PATCH, SEMVER_LABELS.MAJOR),
    ).toEqual(SEMVER_LABELS.MAJOR);
    expect(
      getHighestSemverLabel(SEMVER_LABELS.MINOR, SEMVER_LABELS.PATCH),
    ).toEqual(SEMVER_LABELS.MINOR);
  });

  it('ranks semver/none below every other semver label', () => {
    expect(
      getHighestSemverLabel(SEMVER_LABELS.NONE, SEMVER_LABELS.PATCH),
    ).toEqual(SEMVER_LABELS.PATCH);
    expect(
      getHighestSemverLabel(SEMVER_LABELS.PATCH, SEMVER_LABELS.NONE),
    ).toEqual(SEMVER_LABELS.PATCH);
    expect(getHighestSemverLabel(SEMVER_LABELS.NONE)).toEqual(
      SEMVER_LABELS.NONE,
    );
  });

  it('throws on an unknown semver label', () => {
    expect(() => getHighestSemverLabel('semver/huge')).toThrow(
      'Invalid semver labels',
    );
  });
});
