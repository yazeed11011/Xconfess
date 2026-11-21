import { resolveBackendRoute } from "@/app/lib/api/proxy";
import { createApiErrorResponse } from "@/lib/apiErrorHandler";
import { getOrCreateRequestId } from "@/app/lib/utils/requestId";


export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const requestId = getOrCreateRequestId(_request);
    if (!id) {
      return createApiErrorResponse("Confession ID is required", { status: 400, correlationId: requestId });
    }

    const backend = resolveBackendRoute(_request, `/confessions/${id}`);
    const response = await fetch(backend.url, {
      method: "GET",
      headers: { "Content-Type": "application/json", "x-request-id": requestId },
      next: { revalidate: 30 },
    });

    if (!response.ok) {
      const privacySensitive = [401, 403, 404, 410, 419].includes(response.status);
      if (privacySensitive) {
        return new Response(
          JSON.stringify({
            code: "RESOURCE_UNAVAILABLE",
            message: "This resource is unavailable.",
            status: response.status,
          }),
          {
            status: response.status,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
          },
        );
      }
      if (response.status >= 500) {
        return createApiErrorResponse(
          "The server could not complete the request. Please try again.",
          {
            status: response.status,
            correlationId: requestId,
            fallbackMessage: "The server could not complete the request. Please try again.",
            route: "GET /api/confessions/[id]",
            upstreamResponse: response,
          },
        );
      }
      const err = await response.json().catch(() => ({}));
      return createApiErrorResponse(err, {
        status: response.status,
          upstreamResponse: response,
        fallbackMessage: "Failed to fetch confession",
        route: "GET /api/confessions/[id]"
      });
    }

    const data = await response.json();

    // Normalize to frontend shape: message -> content, created_at -> createdAt, view_count -> viewCount
    const normalized = {
      id: data.id,
      content: data.message ?? data.body ?? data.content,
      message: data.message,
      createdAt: data.created_at ?? data.createdAt,
      created_at: data.created_at,
      viewCount: data.view_count ?? data.viewCount ?? 0,
      view_count: data.view_count,
      reactions: aggregateReactions(data.reactions),
      commentCount: Array.isArray(data.comments)
        ? data.comments.length
        : (data.commentCount ?? 0),
      isAnchored: data.isAnchored ?? data.is_anchored ?? false,
      stellarTxHash: data.stellarTxHash ?? data.stellar_tx_hash ?? null,
      author: data.anonymousUser
        ? { id: data.anonymousUser.id, username: "Anonymous", avatar: null }
        : undefined,
    };

    return new Response(JSON.stringify(normalized), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return createApiErrorResponse(
      "The server could not complete the request. Please try again.",
      {
      status: 500,
      fallbackMessage: "The server could not complete the request. Please try again.",
        route: "GET /api/confessions/[id]",
      },
    );
  }
}

function aggregateReactions(reactions: Array<{ emoji?: string }> | undefined): {
  like: number;
  love: number;
} {
  if (!Array.isArray(reactions)) return { like: 0, love: 0 };
  let like = 0;
  let love = 0;
  for (const r of reactions) {
    const e = (r.emoji ?? "").toLowerCase();
    if (e === "👍" || e === "like") like++;
    else if (e === "❤️" || e === "love") love++;
  }
  return { like, love };
}
