import { defineConfig } from 'vitepress'
import fs from 'fs'
import path from 'path'

// Auto-detect if we are in OSS build mode (default is OSS for docs.intutic.ai unless INTUTIC_ENTERPRISE_BUILD === 'true')
const hasControlPlane = fs.existsSync(path.resolve(__dirname, '../../../services/control-plane'));
const IS_OSS = process.env.INTUTIC_ENTERPRISE_BUILD !== 'true' || !hasControlPlane;

const navItems = [
  { text: 'Guide', link: '/guide/getting-started' },
  { text: 'Integrations', link: '/integrations/' },
  { text: 'External Architecture', link: IS_OSS ? '/external/wasm-rules' : '/external/litellm' },
  { text: 'Reference', link: '/reference/cli' },
  { text: 'Concepts', link: '/concepts/enforcement-actions' },
  { text: 'Security', link: '/security' },
  { text: 'Compare', link: '/compare/portkey' },
];

if (!IS_OSS) {
  navItems.push({ text: 'Console', link: 'https://app.intutic.ai/login' });
}

const sidebarGuide = [
  {
    text: 'Introduction',
    items: [
      { text: 'Getting Started', link: '/guide/getting-started' },
      { text: 'Core Concepts', link: '/guide/concepts' },
      { text: 'How It Works', link: '/guide/how-it-works' },
      { text: 'FAQs', link: '/guide/faqs' },
    ],
  },
];

if (!IS_OSS) {
  sidebarGuide.push({
    text: 'Using Intutic',
    items: [
      { text: 'Dashboard (Cloud)', link: '/guide/dashboard' },
      { text: 'Developer Sessions (Cloud)', link: '/guide/agent-top' },
      { text: 'Intelligence Engine (Cloud)', link: '/guide/intelligence' },
      { text: 'Activity Logs (Cloud)', link: '/guide/traces' },
      { text: 'Agent Guidelines (Cloud)', link: '/guide/sops' },
      { text: 'Review Queue (Cloud)', link: '/guide/decisions' },
      { text: 'Budgets & FinOps (Cloud)', link: '/guide/budgets' },
      { text: 'Policies & Enforcement (Cloud)', link: '/guide/policies' },
      { text: 'Session Safety & Budgets (Cloud)', link: '/guide/loops' },
      { text: 'Settings & Config (Cloud)', link: '/guide/settings' },
      { text: 'Intelligent Model Routing (Cloud)', link: '/guide/intelligent-routing' },
    ],
  });
}

sidebarGuide.push({
  text: 'Advanced Features',
  items: [
    { text: 'Custom Filters (Open-Core)', link: '/guide/wasm-rules' },
    ...(!IS_OSS ? [
      { text: 'SOP Optimizer (Cloud)', link: '/guide/metaclaw' },
      { text: 'Drift Detection (Cloud)', link: '/guide/drift-detection' },
      { text: 'Slash Commands (Cloud)', link: '/guide/slash-commands' },
      { text: 'Stream Alerts (Cloud)', link: '/guide/inline-streams' },
    ] : []),
  ],
});

if (!IS_OSS) {
  sidebarGuide.push({
    text: 'Security & Compliance',
    items: [
      { text: 'Security & Identity (Enterprise)', link: '/guide/security' },
      { text: 'Emergency Overrides (Enterprise)', link: '/guide/break-glass' },
    ],
  });
}

const sidebarExternal = [
  {
    text: 'External Architecture',
    items: [
      ...(!IS_OSS ? [{ text: 'LiteLLM Routing (Enterprise)', link: '/external/litellm' }] : []),
      { text: 'WASM Rules Engine (Open-Core)', link: '/external/wasm-rules' },
      ...(!IS_OSS ? [
        { text: 'Entity Hierarchy (Enterprise)', link: '/external/hierarchy' },
        { text: 'Diagnostics Runbook (Enterprise)', link: '/external/diagnostics' },
      ] : []),
    ],
  },
];

const sidebarReference = [
  {
    text: 'Reference',
    items: [
      { text: 'CLI (Open-Core)', link: '/reference/cli' },
      { text: 'CLI Doctor (Open-Core)', link: '/reference/cli-doctor' },
      ...(!IS_OSS ? [
        { text: 'REST API (Cloud)', link: '/reference/api' },
        { text: 'SOP Format (Cloud)', link: '/reference/sop-format' },
        { text: 'SOP Library (Cloud)', link: '/reference/sop-library' },
      ] : []),
      { text: 'clawde SDK (Open-Core)', link: '/reference/clawde-sdk' },
      { text: 'Configuration (Open-Core)', link: '/reference/configuration' },
      { text: 'Harness Matrix (Open-Core)', link: '/reference/harness-security-matrix' },
    ],
  },
];

export default defineConfig({
  title: 'Intutic Docs',
  description: 'The circuit breaker for AI agents',
  base: '/',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#3b82f6' }],
  ],

  appearance: 'dark',
  ignoreDeadLinks: true,

  themeConfig: {
    logo: {
      light: '/logo-black.svg',
      dark: '/logo-white.svg'
    },
    siteTitle: false,

    nav: navItems,

    sidebar: {
      '/guide/': sidebarGuide,
      '/concepts/': [
        {
          text: 'Concepts',
          items: [
            { text: 'Enforcement Actions', link: '/concepts/enforcement-actions' },
            { text: 'Harnesses', link: '/concepts/harnesses' },
            { text: 'Circuit Breaker', link: '/concepts/circuit-breaker' },
            ...(!IS_OSS ? [{ text: 'Gödel Guardrails Scoring', link: '/concepts/godel-scoring' }] : []),
            { text: 'Standard Operating Procedures', link: '/concepts/sops' },
            { text: 'Trace Telemetry Model', link: '/concepts/trace-model' },
          ],
        },
      ],
      '/integrations/': [
        {
          text: 'Integrations',
          items: [
            { text: 'Hub', link: '/integrations/' },
            { text: 'Technical Overview', link: '/integrations/overview' },
            { text: 'Standalone Cloud Proxy', link: '/integrations/standalone' },
            { text: 'MCP Governance Proxy', link: '/integrations/mcp-proxy' },
            { text: 'Kitkat Agent Custom Skill', link: '/integrations/kitkat' },
          ],
        },
        {
          text: 'IDE & Agent Harnesses',
          items: [
            { text: 'Claude Code', link: '/integrations/claude-code' },
            { text: 'Cursor', link: '/integrations/cursor' },
            { text: 'Windsurf', link: '/integrations/windsurf' },
            { text: 'Aider', link: '/integrations/aider' },
            { text: 'Antigravity', link: '/integrations/antigravity' },
            { text: 'Codex', link: '/integrations/codex' },
            { text: 'OpenHands', link: '/integrations/openhands' },
            { text: 'n8n', link: '/integrations/n8n' },
            { text: 'Cline', link: '/integrations/cline' },
            { text: 'Roo Code', link: '/integrations/roo-code' },
            { text: 'Continue', link: '/integrations/continue' },
            { text: 'Claude Desktop', link: '/integrations/claude-desktop' },
            { text: 'Goose', link: '/integrations/goose' },
            { text: 'Open WebUI', link: '/integrations/open-webui' },
            { text: 'OpenClaw', link: '/integrations/openclaw' },
            { text: 'Hermes', link: '/integrations/hermes' },
            { text: 'Pi', link: '/integrations/pi' },
            { text: 'GitHub Copilot', link: '/integrations/github-copilot' },
          ],
        },
      ],
      '/external/': sidebarExternal,
      '/reference/': sidebarReference,
      '/compare/': [
        {
          text: 'Compare',
          items: [
            { text: 'Intutic vs Portkey', link: '/compare/portkey' },
            { text: 'Intutic vs Credo AI', link: '/compare/credo-ai' },
            { text: 'Intutic vs Arize AX', link: '/compare/arize-ax' },
            { text: 'Intutic vs F5 Calypso', link: '/compare/f5-calypso' },
            { text: 'Intutic vs LangSmith', link: '/compare/langsmith' },
            { text: 'Intutic vs Fiddler AI', link: '/compare/fiddler' },
            { text: 'Intutic vs W&B Weave', link: '/compare/wandb-weave' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/intutic' },
      { icon: 'x', link: 'https://x.com/IntuticAI' },
      { icon: 'linkedin', link: 'https://www.linkedin.com/company/intutic-ai/' },
    ],

    search: {
      provider: 'local',
    },

    footer: {
      message: 'The circuit breaker for AI agents',
      copyright: '© 2026 Intutic Community. All rights reserved.',
    },
  },

  vite: {
    build: {
      chunkSizeWarningLimit: 1000,
    },
    plugins: [
      {
        name: 'oss-domain-replacer',
        enforce: 'pre',
        transform(code: string, id: string) {
          if (IS_OSS && (id.endsWith('.md') || id.includes('.md?'))) {
            let transformed = code
              .replace(/<!-- ENTERPRISE_ONLY_START -->[\s\S]*?<!-- ENTERPRISE_ONLY_END -->/gm, '')
              .replace(/https:\/\/api\.intutic\.ai/g, 'http://localhost:3001')
              .replace(/https:\/\/proxy\.intutic\.ai/g, 'http://localhost:4000')
              .replace(/https:\/\/app\.intutic\.ai/g, 'http://localhost:5174')
              .replace(/app\.intutic\.ai/g, 'localhost:5174');

            return {
              code: transformed,
              map: null
            };
          }
        }
      }
    ]
  }
})

