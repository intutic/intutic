---
scope_paths: k8s, tests
scope_paths_mode: enforce
closed_lanes: irreversible
---

# Catalogue ticket

A catalogue ticket changes manifests under k8s/ and tests under tests/, and
nothing else. Deleting a cluster object cannot be taken back.
