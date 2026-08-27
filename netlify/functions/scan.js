exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const address = String(body.address || "").trim();

    if (!address) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Token address is required" }),
      };
    }

    const apiKey = process.env.HELIUS_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "HELIUS_API_KEY is not configured" }),
      };
    }

    const response = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "kyvora",
          method: "getAsset",
          params: {
            id: address,
            displayOptions: {
              showFungible: true,
            },
          },
        }),
      }
    );

    const json = await response.json();

    if (!response.ok || json.error || !json.result) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Token not found or invalid Solana token address",
        }),
      };
    }

    const asset = json.result;
    const tokenInfo = asset.token_info || {};
    const metadata = asset.content?.metadata || {};

    const name = metadata.name || "Unknown Token";
    const symbol = metadata.symbol || "UNKNOWN";

    const decimals = Number(tokenInfo.decimals ?? 0);

    // Helius may return supply in different locations/formats.
    let rawSupply = tokenInfo.supply;

    if (rawSupply === undefined || rawSupply === null) {
      rawSupply = tokenInfo.total_supply;
    }

    let supply = null;

    if (rawSupply !== undefined && rawSupply !== null) {
      const numericSupply = Number(rawSupply);

      if (Number.isFinite(numericSupply)) {
        supply =
          decimals > 0
            ? numericSupply / Math.pow(10, decimals)
            : numericSupply;
      }
    }

    const price =
      tokenInfo.price_info?.price_per_token != null
        ? Number(tokenInfo.price_info.price_per_token)
        : null;

    let riskScore = 10;
    const signals = [];

    const mintAuthority =
      tokenInfo.mint_authority ||
      asset.mint_authority ||
      null;

    if (mintAuthority) {
      riskScore += 25;

      signals.push({
        level: "HIGH",
        title: "Mint authority detected",
        description:
          "Additional token supply may potentially be created.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Mint authority not detected",
        description:
          "No active mint authority was returned.",
      });
    }

    const freezeAuthority =
      tokenInfo.freeze_authority ||
      asset.freeze_authority ||
      null;

    if (freezeAuthority) {
      riskScore += 20;

      signals.push({
        level: "HIGH",
        title: "Freeze authority detected",
        description:
          "A freeze authority may be able to restrict token accounts.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "No freeze authority detected",
        description:
          "No active freeze authority was returned.",
      });
    }

    if (!name || !symbol) {
      riskScore += 10;

      signals.push({
        level: "MEDIUM",
        title: "Incomplete token metadata",
        description:
          "Token name or symbol information is incomplete.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Token metadata available",
        description:
          "Token name and symbol were successfully returned.",
      });
    }

    if (supply === null) {
      riskScore += 10;

      signals.push({
        level: "MEDIUM",
        title: "Supply information unavailable",
        description:
          "A valid token supply was not returned by the data provider.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Supply information available",
        description:
          "Token supply and decimals were successfully retrieved.",
      });
    }

    if (price === null || !Number.isFinite(price)) {
      riskScore += 10;

      signals.push({
        level: "MEDIUM",
        title: "Market price unavailable",
        description:
          "No current indexed token price was returned.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Market price available",
        description: `Indexed price: $${price}`,
      });
    }

    const tokenProgram =
      tokenInfo.token_program ||
      tokenInfo.program ||
      asset.interface ||
      null;

    if (tokenProgram) {
      signals.push({
        level: "LOW",
        title: "Token program identified",
        description:
          "The token program was successfully identified.",
      });
    }

    riskScore = Math.max(0, Math.min(100, riskScore));

    let riskLevel = "LOW";

    if (riskScore >= 75) {
      riskLevel = "CRITICAL";
    } else if (riskScore >= 50) {
      riskLevel = "HIGH";
    } else if (riskScore >= 30) {
      riskLevel = "MEDIUM";
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,

        scanner: {
          name: "KYVORA",
          version: "2.1",
        },

        token: {
          address,
          name,
          symbol,
          decimals,
          supply,
          price,
          tokenProgram,
        },

        risk: {
          score: riskScore,
          level: riskLevel,
          signals,
        },

        disclaimer:
          "KYVORA provides risk indicators for research purposes. It does not guarantee that a token is safe or malicious.",

        source: "Helius",
      }),
    };
  } catch (error) {
    console.error("KYVORA scanner error:", error);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Unable to analyze token",
      }),
    };
  }
};
