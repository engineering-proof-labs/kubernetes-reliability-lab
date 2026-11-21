# Kubernetes Reliability Lab

A small TypeScript service for experiments with Kubernetes Deployments, Services, health probes, and graceful termination. The lab runs three API replicas and checks how the Service responds to Pod replacement, readiness failures, stalled updates, and shutdown with work in flight.

The kind cluster has one node, so all three Pods run on the same machine. The lab demonstrates startup, readiness, and liveness probes, a healthy rolling update, and an explicit rollback after a stalled update. It does not demonstrate behavior across multiple machines.

## Requirements

- Node.js 24 and npm.
- Docker with a running Linux container engine.
- Internet access on the first `lab:up` run. The scripts download pinned `kind` and `kubectl` binaries and verify their published SHA-256 checksums. They stay under `.cache/tools` and do not replace a system `kubectl`.

The cluster uses kind `0.33.0` with Kubernetes `1.35.8`; `kubectl` is also pinned to `1.35.8`. The API container uses the digest-pinned `node:24.22.1-bookworm-slim` image. The selected client and server versions follow the [Kubernetes version skew policy](https://kubernetes.io/releases/version-skew-policy/).

## Run the lab

From the repository directory:

```sh
npm ci
npm run verify
npm run dev
```

`npm run dev` starts the API at <http://127.0.0.1:8080> with version `dev` and the machine hostname as its instance ID. Press Ctrl+C to stop it. `PORT` changes the local listening port when needed. Stop the local process before starting the cluster if both would use the same host port.

Then start the Kubernetes lab in a separate terminal:

```sh
npm run lab:up
```

`lab:up` builds the API image, creates the one-node cluster when needed, loads the image into kind, applies the namespace, Deployment, and Service, waits for the Deployment, and checks the HTTP routes. The API is exposed at <http://127.0.0.1:8080> by default.

Use these commands to inspect the running lab:

```sh
npm run lab:status
npm run lab:check
npm run test:cluster
npm run experiment:traffic
npm run experiment:replace-pod
npm run experiment:probes
npm run experiment:rollout
npm run experiment:termination
npm run lab:logs
```

`lab:status` prints the Deployment, Pods, and Service. `lab:check` queries the API and its health routes. `test:cluster` checks the HTTP contract, three ready Pods, three Service endpoints, configured resources, and a short run of new HTTP connections. `lab:logs` follows the API container logs; press Ctrl+C to stop following them.

## Replica experiments

`experiment:traffic` sends 60 requests with four concurrent workers by default. Each request opens a new TCP connection, then records the HTTP status, response request ID, instance ID, transport errors, and client-side latency. Choose a different request count and concurrency when needed:

```sh
npm run experiment:traffic -- 90 3
```

The output groups successful responses by `instanceId` and reports latency percentiles for that run. It does not expect equal counts from each Pod; the result depends on the local run and connection routing.

`experiment:replace-pod` records the three ready Pod names and UIDs, deletes one Pod through the lab's kubeconfig and namespace, then waits for the Deployment to restore three ready Pods. It verifies that Kubernetes created a new UID and that the Service has three ready endpoints afterward.

## Probe experiment

Each container simulates an eight-second initialization period. The startup probe gates readiness and liveness until `/health/startup` succeeds. This delay exists to make the startup behavior observable; the API does not perform real initialization work.

`experiment:probes` writes a readiness marker into one container's temporary filesystem. It checks that the Pod becomes unready and leaves the set of ready Service endpoints while its container keeps running and its restart count stays unchanged. The liveness route remains healthy during this phase.

The script then writes a separate liveness marker. Kubernetes restarts that container after repeated failed checks. The experiment checks the restart count, Pod UID, startup probe state, and that the marker disappears when the container starts again. Marker files are created with `kubectl exec`; the API has no administrative route for changing health state.

## Rollout experiment

`experiment:rollout` first changes `APP_VERSION` to a new identifiable release label and waits for all three Pods to serve it. It then sets `READINESS_MODE=blocked`, which keeps new Pods unready while the old release continues serving.

The Deployment uses `maxUnavailable: 0`, `maxSurge: 1`, and a 60-second progress deadline. The script waits up to 120 seconds for the `ProgressDeadlineExceeded` condition, records the Deployment and blocked Pod descriptions, ReplicaSet identity, and ready EndpointSlice targets, then sends 30 requests through the Service while the three old endpoints remain ready. It issues `kubectl rollout undo` to the saved baseline revision and verifies the original image and configuration are serving again. Kubernetes reports the stalled rollout; the script performs the rollback explicitly.

## Termination experiment

`GET /work?durationMs=10000` simulates one bounded operation. The API accepts durations from 1 to 10,000 milliseconds and logs an operation ID so the experiment can identify which Pod received it.

`experiment:termination` starts that request through the Service, waits for its start log, and deletes the serving Pod with a 30-second grace period. The process handles `SIGTERM` by calling `server.close()`, which stops new connections while the active response drains. If draining reaches 20 seconds, the process closes remaining HTTP connections and exits with a failure status. The script samples the Service from just before requesting deletion until the replacement is ready, waiting 250 ms after each response or transport failure before sending the next request. Each attempt records when it was sent relative to the start of deletion. Compare those offsets with when the delete command returned, when the script observed the terminating endpoint, and when it verified the replacement. Endpoint timestamps show when the script observed the state. The script also verifies that the original request completed, checks the shutdown logs, and reports the replacement Pod UID.

The simulated operation has no external side effects. This experiment measures one local run; it does not promise that every new request succeeds during termination.

To remove the cluster:

```sh
npm run lab:down
```

This removes the named kind cluster and its local kubeconfig and state file. It keeps the downloaded tools and Docker images for the next run. Every `kubectl` operation uses the lab's kubeconfig, the `kind-reliability-lab` context, and the `reliability-lab` namespace. Before deleting, the script checks that the cluster's control-plane container matches the identifier recorded by this checkout.

If port `8080` is already in use, select a different host port when creating the cluster. For PowerShell:

```powershell
$env:LAB_HOST_PORT = "8081"
npm run lab:up
Remove-Item Env:LAB_HOST_PORT
```

For Bash:

```sh
LAB_HOST_PORT=8081 npm run lab:up
```

The chosen port is stored with the local cluster state and used by `lab:check` and `test:cluster`. Keep the same value if explicitly setting `LAB_HOST_PORT` again for an existing cluster. The default remains `8080`.

## What to observe

kind runs the Kubernetes node as a Docker container. Each application container runs inside a Pod managed by a Deployment. A Service selects the three Pods and exposes port `30080` on the kind node; kind maps that NodePort to the host's loopback address.

The Deployment keeps three replicas. Each Pod receives its own name through the Downward API as `POD_NAME`; when running locally, the process uses the machine hostname. `APP_VERSION` comes from the lab image tag, or defaults to `dev` when running with `npm run dev`.

The API contract is:

| Request                      | Result                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `GET /`                      | JSON containing `version` and `instanceId`                                            |
| `GET /health/startup`        | `503` during simulated initialization, then `200`                                     |
| `GET /health/ready`          | `200` when ready; `503` while the readiness marker exists or `READINESS_MODE=blocked` |
| `GET /health/live`           | `200` while live; `503` while the liveness marker exists                              |
| `GET /work?durationMs=10000` | Completes after the requested delay, limited to 10 seconds                            |
| Any other route              | `404` with `{"error":"not_found"}`                                                    |

Each completed request writes one JSON log line with a timestamp, a server-generated request ID, method, path, status, duration, instance, and version. Query strings are omitted from the logged path.

The Deployment's CPU and memory requests and limits are starting values for this lab, not capacity recommendations. The readiness and liveness markers are independent files in the container's temporary directory. The readiness marker does not restart the container; the liveness marker causes a restart, which removes files from that container's writable layer. During the rollout experiment, readiness can also be held false by configuration without affecting liveness.

## Verification

`npm run verify` runs TypeScript type checking, ESLint, Prettier, the HTTP tests, and a TypeScript build. `npm run test:cluster` and the `experiment:*` commands require a running lab. The CI workflow runs the cluster checks and experiments on Ubuntu, then removes its temporary cluster.

The cluster has one node and runs locally in Docker. Results here do not establish multi-node availability, production capacity, or behavior during a datacenter failure.

## Kubernetes references

- [kind quick start](https://kind.sigs.k8s.io/docs/user/quick-start/)
- [kind cluster configuration and port mappings](https://kind.sigs.k8s.io/docs/user/configuration/)
- [Kubernetes Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Kubernetes Services](https://kubernetes.io/docs/concepts/services-networking/service/)
- [Kubernetes startup, liveness, and readiness probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)
- [Kubernetes EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/)
- [kubectl rollout undo](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_rollout/kubectl_rollout_undo/)
- [Kubernetes Pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-termination/)
- [kubectl logs](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/)
- [Node.js v24 HTTP server API](https://nodejs.org/download/release/v24.22.1/docs/api/http.html)
