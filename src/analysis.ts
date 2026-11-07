import { z } from 'zod';
import type { Env } from './index';

const sentence = z.string().min(1).max(700).regex(/\S/);
const list = z.array(sentence).min(1).max(4);
const schema = z.strictObject({ summary: sentence, possibleCauses: list, suggestedNextSteps: list });
export const analysisJsonSchema = z.toJSONSchema(schema);
export type Analysis = z.infer<typeof schema>;

export function validated(value: unknown): Analysis | null {
    try {
        const result = schema.safeParse(typeof value === 'string' ? JSON.parse(value) : value);
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}

export async function analyse(env: Env, eventId: string, retry = false): Promise<boolean> {
    const db = env.edgeguard_db;
    const attempt = crypto.randomUUID();
    const now = Date.now();
    const claim = await db.prepare(`
        UPDATE incidents SET analysis_state = 'running', analysis_attempt = ?, analysis_expires_at = ?
        WHERE event_id = ? AND (analysis_state = ? OR (analysis_state = 'running' AND analysis_expires_at <= ?))
    `).bind(attempt, now + 60_000, eventId, retry ? 'failed' : 'pending', now).run();
    if (!claim.meta.changes) return false;

    const evidence = await db.prepare('SELECT status, latency_ms AS latencyMs FROM events WHERE id = ?')
        .bind(eventId).first();
    let result: Analysis | null = null;
    try {
        if (!env.AI || !env.AI_GATEWAY_ID) throw new Error('Inference unavailable');
        const output = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
                { role: 'system', content: 'Write concise English incident triage. Summarise only the observed HTTP status and latency in milliseconds. Frame possible causes as unverified hypotheses. Suggest specific checks, never claim a root cause.' },
                { role: 'user', content: JSON.stringify(evidence) },
            ],
            response_format: { type: 'json_schema', json_schema: analysisJsonSchema },
            max_tokens: 550,
        }, {
            signal: AbortSignal.timeout(20_000),
            gateway: { id: env.AI_GATEWAY_ID, requestTimeoutMs: 18_000, skipCache: true, collectLog: false },
        });
        if (output && typeof output === 'object' && 'response' in output) result = validated(output.response);
    } catch {
        // Provider errors and raw model output may contain sensitive details.
    }
    // A late response cannot overwrite a newer attempt or change incident status.
    await db.prepare(`UPDATE incidents SET analysis_state = ?, analysis_json = ?,
        analysis_attempt = NULL, analysis_expires_at = NULL WHERE event_id = ? AND analysis_attempt = ?`)
        .bind(result ? 'complete' : 'failed', result ? JSON.stringify(result) : null, eventId, attempt).run();
    return true;
}
