export const MAX_JSON_BODY_BYTES = 64 * 1024;

type JsonBodyResult =
    | { ok: true; value: unknown }
    | { ok: false; response: Response };

function oversizedBody(): JsonBodyResult {
    return {
        ok: false,
        response: Response.json(
            { error: "JSON body must not exceed 65536 bytes" },
            { status: 413 },
        ),
    };
}

export async function readJsonBody(request: Request): Promise<JsonBodyResult> {
    if (Number(request.headers.get("Content-Length")) > MAX_JSON_BODY_BYTES) {
        await request.body?.cancel().catch(() => {});
        return oversizedBody();
    }

    const reader = request.body?.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";

    try {
        if (reader) {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                size += value.byteLength;
                if (size > MAX_JSON_BODY_BYTES) {
                    await reader.cancel().catch(() => {});
                    return oversizedBody();
                }
                text += decoder.decode(value, { stream: true });
            }
        }

        text += decoder.decode();
        return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
        return {
            ok: false,
            response: Response.json(
                { error: "Invalid JSON body" },
                { status: 400 },
            ),
        };
    } finally {
        reader?.releaseLock();
    }
}
