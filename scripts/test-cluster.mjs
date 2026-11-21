import { requireOwnedCluster, runClusterAcceptance } from "./lab.mjs";
import { runTrafficExperiment } from "./traffic.mjs";

try {
  await runClusterAcceptance();
  const state = await requireOwnedCluster();
  const traffic = await runTrafficExperiment(
    new URL(`http://127.0.0.1:${state.hostPort}/`),
    30,
    3,
  );

  if (
    traffic.successfulResponses !== 30 ||
    traffic.httpErrors > 0 ||
    traffic.transportErrors > 0 ||
    traffic.uniqueResponseRequestIds !== 30
  ) {
    throw new Error(
      "The healthy cluster did not complete all 30 unique requests",
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
