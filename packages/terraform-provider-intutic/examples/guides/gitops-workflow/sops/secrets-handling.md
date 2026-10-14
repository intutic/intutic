## Secrets handling

- Never commit secrets, API keys or tokens to version control.
- Read credentials from the environment or the secret store, never from a file in the repository.
- Rotate a credential as soon as it has been printed in a log.
