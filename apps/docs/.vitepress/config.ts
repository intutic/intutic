import { defineConfig } from 'vitepress'
import fs from 'fs'
import path from 'path'

// Auto-detect if we are in OSS build mode (default is OSS for docs.intutic.ai unless INTUTIC_ENTERPRISE_BUILD === 'true')
const hasControlPlane = fs.existsSync(path.resolve(__dirname, '../../../services/control-plane'));
const IS_OSS = process.env.INTUTIC_ENTERPRISE_BUILD !== 'true' || !hasControlPlane;

/**
 * Fail-closed guard for anything that ships.
 *
 * In the enterprise repo `hasControlPlane` is true, so IS_OSS collapses to
 * `INTUTIC_ENTERPRISE_BUILD !== 'true'` — a single stray `export` in a shell is
 * all that separates a normal build from one that publishes every paid-tier
 * page. Defaulting to OSS makes that unlikely; it does not make it impossible,
 * and the failure is silent: the build succeeds and the leak only shows up in
 * the rendered output.
 *
 * Any build destined for docs.intutic.ai therefore sets INTUTIC_REQUIRE_OSS=true
 * (see the enterprise repo's apps/docs/Dockerfile, whose flags the deploy script
 * re-checks before building) and this throws rather than emitting the wrong
 * site. Loud and early beats silent and public.
 */
if (process.env.INTUTIC_REQUIRE_OSS === 'true' && !IS_OSS) {
  throw new Error(
    'Refusing to build: INTUTIC_REQUIRE_OSS=true but OSS gating is OFF ' +
      `(INTUTIC_ENTERPRISE_BUILD=${JSON.stringify(process.env.INTUTIC_ENTERPRISE_BUILD)}, ` +
      `hasControlPlane=${hasControlPlane}). This build would publish paid-tier pages.`,
  )
}
console.log(`[docs] build mode: ${IS_OSS ? 'OSS (paid-tier pages excluded)' : 'ENTERPRISE (all pages)'}`)

/**
 * Pages whose title carries a `Cloud …` or `Enterprise` badge — i.e. pages that
 * document paid-tier functionality.
 *
 * These are excluded from the OSS build entirely (see `srcExclude` below).
 * Sidebar entries for them were already `!IS_OSS`-gated, but the pages
 * themselves were still rendered and served: 22 of them, of which only 7 had
 * any ENTERPRISE_ONLY wrapping, so the rest published their full cloud content
 * at a public URL that navigation simply never linked to.
 *
 * The list is derived from the badge at build time rather than hard-coded, so a
 * newly added Cloud/Enterprise page is excluded automatically instead of
 * silently shipping until someone remembers to update a list.
 */
function paidTierPages(): string[] {
  const root = path.resolve(__dirname, '..')
  const found: string[] = []
  const skip = new Set(['node_modules', 'public', 'dist'])
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.md')) {
        // The badge lives on the H1, so only the head of the file matters.
        const head = fs.readFileSync(full, 'utf8').slice(0, 512)
        if (/<Badge[^>]*text="(Cloud[^"]*|Enterprise[^"]*)"/.test(head)) {
          found.push(path.relative(root, full))
        }
      }
    }
  }
  walk(root)
  return found
}

const PAID_TIER_PAGES = IS_OSS ? paidTierPages() : []

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
      { text: 'Agents (Cloud)', link: '/guide/agents' },
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
    { text: 'Graph Guardrails (Open-Core)', link: '/guide/graph-guardrails' },
    { text: 'Prompt Commands: /fix & /draw (Open-Core)', link: '/guide/agent-commands' },
    // Routing ships in open-core. Enterprise builds already list this page under
    // 'Using Intutic' as 'Intelligent Model Routing (Cloud)', so this entry is
    // OSS-only to keep the page from appearing twice in the enterprise sidebar.
    ...(IS_OSS ? [
      { text: 'Intelligent Model Routing (Open-Core)', link: '/guide/intelligent-routing' },
    ] : []),
    ...(!IS_OSS ? [
      { text: 'SOP Optimizer (Cloud)', link: '/guide/metaclaw' },
      { text: 'Off-Pattern Detection (Cloud)', link: '/guide/drift-detection' },
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
    // Same families and axes the website loads, so both surfaces render
    // identically (Inter for text, JetBrains Mono for code and pills).
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500;600&display=swap' }],
  ],

  appearance: 'dark',
  ignoreDeadLinks: true,

  // Paid-tier pages are not built at all in OSS mode. Cloud pages cross-link to
  // each other, so excluding the set removes both the pages and their linkers;
  // `ignoreDeadLinks` above absorbs any stragglers.
  srcExclude: PAID_TIER_PAGES,

  // Strip ENTERPRISE_ONLY blocks in the markdown pipeline, not only in the Vite
  // transform below.
  //
  // The Vite `oss-domain-replacer` plugin cleans the rendered PAGES, but
  // VitePress builds its local search index from a separate markdown render
  // that never passes through that plugin. Without this rule the OSS build
  // shipped ~57 enterprise-only section titles — "Setting Up SSO",
  // "On-Behalf-Of (OBO) Tokens", "Cloud Reward Feedback (LLM-as-a-Judge)" —
  // as searchable results that jumped to anchors which do not exist on the
  // stripped page. Running here catches both paths; the Vite pass then finds
  // nothing left to strip and only performs its domain rewrites.
  markdown: {
    // VitePress does not render TeX unless this is on, so `$$…$$` blocks and
    // inline `$…$` spans were being emitted as literal source. The routing
    // guide's Beta-arm update rule and its inline `$\alpha, \beta$` references
    // were showing raw markup to readers. Requires markdown-it-mathjax3.
    math: true,
    config: (md) => {
      if (!IS_OSS) return
      md.core.ruler.before('normalize', 'strip-enterprise-only', (state) => {
        state.src = state.src.replace(
          /<!-- ENTERPRISE_ONLY_START -->[\s\S]*?<!-- ENTERPRISE_ONLY_END -->/gm,
          ''
        )

        // Fail the build on hosted-infrastructure terms that survive stripping.
        //
        // ENTERPRISE_ONLY is opt-in, so it only protects what somebody
        // remembered to wrap. Everything else ships. security.md was the proof:
        // its two badged sections were wrapped, while "Infrastructure Security"
        // — GKE, GCP Secret Manager, VPC layout — sat unwrapped and published
        // our own hosted topology to open-core readers, because it carried no
        // Enterprise badge for the page-level exclusion to key on.
        //
        // These terms describe infrastructure an open-core user does not have
        // and cannot reach. If one is genuinely needed, wrap it rather than
        // widening this list.
        // Hostnames and product names, plus the control-plane internals that
        // have no open-core counterpart. The second group matters more: the
        // first sweep only banned names, so security.md still published the
        // control plane's TLS paths, its PostgreSQL storage, its dashboard and
        // an RBAC/OBO threat-model row -- while the same page marked RBAC and
        // OBO as Enterprise Tier fifty lines further down and wrapped them.
        //
        // Saying open core has no control plane is fine and necessary.
        // Documenting how that control plane is built is not.
        const BANNED = [
          'Intutic Cloud',
          'GCP Secret Manager',
          'app.intutic.ai',
          'proxy.intutic.ai',
          'api.intutic.ai',
          'PostgreSQL',
          'OBO token',
          'RBAC',
          'Control Plane |',
          // Precise rather than a bare 'GKE': integrations/mcp-proxy.md
          // legitimately names "GKE MCP" as an example MCP server, which has
          // nothing to do with our hosting.
          'GKE control plane',
          'GKE Control Plane',
        ]
        const src = state.src
        const found = BANNED.filter((t) => src.includes(t))
        if (found.length > 0) {
          const where = state.env?.relativePath ?? 'unknown page'
          throw new Error(
            `[docs] OSS build refuses to publish hosted-infrastructure references.\n` +
              `  page:  ${where}\n` +
              `  terms: ${found.join(', ')}\n` +
              `  Wrap them in <!-- ENTERPRISE_ONLY_START --> … <!-- ENTERPRISE_ONLY_END -->, ` +
              `or reword to describe a control plane generically.`
          )
        }
      })
    },
  },

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
            { text: 'Rule Author Agent Skill', link: '/integrations/rule-author' },
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

