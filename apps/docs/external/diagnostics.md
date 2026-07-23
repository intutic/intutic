# Diagnostics & Verification Runbook <Badge type="danger" text="Enterprise" />

This runbook documents the standard command-line diagnostics and validation steps to inspect and troubleshoot internal cluster routing, LiteLLM health, and proxy-to-backend communication.

---

## 1. Kubernetes Cluster Status

### Check Service Pods
Verify the running state of the control plane, proxy gateway, and LiteLLM service pods in the development namespace (`intutic-dev`):
```bash
kubectl get pods -n intutic-dev
```

### Describe Service Specs
Inspect events, health check states, and volume mounts for the LiteLLM pod:
```bash
kubectl describe pod -l app=litellm -n intutic-dev
```

### Stream Service Logs
To view startup parameters or trace runtime errors:
```bash
# LiteLLM helper logs
kubectl logs -l app=litellm -n intutic-dev --tail=100 -f

# Rust Proxy Gateway logs
kubectl logs deployment/proxy -n intutic-dev --tail=100 -f

# Node.js Control Plane logs
kubectl logs deployment/control-plane -n intutic-dev --tail=100 -f
```

---

## 2. Ingress & Routing Validation

### Describe Ingress Routes
Ensure that external domains are mapped correctly and that private helpers (like `litellm`) are **not** exposed externally:
```bash
kubectl describe ingress intutic-ingress -n intutic-dev
```

### Inspect Internal Endpoints
Verify that the `litellm` ClusterIP service is successfully mapped to a running pod IP:
```bash
kubectl get endpoints -n intutic-dev
```

---

## 3. Internal Service Health Queries

Because the `litellm` pod is private to the cluster network, you must run health check commands from inside another container in the same namespace.

### Test LiteLLM via Curl
Execute an internal HTTP request to the health endpoint from the `control-plane` deployment:
```bash
kubectl exec deployment/control-plane -n intutic-dev -- curl -s http://litellm:4000/health
```

*Expected response:*
```json
{
  "healthy_endpoints": [{"model": "openai/gpt-4o-mini"}],
  "unhealthy_endpoints": [],
  "healthy_count": 1,
  "unhealthy_count": 0
}
```

### Test LiteLLM via Wget
If curl is absent in the target image, use wget:
```bash
kubectl exec deployment/control-plane -n intutic-dev -- wget -qO- http://litellm:4000/health
```

---

## 4. Local Access & Debugging

### Port-Forwarding
If you need to connect your local terminal or tools to the GKE-deployed LiteLLM instance:
```bash
kubectl port-forward svc/litellm 4000:4000 -n intutic-dev
```

### GKE Autopilot Troubleshooting
If a new deployment pod remains in a `Pending` state:
1. **Node Provisioning Latency**: GKE Autopilot requires 1–2 minutes to automatically spin up a new virtual node when resource requests exceed cluster headroom.
2. **Image Pull Times**: Large docker images (like `ghcr.io/berriai/litellm:main-latest`) require several minutes to pull on fresh nodes. Run `kubectl describe pod` to monitor image pulling progress events.
