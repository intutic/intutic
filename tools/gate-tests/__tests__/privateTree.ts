/**
 * A fixture's stand-in for the full checkout's private tree. The gate scripts
 * read where that tree is, and which of its files they look at, from
 * tools/scripts/private-tree.json, a file only the full checkout has; a fixture
 * that wants the tree writes this one and puts its files under PRIVATE_DIR.
 */
export const PRIVATE_DIR = 'private-svc'
export const priv = (rel: string) => `${PRIVATE_DIR}/${rel}`

export const PRIVATE_TREE_FILE = 'tools/scripts/private-tree.json'
export const PRIVATE_TREE_CONFIG = JSON.stringify({
  dir: PRIVATE_DIR,
  src: 'src',
  files: {
    planSkuMap: 'src/lib/planSkuMap.ts',
    siemRegistry: 'src/services/siem/eventSourceRegistry.ts',
    notificationRouter: 'src/services/notificationRouterService.ts',
    flagWriter: 'src/routes/workspace.ts',
    flagWriterTest: '__tests__/integration/posturePresets.test.ts',
  },
  planNameSources: ['src/services/emailService.ts', 'src/lib/planCatalog.ts', 'src/routes/trial.ts'],
  eventConsumers: [
    'services/notificationRouterService.ts',
    'services/notificationHubService.ts',
    'services/governanceNotificationService.ts',
    'services/emailService.ts',
    'services/adapters/',
    'services/siem/',
    'routes/notifications.ts',
  ],
})
