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

console.error(
  "could not activate the licence: the server refused or was unreachable",
);
process.exit(1);
