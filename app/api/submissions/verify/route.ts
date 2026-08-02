import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { serviceSubmissions } from "../../../../db/schema";
import {
  canonicalOrigin,
  publicSubmission,
  verificationUrl,
} from "../../../../lib/service-verification";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      return Response.json({ error: "Submission id is required." }, { status: 400 });
    }
    const db = await getDb();
    const [record] = await db
      .select()
      .from(serviceSubmissions)
      .where(eq(serviceSubmissions.id, body.id))
      .limit(1);
    if (!record) return Response.json({ error: "Submission not found." }, { status: 404 });

    const manifestResponse = await fetch(verificationUrl(record.canonicalUrl), {
      headers: { accept: "application/json", "user-agent": "Agentic-Payments-Index-Verifier/1.0" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!manifestResponse.ok) {
      throw new Error(`Verification file returned HTTP ${manifestResponse.status}.`);
    }
    const manifest = (await manifestResponse.json()) as {
      challenge?: unknown;
      serviceUrl?: unknown;
      protocolEndpoint?: unknown;
    };
    if (manifest.challenge !== record.challenge) {
      throw new Error("The published challenge does not match this submission.");
    }
    if (
      typeof manifest.serviceUrl !== "string" ||
      canonicalOrigin(manifest.serviceUrl) !== record.canonicalUrl
    ) {
      throw new Error("The verification file must name the submitted canonical service URL.");
    }
    if (
      typeof manifest.protocolEndpoint !== "string" ||
      manifest.protocolEndpoint !== record.protocolEndpoint
    ) {
      throw new Error("The verification file must name the submitted protocol endpoint.");
    }

    let endpointReachable = false;
    try {
      const endpointResponse = await fetch(record.protocolEndpoint, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "Agentic-Payments-Index-Verifier/1.0" },
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      endpointReachable = endpointResponse.status < 500;
    } catch {
      endpointReachable = false;
    }

    const now = new Date().toISOString();
    const status = endpointReachable ? "verified" : "reachable";
    const verificationMessage = endpointReachable
      ? "Domain control and protocol endpoint reachability verified. Activation remains subject to data observation and review."
      : "Domain control verified, but the submitted protocol endpoint was not reachable."
    await db
      .update(serviceSubmissions)
      .set({
        status,
        verificationMessage,
        updatedAt: now,
        verifiedAt: endpointReachable ? now : null,
      })
      .where(eq(serviceSubmissions.id, record.id));
    const [updated] = await db
      .select()
      .from(serviceSubmissions)
      .where(eq(serviceSubmissions.id, record.id))
      .limit(1);
    return Response.json(publicSubmission(updated));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Verification failed." },
      { status: 422 },
    );
  }
}
