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
        body: JSON.stringify({
          error: "Token address is required",
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

    const heliusUrl =
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    // -----------------------------------------
    // 1. TOKEN INFORMATION
    // -----------------------------------------

    const assetResponse = await fetch(heliusUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "kyvora-asset",
        method: "getAsset",
        params: {
          id: address,
          displayOptions: {
            showFungible: true,
          },
        },
      }),
    });

    const assetJson = await assetResponse.json();

    if (
      !assetResponse.ok ||
      assetJson.error ||
      !assetJson.result
    ) {
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
    const metadata = asset.content?.metadata || {};

    const name = metadata.name || "Unknown Token";
    const symbol = metadata.symbol || "UNKNOWN";

    const decimals = Number(tokenInfo.decimals ?? 0);

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

    // -----------------------------------------
    // 2. AUTHORITIES
    // -----------------------------------------

    const mintAuthority =
      tokenInfo.mint_authority ||
      asset.mint_authority ||
      null;

    const freezeAuthority =
      tokenInfo.freeze_authority ||
      asset.freeze_authority ||
      null;

    // -----------------------------------------
    // 3. HOLDER DATA
    // -----------------------------------------

    let holderCount = null;
    let topHolderPercent = null;
    let topHolderAmount = null;

    try {
      const holderResponse = await fetch(heliusUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "kyvora-holders",
          method: "getTokenAccounts",
          params: {
            mint: address,
            page: 1,
            limit: 1000,
            displayOptions: {},
          },
        }),
      });

      const holderJson = await holderResponse.json();

      const accounts =
        holderJson.result?.token_accounts || [];

      if (accounts.length > 0) {
        const owners = new Map();

        for (const account of accounts) {
          const owner = account.owner;
          const amount = Number(account.amount || 0);

          if (!owner) continue;

          owners.set(
            owner,
            (owners.get(owner) || 0) + amount
          );
        }

        holderCount = owners.size;

        const balances = Array.from(
          owners.values()
        ).sort((a, b) => b - a);

        if (
          balances.length > 0 &&
          supply !== null &&
          supply > 0
        ) {
          const divisor = Math.pow(10, decimals);

          const largestRawAmount = balances[0];

          topHolderAmount =
            decimals > 0
              ? largestRawAmount / divisor
              : largestRawAmount;

          topHolderPercent =
            (topHolderAmount / supply) * 100;

          if (!Number.isFinite(topHolderPercent)) {
            topHolderPercent = null;
          }
        }
      }
    } catch (holderError) {
      console.error(
        "Holder analysis error:",
        holderError
      );
    }

    // -----------------------------------------
    // 4. KYVORA RISK ENGINE
    // -----------------------------------------

    let riskScore = 10;

    const signals = [];

    // Mint authority
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

    // Freeze authority
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

    // Metadata
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

    // Supply
    if (supply === null) {
      riskScore += 10;

      signals.push({
        level: "MEDIUM",
        title: "Supply information unavailable",
        description:
          "A valid token supply was not returned.",
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Supply information available",
        description:
          "Token supply and decimals were successfully retrieved.",
      });
    }

    // Price
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
        description:
          `Indexed price: $${price}`,
      });
    }

    // Holder analysis
    if (holderCount !== null) {
      signals.push({
        level: "LOW",
        title: "Holder distribution analyzed",
        description:
          `${holderCount.toLocaleString()} unique holders detected in the analyzed token-account snapshot.`,
      });
    } else {
      signals.push({
        level: "MEDIUM",
        title: "Holder distribution unavailable",
        description:
          "Holder data could not be retrieved for this scan.",
      });
    }

    // Top holder concentration
    if (
      topHolderPercent !== null &&
      Number.isFinite(topHolderPercent)
    ) {
      if (topHolderPercent >= 50) {
        riskScore += 30;

        signals.push({
          level: "CRITICAL",
          title: "Very high top-holder concentration",
          description:
            `The largest detected holder represents approximately ${topHolderPercent.toFixed(2)}% of reported supply.`,
        });
      } else if (topHolderPercent >= 25) {
        riskScore += 20;

        signals.push({
          level: "HIGH",
          title: "High top-holder concentration",
          description:
            `The largest detected holder represents approximately ${topHolderPercent.toFixed(2)}% of reported supply.`,
        });
      } else if (topHolderPercent >= 10) {
        riskScore += 10;

        signals.push({
          level: "MEDIUM",
          title: "Moderate top-holder concentration",
          description:
            `The largest detected holder represents approximately ${topHolderPercent.toFixed(2)}% of reported supply.`,
        });
      } else {
        signals.push({
          level: "LOW",
          title: "Top-holder concentration appears limited",
          description:
            `The largest detected holder represents approximately ${topHolderPercent.toFixed(2)}% of reported supply.`,
        });
      }
    }

    // Token program
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

    // -----------------------------------------
    // FINAL SCORE
    // -----------------------------------------

    riskScore = Math.max(
      0,
      Math.min(100, riskScore)
    );

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
          version: "3.0",
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

        holders: {
          holderCount,
          topHolderPercent,
          topHolderAmount,
          analyzedAccounts: 1000,
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
    console.error(
      "KYVORA scanner error:",
      error
    );

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Unable to analyze token",
      }),
    };
  }
};
