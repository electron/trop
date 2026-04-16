import type { BackportExtension } from './types';
import { electronPatchesExtension } from './electron-patches';

export { electronPatchesExtension, type BackportExtension };

export const defaultExtensions: BackportExtension[] = [
  electronPatchesExtension,
];
