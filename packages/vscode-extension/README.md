# Intutic Governance Extension (unreleased)

A VS Code / Cursor extension that adds an Intutic status-bar item and commands
for connecting a workspace and opening traces, SOPs, incidents and WASM rule
bundles.

| Command | What it does |
| :--- | :--- |
| Intutic: Connect to workspace | Runs `intutic connect` in a terminal |
| Intutic: Show daemon status | Shows `intutic daemon status` |
| Intutic: Open trace viewer | Shows `intutic traces list` |
| Intutic: Browse active SOPs | Reads the control plane's SOPs |
| Intutic: View governance incidents | Reads the control plane's incidents |
| Intutic: View WASM rule bundles | Reads the control plane's WASM rules |

The status-bar item shows whether the local proxy (`intutic start`) is up, and
today's spend against its daily cap. The SOP, incident and WASM panels need a
control plane: the `intutic.controlPlaneUrl` setting, then
`INTUTIC_CONTROL_PLANE_URL`, then the address `intutic login` saved. Its key is
read from the OS keychain when `intutic login` stored it there. It is not published to the VS Code Marketplace, Open VSX or npm, and
`"private": true` keeps it that way. To try it, build it from source with
`pnpm install` and `pnpm exec tsc -p .` in this directory, then start an
Extension Development Host with
`code --extensionDevelopmentPath="$PWD"`.

The panels render control-plane data and `intutic traces list` output as
escaped text under a strict Content-Security-Policy and run no scripts. The
renderers live in `src/webview.ts`, which has no `vscode` import; `pnpm test`
compiles the extension and runs their tests with Node's built-in test runner.
