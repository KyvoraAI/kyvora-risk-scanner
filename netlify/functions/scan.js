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
        body: JSON.stringify({ error: "Solana token address is required" }),
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

    // Get token information from Helius DAS API
    const assetResponse = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "kyvora",
          method: "getAsset",
          params: {
            id: address,
          },
        }),
      }
    );

    const assetJson = await assetResponse.json();

    if (assetJson.error || !assetJson.result) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Token not found or invalid Solana token address",
        }),
      };
    }

    const asset = assetJson.result;
    const tokenInfo = asset.token_info || {};
    const authorities = asset.authorities || [];

    const decimals = Number(tokenInfo.decimals || 0);
    const rawSupply = Number(tokenInfo.supply || 0);
    const supply =
      decimals > 0 ? rawSupply / Math.pow(10, decimals) : rawSupply;

    const mintAuthority = authorities.find(
      (a) => a.address && a.address === address
    );

    const freezeAuthority = tokenInfo.freeze_authority || null;

    const signals = [];
    let riskScore = 20;

    // Mint authority
    if (mintAuthority) {
      riskScore += 20;
      signals.push({
        level: "HIGH",
        title: "Mint authority detected",
        description:
          "The token may have an active authority capable of changing token supply.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Mint authority not detected",
        description:
          "No matching mint authority was detected in the returned token data.",
      });
    }

    // Freeze authority
    if (freezeAuthority) {
      riskScore += 20;
      signals.push({
        level: "HIGH",
        title: "Freeze authority detected",
        description:
          "The token has a freeze authority recorded in its token information.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "No freeze authority detected",
        description:
          "No freeze authority was returned by the token data.",
      });
    }

    // Metadata
    const name = asset.content?.metadata?.name || "Unknown Token";
    const symbol = asset.content?.metadata?.symbol || "UNKNOWN";

    if (!asset.content?.metadata?.name || !asset.content?.metadata?.symbol) {
      riskScore += 10;
      signals.push({
        level: "MEDIUM",
        title: "Incomplete metadata",
        description: "Token name or symbol information is missing.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Metadata available",
        description: "Token name and symbol were returned successfully.",
      });
    }

    // Supply sanity check
    if (!supply || supply <= 0) {
      riskScore += 10;
      signals.push({
        level: "MEDIUM",
        title: "Supply information unavailable",
        description: "A valid token supply was not returned.",
      });
    }

    riskScore = Math.min(100, Math.max(0, riskScore));

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
        scanner: "KYVORA",
        token: {
          address,
          name,
          symbol,
          decimals,
          supply,
        },
        risk: {
          score: riskScore,
          level: riskLevel,
          signals,
        },
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
