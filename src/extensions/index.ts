export { BackportExtension } from './types';
export { electronPatchesExtension } from './electron-patches';

import { BackportExtension } from './types';
import { electronPatchesExtension } from './electron-patches';

export const defaultExtensions: BackportExtension[] = [
  electronPatchesExtension,
];
