export const CHECK_PREFIX = 'Backportable? - ';

export const BACKPORT_INFORMATION_CHECK = 'Backport Labels Added';

export const NUM_SUPPORTED_VERSIONS = parseInt(
  process.env.NUM_SUPPORTED_VERSIONS || '3',
  10,
);

export const BACKPORT_LABEL = 'backport';

export const NO_BACKPORT_LABEL = 'no-backport';

export const SEMVER_PREFIX = 'semver/';

export const SEMVER_LABELS = {
  PATCH: 'semver/patch',
  MINOR: 'semver/minor',
  MAJOR: 'semver/major',
};

export const BACKPORT_REVIEW_LABELS = {
  SKIP: process.env.SKIP_CHECK_LABEL || 'backport-check-skip',
  REQUESTED: process.env.BACKPORT_REQUESTED_LABEL || 'backport/requested 🗳',
  APPROVED: 'backport/approved ✅',
};

export const DEFAULT_BACKPORT_REVIEW_TEAM =
  process.env.DEFAULT_BACKPORT_REVIEW_TEAM;
