/**
 * Task Management Adapter — read-only interface over external task trackers
 * and incident tools.
 *
 * The control plane reads tickets (Jira, Linear) and incidents (PagerDuty) to
 * attach task context to agent sessions. It does not create or update them.
 *
 * @module
 */

// ─── Core Types ──────────────────────────────────────────────────────

/** Providers with a registered adapter. */
export type TaskProvider = 'jira' | 'pagerduty' | 'linear'

/** Priority levels mapped across providers. */
export type TaskPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

/** Task status (normalized across providers). */
export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'

/** Credentials for connecting to a task management provider. */
export interface TaskProviderCredentials {
  provider: TaskProvider
  /** Base URL of the provider instance (e.g., https://company.atlassian.net). */
  baseUrl: string
  /** Authentication token or API key. */
  authToken: string
  /** Project, team or routing key within the provider. */
  projectKey: string
  /**
   * Jira Cloud only: the email of the Atlassian account the API token belongs
   * to. Jira Cloud authenticates an API token as Basic `email:token`. A
   * connection stores it as `metadata.accountEmail`.
   */
  accountEmail?: string
  /** Additional provider-specific config. */
  metadata?: Record<string, unknown>
}

/** A task as retrieved from the external system. */
export interface ExternalTask {
  externalTaskId: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  assignee?: string
  externalUrl: string
  createdAt: string
  updatedAt: string
  storyPoints?: number
  sprint?: string
  epic?: string
}

/** Filters for `TaskManagementAdapter.searchTasks`. */
export interface TaskSearchFilters {
  status?: TaskStatus
  priority?: TaskPriority
  labels?: string[]
  /**
   * The provider's own id for the assignee. An adapter must apply it: a search
   * for one person's work that comes back with everyone's is worse than none.
   */
  assigneeId?: string
}

// ─── Adapter Interface ───────────────────────────────────────────────

/**
 * Generic task management adapter interface.
 *
 * Implementations read from an external tracker so the control plane can
 * resolve which ticket or incident an agent session is working on.
 */
export interface TaskManagementAdapter {
  /** Provider name for this adapter. */
  readonly provider: TaskProvider

  /**
   * Test the connection to the external system.
   * @returns true if the connection is healthy
   */
  testConnection(): Promise<boolean>

  /**
   * Retrieve a task by its external ID.
   * @param externalTaskId - The external system's task identifier
   * @returns The task details, or null if not found
   */
  getTask(externalTaskId: string): Promise<ExternalTask | null>

  /**
   * Search for open tasks.
   *
   * Rejects when the provider cannot be asked (unreachable, refused, timed
   * out), so a caller can tell "nothing open" from "could not ask".
   *
   * @param workspaceId - Intutic workspace ID, for logging
   * @param filters - Optional filters (status, priority, labels, assignee)
   * @returns List of matching external tasks
   */
  searchTasks(workspaceId: string, filters?: TaskSearchFilters): Promise<ExternalTask[]>
}
