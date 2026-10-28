import { describe, expect, it, vi } from "vitest";
import { MAX_JSON_BODY_BYTES, readJsonBody } from "../src/body";

describe("Bounded JSON bodies", () => {
    it("accepts a body exactly at the byte limit", async () => {
        const body = `"${"x".repeat(MAX_JSON_BODY_BYTES - 2)}"`;
        const result = await readJsonBody(new Request("https://example.com", {
            method: "POST", body,
        }));
        expect(result).toEqual({ ok: true, value: "x".repeat(MAX_JSON_BODY_BYTES - 2) });
    });

    it("rejects oversized declared bodies before reading the stream", async () => {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel });
        const result = await readJsonBody(new Request("https://example.com", {
            method: "POST", body,
            headers: { "Content-Length": String(MAX_JSON_BODY_BYTES + 1) },
        }));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.response.status).toBe(413);
        expect(cancel).toHaveBeenCalledOnce();
    });

    it.each([undefined, "1"])(
        "enforces byte limits on streamed Unicode even with Content-Length %s",
        async (contentLength) => {
            const cancel = vi.fn();
            const encoder = new TextEncoder();
            let reads = 0;
            const body = new ReadableStream<Uint8Array>({
                pull(controller) {
                    reads++;
                    controller.enqueue(encoder.encode("é".repeat(8192)));
                },
                cancel,
            });
            const headers = new Headers();
            if (contentLength) headers.set("Content-Length", contentLength);
            const result = await readJsonBody(new Request("https://example.com", {
                method: "POST", body, headers,
            }));
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.response.status).toBe(413);
            expect(cancel).toHaveBeenCalledOnce();
            expect(reads).toBeLessThanOrEqual(6);
        },
    );

    it("decodes characters split across stream chunks", async () => {
        const bytes = new TextEncoder().encode('{"path":"/café"}');
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
                controller.close();
            },
        });
        expect(await readJsonBody(new Request("https://example.com", {
            method: "POST", body,
        }))).toEqual({ ok: true, value: { path: "/café" } });
    });

    it.each(["", "{", "   "])("rejects invalid JSON %j", async (body) => {
        const result = await readJsonBody(new Request("https://example.com", {
            method: "POST", body,
        }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.response.status).toBe(400);
            expect(await result.response.json()).toEqual({ error: "Invalid JSON body" });
        }
    });
});
