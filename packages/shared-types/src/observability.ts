export interface TraceDagNode {
  sessionId: string
  harnessType: string
  parentSessionId: string | null
  totalCostUsd: number
  stepCount: number
  errorCount: number
  /** 'LEGACY_BUCKET' | 'PROXY_PROCESS' | other — derived, see agent_sessions_resolved */
  sessionKind?: string
}

export interface TraceDagResult {
  traceId: string
  rootSessionId: string
  /** The session the requested trace belongs to — what the DAG highlights. */
  currentSessionId: string
  nodes: TraceDagNode[]
}


