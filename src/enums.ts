export enum PRChange {
  OPEN,
  MERGE,
  CLOSE,
}

export enum LogLevel {
  LOG,
  INFO,
  WARN,
  ERROR,
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

export enum CheckRunStatus {
  NEUTRAL = 'neutral',
  FAILURE = 'failure',
  SUCCESS = 'success',
}
