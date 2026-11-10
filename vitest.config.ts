import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The fixture tests create real git repositories; Windows is slower than Linux.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
