export const CHECK_PREFIX = 'Backportable? - ';

export const BACKPORT_INFORMATION_CHECK = 'Backport Labels Added';

export const NUM_SUPPORTED_VERSIONS = process.env.NUM_SUPPORTED_VERSIONS || 4;

export const BACKPORT_LABEL = 'backport';

export const NO_BACKPORT_LABEL = 'no-backport';

export const SEMVER_PREFIX = 'semver/';

export const SKIP_CHECK_LABEL =
  process.env.SKIP_CHECK_LABEL || 'backport-check-skip';

export const BACKPORT_REQUESTED_LABEL =
  process.env.BACKPORT_REQUESTED_LABEL || 'backport/requested 🗳';

export const DEFAULT_BACKPORT_REVIEW_TEAM =
  process.env.DEFAULT_BACKPORT_REVIEW_TEAM;
