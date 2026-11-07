// Runs before every test file imports anything. Many modules turn os.homedir()
// into a path once, at import (for example DEFAULT_SNAPSHOT_DIR), so a test that
// moves HOME in beforeEach is already too late and would write the developer's
// real ~/.intutic. Point HOME at a throwaway folder first.
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// A worker runs several files, and this file once per file: keep the first, real home.
process.env.INTUTIC_TEST_REAL_HOME ??= homedir()
const home = mkdtempSync(join(tmpdir(), 'intutic-sync-daemon-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
