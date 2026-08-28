exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({
        success: false,
        error: "Method not allowed"
      })
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
          success: false,
          error: "Solana token address is required."
        })
      };
    }

    const apiKey = process.env.HELIUS_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: "Helius API key is not configured."
        })
      };
    }

    const rpc = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    async function rpcCall(method, params) {
      const response = await fetch(rpc, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "kyvora",
          method,
          params
        })
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        throw new Error(
          data.error?.message || "Helius request failed."
        );
      }

      return data.result;
    }

    // ----------------------------------------
    // TOKEN ASSET
    // ----------------------------------------

    const asset = await rpcCall("getAsset", {
      id: address,
      displayOptions: {
        showFungible: true
      }
    });

    if (!asset) {
      throw new Error("Token was not found.");
    }

    const tokenInfo = asset.token_info || {};
    const metadata = asset.content?.metadata || {};

    const name = metadata.name || "Unknown Token";
    const symbol = metadata.symbol || "UNKNOWN";

    const decimals = Number(tokenInfo.decimals ?? 0);

    /*
      Helius can expose supply in different fields.
      We keep the raw value separate and normalize it carefully.
    */

    let rawSupply = null;

    if (tokenInfo.supply !== undefined) {
      rawSupply = Number(tokenInfo.supply);
    } else if (tokenInfo.total_supply !== undefined) {
      rawSupply = Number(tokenInfo.total_supply);
    }

    let supply = null;

    if (
      rawSupply !== null &&
      Number.isFinite(rawSupply)
    ) {
      /*
        Helius fungible token supply is normally represented
        according to token decimals. Avoid converting twice.
      */
      supply =
        decimals > 0
          ? rawSupply / Math.pow(10, decimals)
          : rawSupply;
    }

    // ----------------------------------------
    // PRICE
    // ----------------------------------------

    const priceValue =
      tokenInfo.price_info?.price_per_token;

    const price =
      // ----------------------------------------
// MARKET CAP
// ----------------------------------------

let marketCap = null;

if (
  supply !== null &&
  price !== null &&
  Number.isFinite(supply) &&
  Number.isFinite(price)
) {
  marketCap = supply * price;
}
      priceValue !== undefined &&
      priceValue !== null &&
      Number.isFinite(Number(priceValue))
        ? Number(priceValue)
        : null;

    // ----------------------------------------
    // AUTHORITIES
    // ----------------------------------------

    const mintAuthority =
      tokenInfo.mint_authority ||
      asset.mint_authority ||
      null;

    const freezeAuthority =
      tokenInfo.freeze_authority ||
      asset.freeze_authority ||
      null;

    // ----------------------------------------
    // TOKEN PROGRAM
    // ----------------------------------------

    const tokenProgram =
      tokenInfo.token_program ||
      tokenInfo.program ||
      asset.interface ||
      "Unknown";

    // ----------------------------------------
    // HOLDERS
    // ----------------------------------------

    let holderCount = null;
    let topHolderPercent = null;
    let topHolderAmount = null;

    try {
      const holderResult = await rpcCall(
        "getTokenAccounts",
        {
          mint: address,
          page: 1,
          limit: 1000
        }
      );

      const accounts =
        holderResult?.token_accounts || [];

      const owners = new Map();

      for (const account of accounts) {
        const owner = account.owner;

        if (!owner) continue;

        const amount = Number(
          account.amount || 0
        );

        if (!Number.isFinite(amount)) continue;

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
        const rawTopAmount = balances[0];

        topHolderAmount =
          decimals > 0
            ? rawTopAmount /
              Math.pow(10, decimals)
            : rawTopAmount;

        topHolderPercent =
          (topHolderAmount / supply) * 100;

        if (
          !Number.isFinite(topHolderPercent)
        ) {
          topHolderPercent = null;
        }
      }
    } catch (holderError) {
      console.error(
        "Holder analysis failed:",
        holderError
      );
    }

    // ----------------------------------------
    // RISK ENGINE
    // ----------------------------------------

    let score = 10;

    const signals = [];

    if (mintAuthority) {
      score += 25;

      signals.push({
        level: "HIGH",
        title: "Mint authority detected",
        description:
          "The token may have an active authority capable of increasing supply."
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Mint authority not detected",
        description:
          "No active mint authority was returned."
      });
    }

    if (freezeAuthority) {
      score += 20;

      signals.push({
        level: "HIGH",
        title: "Freeze authority detected",
        description:
          "An active freeze authority may restrict token accounts."
      });
    } else {
      signals.push({
        level: "LOW",
        title: "No freeze authority detected",
        description:
          "No active freeze authority was returned."
      });
    }

    if (name !== "Unknown Token" && symbol !== "UNKNOWN") {
      signals.push({
        level: "LOW",
        title: "Token metadata available",
        description:
          "Token name and symbol were successfully retrieved."
      });
    } else {
      score += 10;

      signals.push({
        level: "MEDIUM",
        title: "Incomplete token metadata",
        description:
          "Token metadata is incomplete or unavailable."
      });
    }

    if (
      supply !== null &&
      Number.isFinite(supply)
    ) {
      signals.push({
        level: "LOW",
        title: "Supply information available",
        description:
          "Token supply was successfully retrieved."
      });
    } else {
      score += 10;

      signals.push({
        level: "MEDIUM",
        title: "Supply information unavailable",
        description:
          "A valid token supply could not be retrieved."
      });
    }

    if (price !== null) {
      signals.push({
        level: "LOW",
        title: "Market price available",
        description:
          `Indexed price: $${price}`
      });
    } else {
      score += 10;

      signals.push({
        level: "MEDIUM",
        title: "Market price unavailable",
        description:
          "No indexed market price was returned."
      });
    }

    if (holderCount !== null) {
      signals.push({
        level: "LOW",
        title: "Holder distribution analyzed",
        description:
          `${holderCount.toLocaleString()} unique holders detected in the analyzed snapshot.`
      });
    } else {
      score += 5;

      signals.push({
        level: "MEDIUM",
        title: "Holder distribution unavailable",
        description:
          "Holder distribution could not be analyzed."
      });
    }

    if (
      topHolderPercent !== null &&
      Number.isFinite(topHolderPercent)
    ) {
      if (topHolderPercent >= 50) {
        score += 30;

        signals.push({
          level: "CRITICAL",
          title: "Very high holder concentration",
          description:
            `Largest detected holder represents approximately ${topHolderPercent.toFixed(2)}% of reported supply.`
        });
      } else if (topHolderPercent >= 25) {
        score += 20;

        signals.push({
          level: "HIGH",
          title: "High holder concentration",
          description:
            `Largest detected holder represents approximately ${topHolderPercent.toFixed(2)}% of reported supply.`
        });
      } else if (topHolderPercent >= 10) {
        score += 10;

        signals.push({
          level: "MEDIUM",
          title: "Moderate holder concentration",
          description:
            `Largest detected holder represents approximately ${topHolderPercent.toFixed(2)}% of reported supply.`
        });
      } else {
        signals.push({
          level: "LOW",
          title: "Limited top-holder concentration",
          description:
            `Largest detected holder represents approximately ${topHolderPercent.toFixed(2)}% of reported supply.`
        });
      }
    }

    signals.push({
      level: "LOW",
      title: "Token program identified",
      description:
        `Token program: ${tokenProgram}`
    });

    score = Math.max(
      0,
      Math.min(100, score)
    );

    let level = "LOW";

    if (score >= 75) {
      level = "CRITICAL";
    } else if (score >= 50) {
      level = "HIGH";
    } else if (score >= 30) {
      level = "MEDIUM";
    }

    return {
      statusCode: 200,
      headers,

      body: JSON.stringify({
        success: true,

        scanner: {
          name: "KYVORA",
          version: "4.0"
        },

        token: {
          address,
          name,
          symbol,
          decimals,
          supply,
          price,
          tokenProgram
        },

        holders: {
          holderCount,
          topHolderPercent,
          topHolderAmount,
          analyzedAccounts: 1000
        },

        risk: {
          score,
          level,
          signals
        },

        disclaimer:
          "KYVORA provides risk indicators for research purposes and does not guarantee that a token is safe or malicious.",

        source: "Helius"
      })
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
        success: false,
        error:
          error.message ||
          "Unable to analyze token."
      })
    };
  }
};
