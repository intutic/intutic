import * as vscode from 'vscode'
import { registerStatusBar } from './statusBar.js'
import { registerCommands } from './commands/index.js'

export function activate(context: vscode.ExtensionContext) {
  console.log('Intutic Governance Extension is active.')

  // Initialize status bar status checker
  registerStatusBar(context)

  // Register extension commands
  registerCommands(context)
}

export function deactivate() {
  console.log('Intutic Governance Extension deactivated.')
}
