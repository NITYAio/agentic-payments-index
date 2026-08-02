export type SubmissionStatus =
  | "submitted"
  | "reachable"
  | "verified"
  | "active"
  | "inactive";

export function publicHttpsUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Use a public HTTPS URL.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new Error("Use a public internet hostname.");
  }
  return url;
}

export function canonicalOrigin(value: string) {
  const url = publicHttpsUrl(value);
  return url.origin;
}

export function verificationUrl(canonicalUrl: string) {
  return new URL(
    "/.well-known/agentic-payments-index.json",
    canonicalUrl,
  ).toString();
}

export function publicSubmission(record: {
  id: string;
  serviceName: string;
  canonicalUrl: string;
  protocol: string;
  network: string;
  protocolEndpoint: string;
  challenge: string;
  status: string;
  verificationMessage: string | null;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
}) {
  return {
    id: record.id,
    serviceName: record.serviceName,
    canonicalUrl: record.canonicalUrl,
    protocol: record.protocol,
    network: record.network,
    protocolEndpoint: record.protocolEndpoint,
    status: record.status,
    verificationMessage: record.verificationMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    verifiedAt: record.verifiedAt,
    verification: {
      url: verificationUrl(record.canonicalUrl),
      body: {
        serviceUrl: record.canonicalUrl,
        challenge: record.challenge,
        protocol: record.protocol,
        protocolEndpoint: record.protocolEndpoint,
      },
      note: "Verification proves control of the submitted domain and endpoint reachability; it does not by itself verify a legal entity.",
    },
  };
}
