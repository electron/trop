export enum PRChange {
  OPEN,
  CLOSE,
}

// trop comment labeling prefixes
export enum PRStatus {
  TARGET = 'target/',
  MERGED = 'merged/',
  IN_FLIGHT = 'in-flight/',
  NEEDS_MANUAL = 'needs-manual-bp/',
}

// trop repo setup constants
export enum TropAction {
  INIT_REPO = 'INIT_REPO',
  SET_UP_REMOTES = 'SET_UP_REMOTES',
  BACKPORT = 'BACKPORT',
}
