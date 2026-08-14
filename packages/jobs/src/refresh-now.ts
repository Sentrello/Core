/**
 * Fetches a licence token immediately, then exits.
 *
 * The daily job is what keeps a token fresh, but it does nothing for the gap
 * between paying and the first scheduled run — a customer would install Pro and
 * watch it behave as Free until the small hours. The installer runs this once,
 * and it is also the thing to run by hand after adding a module.
 */
import { refreshLicenseToken } from "./license-refresh";

const result = await refreshLicenseToken();

if (result.refreshed) {
  console.log("licence activated");
  process.exit(0);
}

// The licence is valid but already in use elsewhere. Almost always a customer
// who moved to a new server, so the message names that case first rather than
// accusing them of sharing a key.
if (result.error === "instance_limit") {
  console.error(
    "this licence is already active on another server.\n" +
      "If you have moved to a new machine, ask support to release the old one.",
  );
  process.exit(1);
}

if (result.error === "not_entitled") {
  console.error(
    "this licence is not active — check the subscription is paid and current.",
  );
  process.exit(1);
}

if (result.error === "invalid_license") {
  console.error("that licence key was not recognised.");
  process.exit(1);
}

console.error(
  "could not activate the licence: the server could not be reached.",
);
process.exit(1);
