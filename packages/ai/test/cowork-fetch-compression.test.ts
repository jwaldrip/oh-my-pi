import { describe, expect, test } from "bun:test";
import * as http from "node:http";
import * as zlib from "node:zlib";

const { coworkFetch } = await import("../src/providers/cowork-fetch");
describe("coworkFetch decompression", () => {
	async function testDecompression(encoding: string, compress: (data: Buffer) => Buffer, expectedError?: RegExp) {
		const server = http.createServer((req, res) => {
			if (req.url === "/mock") {
				const payload = Buffer.from("test payload", "utf8");
				const compressed = compress(payload);
				res.writeHead(200, {
					"content-encoding": encoding,
					"content-type": "text/plain",
					"content-length": String(compressed.length),
				});
				res.end(compressed);
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Server not listening on a port");
		const port = address.port;

		try {
			const res = await coworkFetch(`http://127.0.0.1:${port}/mock`);
			expect(res.status).toBe(200);
			const text = await res.text();
			expect(text).toBe("test payload");
		} catch (e) {
			if (expectedError) {
				expect((e as Error).message).toMatch(expectedError);
			} else {
				throw e;
			}
			return;
		} finally {
			await new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res())));
		}

		if (expectedError) {
			throw new Error(`Expected error matching ${expectedError}, but the request succeeded`);
		}
	}

	test("decompresses gzip", () => testDecompression("gzip", zlib.gzipSync));
	test("decompresses deflate", () => testDecompression("deflate", zlib.deflateSync));
	test("decompresses br", () => testDecompression("br", zlib.brotliCompressSync));

	test("handles zstd (mocked or throws)", async () => {
		const z = zlib as Record<string, unknown>;
		const createZstdDecompress = typeof z.createZstdDecompress === "function" ? z.createZstdDecompress : undefined;
		const zstdCompressSync = typeof z.zstdCompressSync === "function" ? z.zstdCompressSync : undefined;

		if (createZstdDecompress && zstdCompressSync) {
			await testDecompression("zstd", (buf: Buffer) => zstdCompressSync(buf) as Buffer);
		} else if (createZstdDecompress) {
			// Runtime can decompress but has no sync compressor; assert it fails cleanly on bad input.
			await testDecompression("zstd", b => b, /unexpected end of file/);
		} else {
			await testDecompression("zstd", b => b, /zstd compression is not supported/);
		}
	});
});
