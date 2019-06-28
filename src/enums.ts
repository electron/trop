export enum PRChange {
  OPEN,
  CLOSE,
}

export enum BackportPurpose {
  ExecuteBackport,
  Check,
}

// trop comment labeling prefixes
export enum PRStatus {
  TARGET = 'target/',
  MERGED = 'merged/',
  IN_FLIGHT = 'in-flight/',
  NEEDS_MANUAL = 'needs-manual-bp/',
}
