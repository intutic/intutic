import { defineConfig } from 'vitepress'
import fs from 'fs'
import path from 'path'

// OSS build mode (open-source pages only) unless INTUTIC_ENTERPRISE_BUILD === 'true'.
// docs.intutic.ai builds the full site (apps/docs/Dockerfile). The flag is the
// only signal: an earlier version also required services/control-plane to
// exist, which the Docker build context never contains, so the published image
// came out open-source-only while the flag said otherwise.
const IS_OSS = process.env.INTUTIC_ENTERPRISE_BUILD !== 'true';

/**
 * Fail-closed guard for the published site.
 *
 * docs.intutic.ai publishes every page: the Cloud and Enterprise pages carry
 * their badge, and the dashboard's help links point at them, so an
 * open-source-only build there breaks those links (it answered 14 of the
 * dashboard's 22 with a 404). The build for that site sets
 * INTUTIC_REQUIRE_FULL=true (apps/docs/Dockerfile, whose flags the deploy
 * script re-checks), and this throws rather than emit a site without them;
 * the Dockerfile then checks the output for a paid-tier page as well.
 */
if (process.env.INTUTIC_REQUIRE_FULL === 'true' && IS_OSS) {
  throw new Error(
    'Refusing to build: INTUTIC_REQUIRE_FULL=true but this build leaves out the paid-tier pages ' +
      `(INTUTIC_ENTERPRISE_BUILD=${JSON.stringify(process.env.INTUTIC_ENTERPRISE_BUILD)}). ` +
      "The dashboard's help links point at them.",
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
        // The badge lives on the H1, so only the head of the file matters. Any
        // plan badge (guide/plans.md#badges) marks a page that needs a control
        // plane; Plans & pricing itself carries prices, which the open-source
        // site does not publish.
        const head = fs.readFileSync(full, 'utf8').slice(0, 512)
        if (/<Badge[^>]*text="(Cloud|Self-serve\+|Biz Org\+|Enterprise|Self-host)"/.test(head) || entry.name === 'plans.md') {
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
  { text: 'Compare', link: '/compare/' },
];

if (!IS_OSS) {
  navItems.push({ text: 'Console', link: 'https://app.intutic.ai/login' });
}

const sidebarGuide = [
  {
    text: 'Introduction',
    items: [
      { text: 'Getting Started', link: '/guide/getting-started' },
      { text: 'Tier Matrix', link: '/guide/tier-matrix' },
      ...(!IS_OSS ? [{ text: 'Plans & Pricing', link: '/guide/plans' }] : []),
      { text: 'Core Concepts', link: '/guide/concepts' },
      { text: 'How It Works', link: '/guide/how-it-works' },
      { text: 'FAQs', link: '/guide/faqs' },
    ],
  },
];

if (!IS_OSS) {
  sidebarGuide.push({
    text: 'Self-host',
    items: [
      { text: 'Overview (Self-host)', link: '/guide/self-host' },
      { text: 'Docker Compose (Self-host)', link: '/guide/self-host-compose' },
      { text: 'Kubernetes (Self-host)', link: '/guide/self-host-kubernetes' },
      { text: 'Your License (Self-host)', link: '/guide/self-host-license' },
    ],
  });
  sidebarGuide.push({
    text: 'Using Intutic',
    items: [
      { text: 'Overview (Cloud)', link: '/guide/dashboard' },
      { text: 'Developer Sessions (Cloud)', link: '/guide/agent-top' },
      { text: 'Intelligence Engine (Cloud)', link: '/guide/intelligence' },
      { text: 'Activity Logs (Cloud)', link: '/guide/traces' },
      { text: 'Agents (Cloud)', link: '/guide/agents' },
      { text: 'Agent Guidelines (Cloud)', link: '/guide/sops' },
      { text: 'GitOps for SOPs (Cloud)', link: '/guide/gitops-sops' },
      { text: 'Review Queue (Cloud)', link: '/guide/decisions' },
      { text: 'Governed Decisions Log (Cloud)', link: '/guide/decisions-log' },
      { text: 'Budgets & FinOps (Cloud)', link: '/guide/budgets' },
      { text: 'Policies & Enforcement (Cloud)', link: '/guide/policies' },
      { text: 'Session Safety & Budgets (Cloud)', link: '/guide/loops' },
      { text: 'Trajectory Monitor (Cloud)', link: '/guide/trajectory-monitor' },
      { text: 'Settings & Config (Cloud)', link: '/guide/settings' },
      { text: 'Audit Timeline (Cloud)', link: '/guide/audit-timeline' },
      { text: 'Organizations, Teams & Billing (Cloud)', link: '/guide/organizations' },
      { text: 'Intelligent Model Routing (Cloud)', link: '/guide/intelligent-routing' },
      { text: 'Pre-Adoption Report for Model Upgrades (Cloud)', link: '/guide/mirror-adoption-report' },
      { text: 'Runaway-Spend Counterfactual (Cloud)', link: '/guide/averted-spend' },
      { text: 'Signed Provider-Downtime Evidence (Cloud)', link: '/guide/provider-incidents' },
      { text: 'Managed Gateway Cells (Self-serve+)', link: '/guide/managed-cells' },
      // Audit Timeline (Settings › Audit Timeline) is listed above and
      // Evaluator Sandbox (Labs › Evaluator Sandbox) under Advanced Features.
      // Org-wide SOPs have no page of their own: the Org-Wide SOP Floor card
      // is documented in the Team Members section of the Settings page.
    ],
  });
}

sidebarGuide.push({
  text: 'Advanced Features',
  items: [
    { text: 'Custom Filters (Open-Core)', link: '/guide/wasm-rules' },
    { text: 'Graph Guardrails (Open-Core)', link: '/guide/graph-guardrails' },
    { text: 'Sandboxed Execution (Open-Core)', link: '/guide/sandboxed-execution' },
    { text: 'Governance Controls Checklist (Open-Core)', link: '/guide/governance-controls' },
    { text: 'Skill Scanning (Open-Core)', link: '/guide/skill-scanning' },
    { text: 'MCP Server Governance (Open-Core)', link: '/guide/mcp-governance' },
    { text: 'Prompt Commands: /fix & /draw (Open-Core)', link: '/guide/agent-commands' },
    { text: 'OpenTelemetry (Open-Core)', link: '/guide/opentelemetry' },
    { text: 'Cohort Wizard (Open-Core)', link: '/guide/cohort-wizard' },
    // Routing ships in open-core. Enterprise builds already list this page under
    // 'Using Intutic' as 'Intelligent Model Routing (Cloud)', so this entry is
    // OSS-only to keep the page from appearing twice in the enterprise sidebar.
    ...(IS_OSS ? [
      { text: 'Intelligent Model Routing (Open-Core)', link: '/guide/intelligent-routing' },
      // Mirror sampling (mirror_candidate_model / mirror_sample_rate) is a
      // proxy-only, open-core config knob — see the page's own "Honest
      // Limits" section for what an OSS install can and can't do with it
      // absent a control plane (no judge, no report). Same dual-listing
      // reasoning as the entry directly above.
      { text: 'Pre-Adoption Report for Model Upgrades (Open-Core)', link: '/guide/mirror-adoption-report' },
    ] : []),
    ...(!IS_OSS ? [
      { text: 'SOP Optimizer (Biz Org+)', link: '/guide/metaclaw' },
      { text: 'Evaluator Sandbox (Biz Org+)', link: '/guide/evaluator-sandbox' },
      { text: 'Off-Pattern Detection (Cloud)', link: '/guide/drift-detection' },
      { text: 'Slash Commands (Cloud)', link: '/guide/slash-commands' },
      { text: 'Stream Alerts (Cloud)', link: '/guide/inline-streams' },
      { text: 'Policy Guardrails (Self-serve+)', link: '/guide/policy-guardrails' },
    ] : []),
  ],
});

if (!IS_OSS) {
  sidebarGuide.push({
    text: 'Security & Compliance',
    items: [
      { text: 'Security & Identity (Cloud)', link: '/guide/security' },
      { text: 'SCIM Provisioning (Enterprise)', link: '/guide/scim' },
      { text: 'Emergency Overrides (Cloud)', link: '/guide/break-glass' },
      { text: 'SIEM Export (Cloud)', link: '/guide/siem-export' },
      { text: 'Compliance Evidence (Cloud)', link: '/guide/compliance-evidence' },
      { text: 'VirusTotal Integration (Cloud)', link: '/guide/virustotal-scanning' },
    ],
  });
}

const sidebarExternal = [
  {
    text: 'External Architecture',
    items: [
      ...(!IS_OSS ? [{ text: 'LiteLLM Routing (Cloud)', link: '/external/litellm' }] : []),
      { text: 'WASM Rules Engine (Open-Core)', link: '/external/wasm-rules' },
      ...(!IS_OSS ? [
        { text: 'Entity Hierarchy (Cloud)', link: '/external/hierarchy' },
        { text: 'Self-Hosted Gateway (Enterprise)', link: '/external/self-hosted-gateway' },
        { text: 'On-Prem Judge Setup (Enterprise)', link: '/external/on-prem-judge' },
        { text: 'Diagnostics Runbook (Cloud)', link: '/external/diagnostics' },
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
      // Unconditional, and deliberately distinct from the Cloud "SOP Format"
      // page below: the front-matter rules are enforced by the open-core proxy,
      // and until this page existed they were documented nowhere a public
      // reader could reach — the only page that covered SOPs at all is
      // Cloud-badged and therefore excluded from this build entirely.
      { text: 'SOP Front Matter (Open-Core)', link: '/reference/sop-front-matter' },
      ...(!IS_OSS ? [
        { text: 'REST API (Cloud)', link: '/reference/api' },
        { text: 'SOP Format (Cloud)', link: '/reference/sop-format' },
      ] : []),
      { text: 'clawde SDK (Open-Core)', link: '/reference/clawde-sdk' },
      { text: 'Model Catalog (Open-Core)', link: '/reference/model-catalog' },
      { text: 'Configuration (Open-Core)', link: '/reference/configuration' },
      { text: 'Harness Matrix (Open-Core)', link: '/reference/harness-security-matrix' },
    ],
  },
];

// Where the site is served from. docs.intutic.ai serves it at the root; a
// Self-host deployment serves its bundled copy under /docs/ on the deployment's
// own address (infra/compose/nginx.enterprise.conf), so its docs image is built
// with DOCS_BASE=/docs/.
const base = process.env.DOCS_BASE ?? '/'
if (!/^\/([a-z0-9-]+\/)*$/.test(base)) {
  throw new Error(`DOCS_BASE must start and end with "/" (got "${base}")`)
}

export default defineConfig({
  title: 'Intutic Docs',
  description: 'Policy as Code for Continuous Compliance and Continuous Enforcement for AI agents',
  base,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#3b82f6' }],
    // No third-party font requests: Geist and Geist Mono are self-hosted from
    // @intutic/theme (see .vitepress/theme/custom.css).
  ],

  appearance: 'dark',
  // Dead links are not the build's job: an open-source build leaves the
  // paid-tier pages out, so links to them are dead there by design, and
  // VitePress never checks #anchors. tools/scripts/check-docs-links.js checks
  // every link between pages, and its anchor, in CI.
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
        // OBO as an Enterprise feature fifty lines further down and wrapped them.
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
            { text: 'Policy as Code', link: '/concepts/policy-as-code' },
            { text: 'Enforcement Actions', link: '/concepts/enforcement-actions' },
            { text: 'Harnesses', link: '/concepts/harnesses' },
            { text: 'Circuit Breaker', link: '/concepts/circuit-breaker' },
            { text: 'Evidence and Authority Provenance', link: '/concepts/evidence-and-authority-provenance' },
            ...(!IS_OSS ? [{ text: 'Gödel Guardrails Scoring', link: '/concepts/godel-scoring' }] : []),
            { text: 'Standard Operating Procedures', link: '/concepts/sops' },
            { text: 'Trace Telemetry Model', link: '/concepts/trace-model' },
            ...(!IS_OSS ? [{ text: 'Trace Integrity', link: '/concepts/trace-integrity' }] : []),
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
            { text: 'LangGraph', link: '/integrations/langgraph' },
            { text: 'Grok Build', link: '/integrations/grok' },
            { text: 'OpenCode', link: '/integrations/opencode' },
            { text: 'Muse Code', link: '/integrations/muse-code' },
            { text: 'dsh', link: '/integrations/dsh' },
            { text: 'Xirp', link: '/integrations/xirp' },
            { text: 'Agentic Orchestrator', link: '/integrations/agentic-orchestrator' },
            { text: 'LangChain', link: '/integrations/langchain' },
            { text: 'CrewAI', link: '/integrations/crewai' },
            { text: 'AutoGen', link: '/integrations/autogen' },
            { text: 'AG2', link: '/integrations/ag2' },
            { text: 'Pydantic AI', link: '/integrations/pydantic-ai' },
            { text: 'smolagents', link: '/integrations/smolagents' },
            { text: 'Google ADK', link: '/integrations/google-adk' },
            { text: 'OpenAI Agents SDK', link: '/integrations/openai-agents' },
            { text: 'Strands Agents', link: '/integrations/strands' },
            { text: 'Microsoft Agent Framework', link: '/integrations/microsoft-agent-framework' },
            { text: 'Mastra', link: '/integrations/mastra' },
            { text: 'Vercel AI SDK', link: '/integrations/vercel-ai-sdk' },
            { text: 'eve', link: '/integrations/eve' },
            { text: 'TrueForge', link: '/integrations/trueforge' },
            { text: 'AI SDK Harness', link: '/integrations/ai-sdk-harness' },
            { text: 'AI SDK Workflow', link: '/integrations/ai-sdk-workflow' },
            { text: 'AWS Bedrock AgentCore', link: '/integrations/agentcore' },
          ],
        },
        {
          text: 'Server-Side Platforms',
          items: [
            { text: 'QM', link: '/integrations/qm' },
            { text: 'Anthropic Managed Agents', link: '/integrations/anthropic-managed-agents' },
          ],
        },
      ],
      '/external/': sidebarExternal,
      '/reference/': sidebarReference,
      '/compare/': [
        {
          text: 'Compare',
          items: [
            { text: 'Overview & Capability Matrix', link: '/compare/' },
            { text: 'Intutic vs Portkey', link: '/compare/portkey' },
            { text: 'Intutic vs Credo AI', link: '/compare/credo-ai' },
            { text: 'Intutic vs Arize AX', link: '/compare/arize-ax' },
            { text: 'Intutic vs Forge', link: '/compare/forge' },
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

