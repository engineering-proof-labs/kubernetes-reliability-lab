import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { requireOwnedCluster } from "./lab.mjs";

const defaultRequestCount = 60;
const defaultConcurrency = 4;
const requestTimeoutMs = 5_000;

async function main() {
  const [requestCount, concurrency] = parseArguments(process.argv.slice(2));
  const state = await requireOwnedCluster();
  const endpoint = new URL(`http://127.0.0.1:${state.hostPort}/`);
  await runTrafficExperiment(endpoint, requestCount, concurrency);
}

function parseArguments(args) {
  if (args.length > 2) {
    throw new Error(
      "Usage: npm run experiment:traffic -- [requests] [concurrency]",
    );
  }

  const requestCount = parsePositiveInteger(
    args[0],
    defaultRequestCount,
    "requests",
    1_000,
  );
  const concurrency = parsePositiveInteger(
    args[1],
    defaultConcurrency,
    "concurrency",
    50,
  );
  if (concurrency > requestCount) {
    throw new Error("Concurrency cannot exceed the request count");
  }

  return [requestCount, concurrency];
}

function parsePositiveInteger(raw, fallback, label, maximum) {
  if (raw === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }

  const value = Number(raw);
  if (value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }

  return value;
}

export async function runTrafficExperiment(
  endpoint,
  requestCount,
  concurrency,
) {
  const results = new Array(requestCount);
  let nextRequest = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (nextRequest < requestCount) {
      const index = nextRequest;
      nextRequest += 1;
      results[index] = await sendRequest(endpoint);
    }
  });

  await Promise.all(workers);
  const summary = summarizeResults(
    endpoint,
    requestCount,
    concurrency,
    results,
  );
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

export async function sampleServiceTraffic(endpoint, startedAt, signal) {
  const intervalMs = 250;
  const attempts = [];

  while (!signal.aborted) {
    const sentAtMs = elapsedMilliseconds(startedAt);
    const response = await sendRequest(endpoint);
    attempts.push({ sentAtMs, ...response });
    if (!signal.aborted) {
      await delay(intervalMs);
    }
  }

  return {
    ...summarizeResults(endpoint, attempts.length, 1, attempts),
    intervalMs,
    attempts,
  };
}

function sendRequest(endpoint) {
  const startedAt = performance.now();

  return new Promise((resolveRequest) => {
    const request = httpRequest(
      endpoint,
      {
        method: "GET",
        agent: false,
        headers: {
          accept: "application/json",
          connection: "close",
        },
      },
      (response) => {
        let responseText = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (responseText += chunk));
        response.once("error", (error) =>
          resolveRequest(transportFailure(startedAt, error)),
        );
        response.once("aborted", () =>
          resolveRequest(
            transportFailure(startedAt, new Error("Response aborted")),
          ),
        );
        response.once("end", () => {
          let body;
          try {
            body = JSON.parse(responseText);
          } catch {
            body = null;
          }

          resolveRequest({
            latencyMs: elapsedMilliseconds(startedAt),
            statusCode: response.statusCode ?? 0,
            requestId: response.headers["x-request-id"],
            instanceId: isValidApiResponse(response.statusCode, body)
              ? body.instanceId
              : undefined,
            successful: isValidApiResponse(response.statusCode, body),
          });
        });
      },
    );

    const timer = setTimeout(() => {
      const error = new Error("Request timed out");
      error.code = "ETIMEDOUT";
      request.destroy(error);
    }, requestTimeoutMs);
    request.once("close", () => clearTimeout(timer));
    request.once("error", (error) =>
      resolveRequest(transportFailure(startedAt, error)),
    );
    request.end();
  });
}

function isValidApiResponse(statusCode, body) {
  return (
    statusCode === 200 &&
    body !== null &&
    typeof body === "object" &&
    typeof body.version === "string" &&
    typeof body.instanceId === "string"
  );
}

function transportFailure(startedAt, error) {
  return {
    latencyMs: elapsedMilliseconds(startedAt),
    transportError: error.code ?? error.name,
  };
}

function elapsedMilliseconds(startedAt) {
  return round(performance.now() - startedAt);
}

function summarizeResults(endpoint, requestCount, concurrency, results) {
  const statusCodes = {};
  const instances = {};
  const transportErrors = {};
  const requestIds = new Set();

  for (const result of results) {
    if (result.statusCode !== undefined) {
      increment(statusCodes, String(result.statusCode));
    }
    if (result.successful) {
      increment(instances, result.instanceId);
    }
    if (result.requestId) {
      requestIds.add(result.requestId);
    }
    if (result.transportError) {
      increment(transportErrors, result.transportError);
    }
  }

  const successfulResponses = results.filter(
    (result) => result.successful,
  ).length;
  const transportErrorCount = results.filter(
    (result) => result.transportError !== undefined,
  ).length;
  const latencies = results
    .map((result) => result.latencyMs)
    .sort((first, second) => first - second);

  return {
    endpoint: endpoint.href,
    connectionMode: "one new TCP connection per request",
    attempted: requestCount,
    concurrency,
    successfulResponses,
    httpErrors: requestCount - successfulResponses - transportErrorCount,
    transportErrors: transportErrorCount,
    statusCodes,
    instances,
    uniqueResponseRequestIds: requestIds.size,
    transportErrorCodes: transportErrors,
    latencyMs: {
      min: latencies[0] ?? 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.at(-1) ?? 0,
    },
  };
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function percentile(sortedValues, percentile) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.ceil(percentile * sortedValues.length) - 1;
  return sortedValues[index];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
