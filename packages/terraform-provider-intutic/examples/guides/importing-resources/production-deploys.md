## Production deploys

- Deploy to production only from the main branch, after CI passes.
- Never run database migrations by hand against production.
- Roll back with the previous release tag, not with a hotfix commit.
