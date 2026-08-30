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
      // Components too, where the assertion is about the markup a cell emits rather than about
      // anything a user does to it: renderToStaticMarkup wants no DOM, so these run in the same
      // plain node environment as everything above. This line is why they run at all - the .ts
      // glob above does not match .tsx, and a component test outside it is a test nobody runs.
      'webapp/src/routes/**/*.test.tsx',
      // The same, for what the shell draws rather than what a route does: a component shared by
      // several screens lives in components/, and the glob above stops at routes/. This line
      // was added the day one such test was written and silently never ran - the runner said
      // "no test files found", which is a sentence easy to read as "nothing to do here".
      'webapp/src/components/**/*.test.tsx',
      'ui/src/**/*.test.ts'
    ],
    // Fixture-backed IO tests run slowly on constrained CI runners (Windows fs,
    // armv7 under QEMU), so the ceiling is generous; local runs are unaffected.
    testTimeout: 30_000
  }
})
