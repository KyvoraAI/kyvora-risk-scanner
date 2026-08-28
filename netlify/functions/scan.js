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

    const rpc =
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

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
          data.error?.message ||
          "Helius request failed."
        );
      }

      return data.result;
    }

    // ========================================
    // TOKEN ASSET
    // ========================================

    const asset = await rpcCall("getAsset", {
      id: address,
      displayOptions: {
        showFungible: true
      }
    });

    if (!asset) {
      throw new Error("Token was not found.");
    }

    const tokenInfo =
      asset.token_info || {};

    const metadata =
      asset.content?.metadata || {};

    const name =
      metadata.name || "Unknown Token";

    const symbol =
      metadata.symbol || "UNKNOWN";

    const decimals =
      Number(tokenInfo.decimals ?? 0);

    // ========================================
    // SUPPLY
    // IMPORTANT:
    // Helius getAsset supply is already normalized.
    // Do NOT divide it by decimals again.
    // ========================================

    let supply = null;

    if (
      tokenInfo.supply !== undefined &&
      tokenInfo.supply !== null
    ) {
      const value =
        Number(tokenInfo.supply);

      if (Number.isFinite(value)) {
        supply = value;
      }
    }

    // ========================================
    // PRICE
    // ========================================

    const priceValue =
      tokenInfo.price_info?.price_per_token;

    const price =
      priceValue !== undefined &&
      priceValue !== null &&
      Number.isFinite(Number(priceValue))
        ? Number(priceValue)
        : null;

    // ========================================
    // MARKET CAP
    // ========================================

    let marketCap = null;

    if (
      supply !== null &&
      price !== null &&
      Number.isFinite(supply) &&
      Number.isFinite(price)
    ) {
      marketCap =
        supply * price;
    }

    // ========================================
    // AUTHORITIES
    // ========================================

    const mintAuthority =
      tokenInfo.mint_authority ||
      asset.mint_authority ||
      null;

    const freezeAuthority =
      tokenInfo.freeze_authority ||
      asset.freeze_authority ||
      null;

    // ========================================
    // TOKEN PROGRAM
    // ========================================

    const tokenProgram =
      tokenInfo.token_program ||
      tokenInfo.program ||
      asset.interface ||
      "Unknown";

    // ========================================
    // HOLDER ANALYSIS
    // Fetch all pages, not only first 1000
    // ========================================

    let holderCount = null;
    let topHolderPercent = null;
    let topHolderAmount = null;
    let analyzedAccounts = 0;
    let pagesAnalyzed = 0;

    try {
      const owners = new Map();

      let page = 1;

      const MAX_PAGES = 100;

      while (page <= MAX_PAGES) {
        const holderResult =
          await rpcCall(
            "getTokenAccounts",
            {
              mint: address,
              page,
              limit: 1000
            }
          );

        const accounts =
          holderResult?.token_accounts || [];

        if (!accounts.length) {
          break;
        }

        analyzedAccounts +=
          accounts.length;

        for (const account of accounts) {
          const owner =
            account.owner;

          if (!owner) {
            continue;
          }

          const rawAmount =
            Number(account.amount || 0);

          if (
            !Number.isFinite(rawAmount) ||
            rawAmount <= 0
          ) {
            continue;
          }

          // getTokenAccounts amount is raw.
          // Convert using token decimals.
          const amount =
            decimals > 0
              ? rawAmount /
                Math.pow(10, decimals)
              : rawAmount;

          if (
            !Number.isFinite(amount) ||
            amount <= 0
          ) {
            continue;
          }

          owners.set(
            owner,
            (owners.get(owner) || 0) +
              amount
          );
        }

        pagesAnalyzed = page;

        if (accounts.length < 1000) {
          break;
        }

        page++;
      }

      holderCount =
        owners.size;

      const balances =
        Array.from(
          owners.values()
        )
          .filter(
            value =>
              Number.isFinite(value) &&
              value > 0
          )
          .sort(
            (a, b) => b - a
          );

      if (
        balances.length > 0 &&
        supply !== null &&
        supply > 0
      ) {
        topHolderAmount =
          balances[0];

        topHolderPercent =
          (topHolderAmount / supply) *
          100;

        if (
          !Number.isFinite(
            topHolderPercent
          )
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

    // ========================================
    // RISK ENGINE
    // ========================================

    let score = 0;

    const signals = [];

    // ----------------------------------------
    // METADATA
    // ----------------------------------------

    if (
      name !== "Unknown Token" &&
      symbol !== "UNKNOWN"
    ) {
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

    // ----------------------------------------
    // SUPPLY
    // ----------------------------------------

    if (
      supply !== null &&
      Number.isFinite(supply) &&
      supply > 0
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

    // ----------------------------------------
    // PRICE
    // ----------------------------------------

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

    // ----------------------------------------
    // MARKET CAP
    // ----------------------------------------

    if (marketCap !== null) {
      signals.push({
        level: "LOW",
        title: "Market cap calculated",
        description:
          `Estimated market cap: $${marketCap.toLocaleString(
            "en-US",
            {
              maximumFractionDigits: 2
            }
          )}`
      });
    } else {
      signals.push({
        level: "MEDIUM",
        title: "Market cap unavailable",
        description:
          "Market cap could not be calculated because supply or price was unavailable."
      });
    }

    // ----------------------------------------
    // MINT AUTHORITY
    // ----------------------------------------

    if (mintAuthority) {
      score += 20;

      signals.push({
        level: "HIGH",
        title: "Mint authority detected",
        description:
          "An active mint authority was detected. It may allow additional tokens to be minted."
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Mint authority disabled",
        description:
          "No active mint authority was detected."
      });
    }

    // ----------------------------------------
    // FREEZE AUTHORITY
    // ----------------------------------------

    if (freezeAuthority) {
      score += 15;

      signals.push({
        level: "HIGH",
        title: "Freeze authority detected",
        description:
          "An active freeze authority was detected and may restrict token accounts."
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Freeze authority disabled",
        description:
          "No active freeze authority was detected."
      });
    }

    // ----------------------------------------
    // HOLDER COUNT
    // ----------------------------------------

    if (holderCount !== null) {
      signals.push({
        level: "LOW",
        title: "Holder distribution analyzed",
        description:
          `${holderCount.toLocaleString()} unique holders detected across the analyzed token-account pages.`
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

    // ----------------------------------------
    // TOP HOLDER CONCENTRATION
    // ----------------------------------------

    if (
      topHolderPercent !== null &&
      Number.isFinite(
        topHolderPercent
      )
    ) {
      if (
        topHolderPercent >= 50
      ) {
        score += 30;

        signals.push({
          level: "CRITICAL",
          title:
            "Very high holder concentration",
          description:
            `Largest detected holder represents approximately ${topHolderPercent.toFixed(2)}% of reported supply.`
        });

      } else if (
        topHolderPercent >= 25
      ) {
        score += 20;

        signals.push({
          level: "HIGH",
          title:
            "High holder concentration",
          description:
            `Largest detected holder represents approximately ${topHolderPercent.toFixed(2)}% of reported supply.`
        });

      } else if (
        topHolderPercent >= 10
      ) {
        score += 10;

        signals.push({
          level: "MEDIUM",
          title:
            "Moderate holder concentration",
          description:
            `Largest detected holder represents approximately ${topHolderPercent.toFixed(2)}% of reported supply.`
        });

      } else {
        signals.push({
          level: "LOW",
          title:
            "Limited top holder concentration",
          description:
            `Largest detected holder represents approximately ${topHolderPercent.toFixed(2)}% of reported supply.`
        });
      }

    } else {
      signals.push({
        level: "MEDIUM",
        title:
          "Top holder concentration unavailable",
        description:
          "Top holder concentration could not be calculated."
      });
    }

    // ----------------------------------------
    // TOKEN PROGRAM
    // ----------------------------------------

    signals.push({
      level: "LOW",
      title: "Token program identified",
      description:
        `Token program: ${tokenProgram}`
    });

    // ========================================
    // FINAL SCORE
    // ========================================

    score =
      Math.max(
        0,
        Math.min(
          100,
          Math.round(score)
        )
      );

    let level = "LOW";

    if (score >= 75) {
      level = "CRITICAL";
    } else if (score >= 50) {
      level = "HIGH";
    } else if (score >= 30) {
      level = "MEDIUM";
    }

    // ========================================
    // RESPONSE
    // ========================================

    return {
      statusCode: 200,
      headers,

      body: JSON.stringify({
        success: true,

        scanner: {
          name: "KYVORA",
          version: "5.1"
        },

        token: {
          address,
          name,
          symbol,
          decimals,
          supply,
          price,
          marketCap,
          tokenProgram
        },

        authorities: {
          mintAuthority:
            Boolean(mintAuthority),

          freezeAuthority:
            Boolean(freezeAuthority)
        },

        holders: {
          holderCount,
          topHolderPercent,
          topHolderAmount,
          analyzedAccounts,
          pagesAnalyzed
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
