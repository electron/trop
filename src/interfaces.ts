export interface TropConfig {
  targetLabelPrefix?: string;
  inFlightLabelPrefix?: string;
  mergedLabelPrefix?: string;
  needsManualLabelPrefix?: string;
  authorizedUsers?: string[];
}

export interface RemotesOptions {
  dir: string;
  remotes: {
    name: string,
    value: string,
  }[];
}
