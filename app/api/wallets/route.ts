const registry = [
  {
    provider: "Coinbase Developer Platform",
    accountTypes: ["embedded wallet", "smart account"],
    attributionStatus: "registry-ready",
    evidence: "Provider-published account and transaction signatures",
  },
  {
    provider: "Tempo Wallet",
    accountTypes: ["passkey wallet", "smart account"],
    attributionStatus: "registry-ready",
    evidence: "Tempo-native account metadata and published signatures",
  },
  {
    provider: "MetaMask",
    accountTypes: ["EOA", "smart account", "agent wallet"],
    attributionStatus: "registry-ready",
    evidence: "Verified factory or account implementation signatures",
  },
  {
    provider: "Privy",
    accountTypes: ["embedded wallet", "server wallet"],
    attributionStatus: "registry-ready",
    evidence: "Verified deployment and provider attestation rules",
  },
  {
    provider: "Crossmint",
    accountTypes: ["embedded wallet", "server wallet"],
    attributionStatus: "registry-ready",
    evidence: "Verified deployment and provider attestation rules",
  },
  {
    provider: "Safe / Turnkey / Circle / Fireblocks",
    accountTypes: ["smart account", "policy wallet", "custodial wallet"],
    attributionStatus: "candidate",
    evidence: "Requires provider-specific deterministic or declared rules",
  },
];

export async function GET() {
  return Response.json(
    {
      schemaVersion: "0.1.0",
      coverage: {
        observedPayments: null,
        attributablePayments: null,
        shareOfAll: null,
        shareOfAttributable: null,
        state: "Identity-level transaction ingestion required",
      },
      dimensions: ["account type", "wallet provider", "facilitator or submission provider"],
      confidence: ["verified", "deterministic", "declared", "inferred", "unknown"],
      registry,
      disclosure:
        "The registry defines evidence rules; it does not claim attribution coverage until independently indexed payment identities can be evaluated against them.",
      contributions:
        "Provider additions and corrections are accepted in the open-source repository with reproducible evidence.",
    },
    {
      headers: { "Cache-Control": "public, max-age=300, s-maxage=3600" },
    },
  );
}
