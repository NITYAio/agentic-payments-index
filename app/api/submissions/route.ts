import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { serviceSubmissions } from "../../../db/schema";
import {
  canonicalOrigin,
  publicHttpsUrl,
  publicSubmission,
} from "../../../lib/service-verification";

type SubmissionInput = {
  serviceName?: unknown;
  canonicalUrl?: unknown;
  protocol?: unknown;
  network?: unknown;
  protocolEndpoint?: unknown;
  contactEmail?: unknown;
};

function cleanText(value: unknown, field: string, maximum = 160) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  const clean = value.trim();
  if (clean.length > maximum) throw new Error(`${field} is too long.`);
  return clean;
}

function cleanEmail(value: unknown) {
  const email = cleanText(value, "Contact email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid contact email.");
  }
  return email;
}

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) {
      return Response.json(
        {
          endpoint: "/api/submissions",
          method: "POST",
          verification: "Publish the issued challenge at /.well-known/agentic-payments-index.json, then POST the submission id to /api/submissions/verify.",
        },
      );
    }
    const db = await getDb();
    const [record] = await db
      .select()
      .from(serviceSubmissions)
      .where(eq(serviceSubmissions.id, id))
      .limit(1);
    if (!record) return Response.json({ error: "Submission not found." }, { status: 404 });
    return Response.json(publicSubmission(record));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Submission lookup failed." },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SubmissionInput;
    const serviceName = cleanText(body.serviceName, "Service name", 100);
    const canonicalUrl = canonicalOrigin(cleanText(body.canonicalUrl, "Canonical URL", 500));
    const protocolEndpoint = publicHttpsUrl(
      cleanText(body.protocolEndpoint, "Protocol endpoint", 500),
    ).toString();
    const protocol =
      body.protocol === "mpp" || body.protocol === "x402" || body.protocol === "both"
        ? body.protocol
        : null;
    if (!protocol) throw new Error("Protocol must be MPP, x402, or both.");
    const network = cleanText(body.network, "Network", 80);
    const contactEmail = cleanEmail(body.contactEmail);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const challenge = `api_${crypto.randomUUID().replaceAll("-", "")}`;
    const db = await getDb();
    const [existing] = await db
      .select()
      .from(serviceSubmissions)
      .where(eq(serviceSubmissions.canonicalUrl, canonicalUrl))
      .limit(1);

    if (existing?.status === "verified" || existing?.status === "active") {
      return Response.json(
        { error: "This domain is already verified. Contact the maintainers to update its record." },
        { status: 409 },
      );
    }

    if (existing) {
      await db
        .update(serviceSubmissions)
        .set({
          serviceName,
          protocol,
          network,
          protocolEndpoint,
          contactEmail,
          challenge,
          status: "submitted",
          verificationMessage: null,
          updatedAt: now,
          verifiedAt: null,
        })
        .where(eq(serviceSubmissions.id, existing.id));
      const [updated] = await db
        .select()
        .from(serviceSubmissions)
        .where(eq(serviceSubmissions.id, existing.id))
        .limit(1);
      return Response.json(publicSubmission(updated), { status: 200 });
    }

    await db.insert(serviceSubmissions).values({
      id,
      serviceName,
      canonicalUrl,
      protocol,
      network,
      protocolEndpoint,
      contactEmail,
      challenge,
      status: "submitted",
      verificationMessage: null,
      createdAt: now,
      updatedAt: now,
      verifiedAt: null,
    });
    const [created] = await db
      .select()
      .from(serviceSubmissions)
      .where(eq(serviceSubmissions.id, id))
      .limit(1);
    return Response.json(publicSubmission(created), { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Submission failed." },
      { status: 400 },
    );
  }
}
