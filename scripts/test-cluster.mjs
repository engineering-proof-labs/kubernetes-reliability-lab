import { runClusterAcceptance } from "./lab.mjs";

try {
  await runClusterAcceptance();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
