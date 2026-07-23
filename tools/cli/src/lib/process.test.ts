import { describe, it, expect } from 'vitest'
import { parseProcessOutput } from './process.js'

describe('Process Parser', () => {
  it('correctly parses Unix/macOS ps output format', () => {
    const psOutput = `
      PID ARGS
     1234 /Applications/Cursor.app/Contents/MacOS/Cursor
     5678 aider --model openai/gpt-4o
    99999 node /usr/local/bin/claude
    `
    const results = parseProcessOutput(psOutput, 'darwin')

    expect(results).toHaveLength(3) // 3 parsed processes (header skipped since PID is NaN)
    
    // Actually let's look at results:
    const cursorProc = results.find(r => r.pid === 1234)
    expect(cursorProc).toBeDefined()
    expect(cursorProc?.command).toBe('/Applications/Cursor.app/Contents/MacOS/Cursor')

    const aiderProc = results.find(r => r.pid === 5678)
    expect(aiderProc).toBeDefined()
    expect(aiderProc?.command).toBe('aider --model openai/gpt-4o')

    const claudeProc = results.find(r => r.pid === 99999)
    expect(claudeProc).toBeDefined()
    expect(claudeProc?.command).toBe('node /usr/local/bin/claude')
  })

  it('correctly parses Windows tasklist CSV output format', () => {
    const tasklistOutput = `
"System Idle Process","0","Services","0","8 K"
"System","4","Services","0","3,816 K"
"Cursor.exe","12345","Console","1","150,000 K"
"goose.exe","54321","Console","1","50,000 K"
`
    const results = parseProcessOutput(tasklistOutput, 'win32')

    expect(results).toHaveLength(4)

    const systemProc = results.find(r => r.pid === 4)
    expect(systemProc).toBeDefined()
    expect(systemProc?.command).toBe('System')

    const cursorProc = results.find(r => r.pid === 12345)
    expect(cursorProc).toBeDefined()
    expect(cursorProc?.command).toBe('Cursor.exe')

    const gooseProc = results.find(r => r.pid === 54321)
    expect(gooseProc).toBeDefined()
    expect(gooseProc?.command).toBe('goose.exe')
  })
})
