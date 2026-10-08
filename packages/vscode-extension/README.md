# Intutic Governance Extension (unreleased)

A VS Code / Cursor extension that adds an Intutic status-bar item and commands
for connecting a workspace and opening traces, SOPs, incidents and WASM rule
bundles. It is not published to the VS Code Marketplace, Open VSX or npm, and
`"private": true` keeps it that way. To try it, build it from source with
`pnpm install` and `pnpm exec tsc -p .` in this directory, then start an
Extension Development Host with
`code --extensionDevelopmentPath="$PWD"`.
