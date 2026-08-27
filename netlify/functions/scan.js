exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({
        error: "Method not allowed",
      }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const address = String(body.address || "").trim();

    if (!address) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Solana token address is required",
        }),
      };
    }

    const apiKey = process.env.HELIUS_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: "HELIUS_API_KEY is not configured",
        }),
      };
    }

    const response = await fetch(
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

    const decimals = Number(tokenInfo.decimals || 0);
    const rawSupply = Number(tokenInfo.supply || 0);

    const supply =
      decimals > 0
        ? rawSupply / Math.pow(10, decimals)
        : rawSupply;

    const price =
      tokenInfo.price_info?.price_per_token != null
        ? Number(tokenInfo.price_info.price_per_token)
        : null;

    /*
      KYVORA ADVANCED RISK ENGINE

      Starting score:
      0 = lower risk
      100 = higher risk

      Important:
      This is a risk-indicator score, not a guarantee
      that a token is safe or malicious.
    */

    let riskScore = 10;
    const signals = [];

    // --------------------------------------------------
    // 1. Mint authority
    // --------------------------------------------------

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
          "An active mint authority is associated with this token. Additional supply may potentially be created.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Mint authority not detected",
        description:
          "No active mint authority was returned by the available token data.",
      });
    }

    // --------------------------------------------------
    // 2. Freeze authority
    // --------------------------------------------------

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
          "A freeze authority is associated with this token and may be able to restrict token accounts.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "No freeze authority detected",
        description:
          "No active freeze authority was returned by the available token data.",
      });
    }

    // --------------------------------------------------
    // 3. Metadata quality
    // --------------------------------------------------

    const hasName =
      typeof metadata.name === "string" &&
      metadata.name.trim().length > 0;

    const hasSymbol =
      typeof metadata.symbol === "string" &&
      metadata.symbol.trim().length > 0;

    if (!hasName || !hasSymbol) {
      riskScore += 10;

      signals.push({
        level: "MEDIUM",
        title: "Incomplete token metadata",
        description:
          "The token is missing a name or symbol in the returned metadata.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Token metadata available",
        description:
          "Token name and symbol were successfully returned.",
      });
    }

    // --------------------------------------------------
    // 4. Supply
    // --------------------------------------------------

    if (!Number.isFinite(supply) || supply <= 0) {
      riskScore += 10;

      signals.push({
        level: "MEDIUM",
        title: "Supply information unavailable",
        description:
          "A valid circulating token supply was not returned.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Supply information available",
        description:
          "The token supply and decimals were returned successfully.",
      });
    }

    // --------------------------------------------------
    // 5. Price availability
    // --------------------------------------------------

    if (price === null || !Number.isFinite(price)) {
      riskScore += 10;

      signals.push({
        level: "MEDIUM",
        title: "Market price unavailable",
        description:
          "Helius did not return a current token price for this asset.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Market price available",
        description:
          `Current indexed price: $${price}`,
      });
    }

    // --------------------------------------------------
    // 6. Token program
    // --------------------------------------------------

    const tokenProgram =
      tokenInfo.token_program ||
      tokenInfo.program ||
      null;

    if (tokenProgram) {
      signals.push({
        level: "LOW",
        title: "Token program identified",
        description:
          "The token program information was returned successfully.",
      });
    }

    // --------------------------------------------------
    // Final score
    // --------------------------------------------------

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
          version: "2.0",
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
          "KYVORA provides risk indicators for research purposes and does not guarantee that a token is safe or malicious.",

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
