/**
 * Task Management Adapter — Generic interface for external task/issue trackers.
 *
 * TD-022 item 3.9: TaskManagementAdapter interface
 *
 * Provides a unified abstraction over external task management tools
 * (Jira, Linear, GitHub Issues, etc.) so the control plane can
 * create/update tasks based on governance events.
 *
 * @module
 */

// ─── Core Types ──────────────────────────────────────────────────────

/** Supported task management providers. */
export type TaskProvider = 'jira' | 'linear' | 'github' | 'asana' | 'pagerduty'

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
  /** Project or board identifier within the provider. */
  projectKey: string
  /** Additional provider-specific config. */
  metadata?: Record<string, unknown>
}

/** Payload for creating a new task. */
export interface CreateTaskPayload {
  /** Human-readable task title. */
  title: string
  /** Markdown description of the task. */
  description: string
  /** Normalized priority. */
  priority: TaskPriority
  /** Intutic-specific labels for categorization. */
  labels?: string[]
  /** Assignee identifier (provider-specific). */
  assigneeId?: string
  /** Link back to the Intutic governance event. */
  intuticLink?: {
    /** Type of governance event that created this task. */
    eventType: 'INCIDENT' | 'ANOMALY' | 'SOP_REVIEW' | 'COMPLIANCE'
    /** ID of the governance event. */
    eventId: string
    /** Workspace this event belongs to. */
    workspaceId: string
  }
}

/** Result of creating a task in the external system. */
export interface CreateTaskResult {
  /** Whether the task was successfully created. */
  success: boolean
  /** External task ID (e.g., Jira issue key like "PROJ-123"). */
  externalTaskId?: string
  /** URL to the task in the external system. */
  externalUrl?: string
  /** Error message if creation failed. */
  error?: string
}

/** Payload for updating an existing task. */
export interface UpdateTaskPayload {
  /** External task ID to update. */
  externalTaskId: string
  /** New status (optional). */
  status?: TaskStatus
  /** Comment to add (optional). */
  comment?: string
  /** Updated priority (optional). */
  priority?: TaskPriority
  /** Additional fields (provider-specific). */
  fields?: Record<string, unknown>
}

/** Result of updating a task. */
export interface UpdateTaskResult {
  success: boolean
  error?: string
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

// ─── Adapter Interface ───────────────────────────────────────────────

/**
 * Generic task management adapter interface.
 *
 * Implementations of this interface connect Intutic's governance engine
 * to external task management tools. The control plane calls these methods
 * when governance events (incidents, anomalies, SOP reviews) require
 * external task creation or updates.
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
   * Create a new task in the external system.
   * @param payload - Task creation payload
   * @returns Result with external task ID and URL
   */
  createTask(payload: CreateTaskPayload): Promise<CreateTaskResult>

  /**
   * Update an existing task in the external system.
   * @param payload - Task update payload
   * @returns Result indicating success/failure
   */
  updateTask(payload: UpdateTaskPayload): Promise<UpdateTaskResult>

  /**
   * Retrieve a task by its external ID.
   * @param externalTaskId - The external system's task identifier
   * @returns The task details, or null if not found
   */
  getTask(externalTaskId: string): Promise<ExternalTask | null>

  /**
   * Search for tasks matching Intutic criteria.
   * @param workspaceId - Intutic workspace ID to filter by
   * @param filters - Optional filters (status, priority, labels)
   * @returns List of matching external tasks
   */
  searchTasks(
    workspaceId: string,
    filters?: { status?: TaskStatus; priority?: TaskPriority; labels?: string[] },
  ): Promise<ExternalTask[]>
}
