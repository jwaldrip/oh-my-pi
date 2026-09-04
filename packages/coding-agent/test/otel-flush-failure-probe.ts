/**
 * Failure-path probe for flushTelemetryExport(), run as a subprocess by
 * telemetry-export.test.ts (the registered global provider must not leak into
 * the runner).
 *
 * Stands up a loopback collector that answers 500 to every export, registers
 * the provider, emits a span, and flushes. The exporter rejects that export
 * with an OTLPExporterError; the contract under test is that the rejection
 * stays inside flushTelemetryExport(). Print mode flushes on its error path
 * right before writing the model's error to stderr, and a `Promise.all` here
 * let a collector outage replace `Google API error (400): ...` with an
 * exporter stack trace. A 5xx in the retryable set (502/503/504) ends in the
 * same terminal rejection after backoff; 500 gets there without the wait.
 *
 * Exits 0 only if the flush resolved and the collector was actually hit.
 */

import {
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { trace } from "@opentelemetry/api";

let hits = 0;

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		if (req.method === "POST") {
			await req.arrayBuffer();
			hits++;
			return new Response('{"error":"collector unavailable"}', {
				status: 500,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("not found", { status: 404 });
	},
});

process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://localhost:${server.port}/v1/traces`;
process.env.OTEL_SERVICE_NAME = "oh-my-pi-flush-failure-probe";

await initTelemetryExport();
if (!isTelemetryExportEnabled()) {
	console.error("PROBE: provider did not register");
	await server.stop(true);
	process.exit(2);
}

trace.getTracer("@oh-my-pi/pi-agent-core").startSpan("agent.llm_call").end();

let outcome: "resolved" | "rejected";
try {
	await flushTelemetryExport();
	outcome = "resolved";
} catch {
	outcome = "rejected";
}
await server.stop(true);

console.log(`PROBE: flush ${outcome}, collector hits=${hits}`);
process.exit(outcome === "resolved" && hits > 0 ? 0 : 1);
