# Import by connection id, as `intutic tasks list` shows it. The API never
# returns the token or the Jira account email, and has no update, so the first
# apply after an import replaces the connection with the configured values.
terraform import intutic_task_connection.jira cc_0123456789abcdef
