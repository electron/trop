/// <reference types="vitest/config" />
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    // build-tools ships its own vitest suite inside the vendored checkout.
    exclude: [...configDefaults.exclude, '.build-tools/**'],
  },
});
