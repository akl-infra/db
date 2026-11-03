// The probe Lambda's handler (infra/akldb-probe.yaml; LDB-PV9). Invoked by hand only (scripts/aws/probe.sh run), never by a
// schedule or a URL: `{"targets":{"prod":"https://api.akldb.org","shadow":"https://shadow-api.akldb.org"},"n":20}`.
// It answers the measurement of measure.mjs as JSON. It reads nothing but public GETs of the three akldb hosts.
import { probe } from "./measure.mjs";

export const handler = async (event) => {
  const targets = event?.targets ?? { prod: "https://api.akldb.org", shadow: "https://shadow-api.akldb.org" };
  const n = Number.isInteger(event?.n) && event.n > 0 && event.n <= 60 ? event.n : 20;
  const result = await probe({ targets, n });
  console.log(`akldb-probe: ${result.routes.length} routes, n=${n}, vantage=${result.vantage}`);
  return result;
};
