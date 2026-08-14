import { describe, expect, test } from "bun:test";
import { resolveDaemonAddress } from "../../../src/modes/client/daemon-config";

describe("resolveDaemonAddress", () => {
	test("keeps endpoint and credential resolution together for a live control leg", () => {
		const address = resolveDaemonAddress({
			home: "/does-not-exist",
			env: { OMPD_URL: "http://127.0.0.1:9900/", OMPD_TOKEN: " control-token " },
		});
		expect(address).toEqual({ baseUrl: "http://127.0.0.1:9900", token: "control-token" });
	});
});
