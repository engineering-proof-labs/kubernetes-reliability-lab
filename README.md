# Kubernetes Reliability Lab

A small TypeScript service for experiments with Kubernetes Deployments and Services. The current stage runs three API replicas and verifies how the Service responds when a Pod is replaced.

The kind cluster has one node, so all three Pods run on the same machine. The lab does not yet demonstrate probe-driven recovery, rolling updates, or behavior across multiple machines. The `/health/live` route is available to query, but Kubernetes probes are not configured yet.

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
npm run lab:logs
```

`lab:status` prints the Deployment, Pods, and Service. `lab:check` queries the root and liveness routes. `test:cluster` checks the HTTP contract, three ready Pods, three Service endpoints, configured resources, and a short run of new HTTP connections. `lab:logs` follows the API container logs; press Ctrl+C to stop following them.

## Replica experiments

`experiment:traffic` sends 60 requests with four concurrent workers by default. Each request opens a new TCP connection, then records the HTTP status, response request ID, instance ID, transport errors, and client-side latency. Choose a different request count and concurrency when needed:

```sh
npm run experiment:traffic -- 90 3
```

The output groups successful responses by `instanceId` and reports latency percentiles for that run. It does not expect equal counts from each Pod; the result depends on the local run and connection routing.

`experiment:replace-pod` records the three ready Pod names and UIDs, deletes one Pod through the lab's kubeconfig and namespace, then waits for the Deployment to restore three ready Pods. It verifies that Kubernetes created a new UID and that the Service has three ready endpoints afterward.

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

| Request            | Result                                                  |
| ------------------ | ------------------------------------------------------- |
| `GET /`            | JSON containing `version` and `instanceId`              |
| `GET /health/live` | `200` with `{"status":"ok"}` while the process responds |
| Any other route    | `404` with `{"error":"not_found"}`                      |

Each completed request writes one JSON log line with a timestamp, a server-generated request ID, method, path, status, duration, instance, and version. Query strings are omitted from the logged path.

The Deployment's CPU and memory requests and limits are starting values for this lab, not capacity recommendations. A Pod shown as Ready in this stage has no readiness probe configured; the HTTP checks are separate from Kubernetes readiness. Probe behavior is a later experiment.

## Verification

`npm run verify` runs TypeScript type checking, ESLint, Prettier, the HTTP tests, and a TypeScript build. `npm run test:cluster` and `npm run experiment:replace-pod` require a running lab. The CI workflow runs these checks on Ubuntu and removes its temporary cluster afterward.

The cluster has one node and runs locally in Docker. Results here do not establish multi-node availability, production capacity, or behavior during a datacenter failure.

## Kubernetes references

- [kind quick start](https://kind.sigs.k8s.io/docs/user/quick-start/)
- [kind cluster configuration and port mappings](https://kind.sigs.k8s.io/docs/user/configuration/)
- [Kubernetes Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Kubernetes Services](https://kubernetes.io/docs/concepts/services-networking/service/)
