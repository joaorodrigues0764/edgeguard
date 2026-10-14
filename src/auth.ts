export type ApiRole = "ingest" | "dashboard" | "admin";

export interface AuthSecrets {
    INGEST_API_TOKEN?: string;
    DASHBOARD_API_TOKEN?: string;
    ADMIN_API_TOKEN?: string;
}

function timingSafeStringEqual(
    candidate: string,
    expected: string,
): boolean {
    const encoder = new TextEncoder();
    const candidateBytes = encoder.encode(candidate);
    const expectedBytes = encoder.encode(expected);

    if (candidateBytes.byteLength !== expectedBytes.byteLength) {
        return !crypto.subtle.timingSafeEqual(
            candidateBytes,
            candidateBytes,
        );
    }

    return crypto.subtle.timingSafeEqual(
        candidateBytes,
        expectedBytes,
    );
}

function unauthorizedResponse(): Response {
    return Response.json(
        { error: "Unauthorized" },
        {
            status: 401,
            headers: {
                "WWW-Authenticate": "Bearer",
            },
        },
    );
}

function forbiddenResponse(): Response {
    return Response.json(
        { error: "Forbidden" },
        { status: 403 },
    );
}

export function authorizeRequest(
    request: Request,
    env: AuthSecrets,
    allowedRoles: readonly ApiRole[],
): Response | null {
    const header = request.headers.get("Authorization");
    const match = header?.trim().match(/^Bearer\s+(\S+)$/i);
    const providedToken = match?.[1];

    if (!providedToken) {
        return unauthorizedResponse();
    }

    const configuredTokens: Array<{
        role: ApiRole;
        token: string | undefined;
    }> = [
        {
            role: "ingest",
            token: env.INGEST_API_TOKEN,
        },
        {
            role: "dashboard",
            token: env.DASHBOARD_API_TOKEN,
        },
        {
            role: "admin",
            token: env.ADMIN_API_TOKEN,
        },
    ];

    let matchedRole: ApiRole | null = null;
    let matchCount = 0;

    for (const configured of configuredTokens) {
        if (!configured.token) {
            continue;
        }

        if (
            timingSafeStringEqual(
                providedToken,
                configured.token,
            )
        ) {
            matchedRole = configured.role;
            matchCount++;
        }
    }

    if (matchCount !== 1 || matchedRole === null) {
        return unauthorizedResponse();
    }

    if (!allowedRoles.includes(matchedRole)) {
        return forbiddenResponse();
    }

    return null;
}