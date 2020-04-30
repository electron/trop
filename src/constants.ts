export const CHECK_PREFIX = 'Backportable? - ';

export const NUM_SUPPORTED_VERSIONS = 4;

export const SKIP_CHECK_LABEL = process.env.SKIP_CHECK_LABEL || 'backport-check-skip';

export const BACKPORT_PATTERN = /(?:^|\n)(?:manual |manually )?backport.*(?:#(\d+)|\/pull\/(\d+))/gim;
