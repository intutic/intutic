import { defineConfig } from 'vitest/config'

// Many CLI tests start a real process (a fake scanner binary, `disconnect`,
// gate scripts). Vitest's 5 s default timed those out on a loaded machine
// while they pass alone; 15 s matches the sync daemon's suite.
export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
})
