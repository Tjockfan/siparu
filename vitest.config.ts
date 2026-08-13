import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Plugin unit tests, plus the framework-free webapp lib and map tests.
    include: [
      'plugin/test/**/*.test.ts',
      'webapp/src/lib/**/*.test.ts',
      'webapp/src/map/**/*.test.ts',
      // Framework-free logic that lives beside a route (e.g. the bridge's data derivations). A
      // component test needing a DOM would have to set jsdom on itself; nothing here does.
      'webapp/src/routes/**/*.test.ts',
      'ui/src/**/*.test.ts'
    ],
    // Fixture-backed IO tests run slowly on constrained CI runners (Windows fs,
    // armv7 under QEMU), so the ceiling is generous; local runs are unaffected.
    testTimeout: 30_000
  }
})
