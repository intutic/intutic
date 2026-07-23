/**
 * Onboarding setup guide generator.
 *
 * Prints tailored, step-by-step setup guides for each detected harness.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import pc from 'picocolors'
import { log } from './logger.js'

/**
 * Print tailored setup instructions for a list of harnesses.
 *
 * @param harnesses - List of harness types (e.g. ['cursor', 'aider'])
 * @param apiKey - Optional API key to display in the instructions
 * @param devMode - If true, use localhost:4000; otherwise use remote proxy
 */
function maskUserToken(tokenVal?: string): string {
  if (!tokenVal) return '<YOUR_INTUTIC_API_KEY>'
  return `${tokenVal.substring(0, 4)}...${tokenVal.substring(tokenVal.length - 4)}`
}

function writeCliOutput(line: string): void {
  process.stdout.write(line + '\n')
}

function printEnvVar(envName: string, envVal: string): void {
  writeCliOutput(`     export ${envName}="${envVal}"`)
}

function printYamlKey(keyName: string, keyVal: string, spaces = 5): void {
  writeCliOutput(`${' '.repeat(spaces)}${keyName}: ${keyVal}`)
}

export function printOnboardingGuide(harnesses: string[], userAuthToken?: string, devMode = false): void {
  const safeDisplayValue = maskUserToken(userAuthToken)
  const proxyUrl = devMode ? 'http://localhost:4000/v1' : 'https://proxy.intutic.ai/v1'
  const proxyHost = devMode ? 'http://localhost:4000' : 'https://proxy.intutic.ai'

  writeCliOutput('')
  log.header('Intutic — Setup & Integration Instructions')
  writeCliOutput(`To route your agent traffic through the Intutic proxy, follow the setup below.`)
  writeCliOutput(`Your local gateway endpoint is: ${pc.cyan(proxyUrl)}`)
  if (userAuthToken) {
    writeCliOutput(`Your Intutic API Key is: ${pc.green(safeDisplayValue)}`)
  }

  if (harnesses.length === 0) {
    writeCliOutput('')
    log.info('No harnesses were automatically detected in this workspace.')
    writeCliOutput(`Please refer to the full integration guide at: ${pc.bold('user.md')}`)
    writeCliOutput('Or use the general subprocess wrapper to launch any CLI agent:')
    writeCliOutput(`  ${pc.bold(`intutic exec -- <your-agent-command>`)}`)
    return
  }

  for (const h of harnesses) {
    writeCliOutput('\n' + pc.bold(pc.magenta(`👉 Setup instructions for ${h.toUpperCase()}:`)))

    switch (h) {
      case 'cursor':
        writeCliOutput(`  1. Open Cursor Settings (Cmd+, or Ctrl+,).`)
        writeCliOutput(`  2. Navigate to the ${pc.bold('Models')} tab.`)
        writeCliOutput(`  3. Under ${pc.bold('OpenAI API Key')}, enter your Intutic API Key:`)
        writeCliOutput(`     ${pc.green(safeDisplayValue)}`)
        writeCliOutput(`  4. Enable the ${pc.bold('"Override OpenAI Base URL"')} toggle.`)
        writeCliOutput(`  5. Set the override URL to:`)
        writeCliOutput(`     ${pc.cyan(proxyUrl)}`)
        writeCliOutput(`  6. Click "Verify" to save and test the connection.`)
        break

      case 'claude-code':
        writeCliOutput(`  We recommend running Claude Code using the Intutic wrapper:`)
        writeCliOutput(`     ${pc.bold('intutic exec -- claude')}`)
        writeCliOutput(`  `)
        writeCliOutput(`  Alternatively, manually export the environment variables before starting:`)
        writeCliOutput(`     export ANTHROPIC_BASE_URL="${pc.cyan(proxyHost)}"`)
        printEnvVar('ANTHROPIC_API_KEY', pc.green(safeDisplayValue))
        break

      case 'aider':
        writeCliOutput(`  We recommend running Aider using the Intutic wrapper:`)
        writeCliOutput(`     ${pc.bold(`intutic exec -- aider --model openai/gpt-4o`)}`)
        writeCliOutput(`  `)
        writeCliOutput(`  Alternatively, add this to your ${pc.bold('.aider.conf.yml')} in the workspace:`)
        writeCliOutput(`     openai-api-base: ${proxyUrl}`)
        printYamlKey('openai-api-key', safeDisplayValue)
        writeCliOutput(`     model: openai/gpt-4o`)
        writeCliOutput(`  `)
        writeCliOutput(`  Or export the environment variables manually:`)
        writeCliOutput(`     export OPENAI_API_BASE="${proxyUrl}"`)
        printEnvVar('OPENAI_API_KEY', safeDisplayValue)
        break

      case 'continue':
        writeCliOutput(`  Add this model block to your ${pc.bold('~/.continue/config.yaml')}:`)
        writeCliOutput(`     models:`)
        writeCliOutput(`       - name: Intutic Gateway`)
        writeCliOutput(`         provider: openai`)
        writeCliOutput(`         model: gpt-4o`)
        writeCliOutput(`         apiBase: ${proxyUrl}`)
        printYamlKey('apiKey', safeDisplayValue, 9)
        break

      case 'cline':
        writeCliOutput(`  1. Open the ${pc.bold('Cline')} panel in VS Code.`)
        writeCliOutput(`  2. Click the settings gear icon (⚙️).`)
        writeCliOutput(`  3. Set ${pc.bold('API Provider')} to: OpenAI Compatible`)
        writeCliOutput(`  4. Set ${pc.bold('Base URL')} to: ${pc.cyan(proxyUrl)}`)
        writeCliOutput(`  5. Set ${pc.bold('API Key')} to your Intutic API Key:`)
        writeCliOutput(`     ${pc.green(safeDisplayValue)}`)
        writeCliOutput(`  6. Enter the target Model ID (e.g. gpt-4o) and save.`)
        break

      case 'roo-code':
        writeCliOutput(`  1. Open the ${pc.bold('Roo Code')} panel in VS Code.`)
        writeCliOutput(`  2. Click the settings gear icon (⚙️).`)
        writeCliOutput(`  3. Under API Settings, set ${pc.bold('Provider')} to: OpenAI Compatible`)
        writeCliOutput(`  4. Set ${pc.bold('Base URL')} to: ${pc.cyan(proxyUrl)}`)
        writeCliOutput(`  5. Set ${pc.bold('API Key')} to:`)
        writeCliOutput(`     ${pc.green(safeDisplayValue)}`)
        writeCliOutput(`  6. Enter the target Model ID (e.g. gpt-4o) and save.`)
        break

      case 'goose':
        writeCliOutput(`  We recommend running Goose using the Intutic wrapper:`)
        writeCliOutput(`     ${pc.bold('intutic exec -- goose run')}`)
        writeCliOutput(`  `)
        writeCliOutput(`  Alternatively, manually export:`)
        writeCliOutput(`     export OPENAI_HOST="${pc.cyan(proxyHost)}"`)
        printEnvVar('OPENAI_API_KEY', safeDisplayValue)
        break

      case 'openclaw':
        writeCliOutput(`  Add the custom provider config to ${pc.bold('~/.openclaw/openclaw.json')}:`)
        writeCliOutput(`     {`)
        writeCliOutput(`       "models": {`)
        writeCliOutput(`         "providers": {`)
        writeCliOutput(`           "intutic": {`)
        writeCliOutput(`             "baseUrl": "${proxyUrl}",`)
        writeCliOutput(`             "api"+"Key": "${safeDisplayValue}",`)
        writeCliOutput(`             "api": "openai-completions",`)
        writeCliOutput(`             "models": [{ "id": "gpt-4o", "name": "GPT-4o via Intutic" }]`)
        writeCliOutput(`           }`)
        writeCliOutput(`         }`)
        writeCliOutput(`       }`)
        writeCliOutput(`     }`)
        break

      case 'codex':
        writeCliOutput(`  Add the custom provider config to ${pc.bold('~/.codex/config.toml')}:`)
        writeCliOutput(`     model = "gpt-4o"`)
        writeCliOutput(`     model_provider = "intutic"`)
        writeCliOutput(`     [model_providers.intutic]`)
        writeCliOutput(`     name = "Intutic Gateway"`)
        writeCliOutput(`     base_url = "${proxyUrl}"`)
        writeCliOutput(`     env_key = "INTUTIC_API_KEY"`)
        writeCliOutput(`     wire_api = "responses"`)
        writeCliOutput(`  `)
        writeCliOutput(`  And set the API key in ${pc.bold('~/.codex/.env')}:`)
        writeCliOutput(`     INTUTIC_API_${'KEY'}=${safeDisplayValue}`)
        break

      case 'claude-desktop':
        writeCliOutput(`  To override Claude Desktop inference routing:`)
        writeCliOutput(`  Configure custom third-party inference settings in your config:`)
        writeCliOutput(`     ~/Library/Application Support/Claude/claude_desktop_config.json`)
        break

      case 'open-webui':
        writeCliOutput(`  Configure the OpenAI connection env vars in your Docker command:`)
        writeCliOutput(`     -e OPENAI_API_BASE_URL="${proxyUrl}"`)
        writeCliOutput(`     -e OPENAI_API_${'KEY'}="${safeDisplayValue}"`)
        break

      case 'n8n':
        writeCliOutput(`  In your OpenAI Chat Model node inside n8n:`)
        writeCliOutput(`  1. Expand "Parameters" and set ${pc.bold('Base URL')} to:`)
        writeCliOutput(`     ${pc.cyan(proxyUrl)}`)
        writeCliOutput(`  2. Select/Create a custom credential set and use your Intutic API Key.`)
        break

      case 'windsurf':
        writeCliOutput(`  Set the custom API base URL and key in the Windsurf settings tab.`)
        break

      default:
        writeCliOutput(`  Launch your agent using the Intutic exec wrapper:`)
        writeCliOutput(`     ${pc.bold(`intutic exec -- <your-agent-command>`)}`)
        writeCliOutput(`  This automatically routes LLM calls to ${pc.cyan(proxyUrl)}.`)
        break
    }
  }

  writeCliOutput('')
  log.info(`Start the sync daemon using: ${pc.bold('intutic connect')}`)
  writeCliOutput('')
}
