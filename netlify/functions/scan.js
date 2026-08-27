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
      return response(400, {
        success: false,
        error: "Solana token address is required."
      });
    }

    const apiKey = process.env.HELIUS_API_KEY;

    if (!apiKey) {
      return response(500, {
        success: false,
        error: "HELIUS_API_KEY is missing in Netlify environment variables."
      });
    }

    const rpcUrl =
      "https://mainnet.helius-rpc.com/?api-key=" +
      encodeURIComponent(apiKey);

    async function rpc(method, params) {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params
        })
      });

      const json = await res.json();

      if (!res.ok) {
        throw new Error(
          "Helius HTTP " + res.status
        );
      }

      if (json.error) {
        throw new Error(
          json.error.message || "Helius RPC error"
        );
      }

      return json.result;
    }

    // =====================================================
    // TOKEN DATA
    // =====================================================

    let asset = null;
    let tokenInfo = {};
    let metadata = {};

    try {
      asset = await rpc("getAsset", {
        id: address,
        displayOptions: {
          showFungible: true
        }
      });

      tokenInfo = asset?.token_info || {};
      metadata = asset?.content?.metadata || {};
    } catch (e) {
      throw new Error(
        "Unable to read token data from Helius: " +
        e.message
      );
    }

    if (!asset) {
      throw new Error("Token not found.");
    }

    const name =
      metadata.name ||
      asset?.content?.metadata?.name ||
      "Unknown Token";

    const symbol =
      metadata.symbol ||
      asset?.content?.metadata?.symbol ||
      "UNKNOWN";

    const decimalsFromAsset =
      Number.isFinite(Number(tokenInfo.decimals))
        ? Number(tokenInfo.decimals)
        : null;

    // =====================================================
    // TOKEN SUPPLY
    // =====================================================

    let supply = null;
    let rawSupply = null;
    let supplyDecimals = decimalsFromAsset;

    try {
      const supplyResult =
        await rpc("getTokenSupply", [address]);

      const value =
        supplyResult?.value || {};

      rawSupply =
        value.amount != null
          ? String(value.amount)
          : null;

      if (value.decimals != null) {
        supplyDecimals =
          Number(value.decimals);
      }

      /*
       * uiAmountString is the safest display value
       * supplied by Solana RPC.
       */
      if (
        value.uiAmountString != null &&
        value.uiAmountString !== ""
      ) {
        supply =
          Number(value.uiAmountString);
      } else if (
        rawSupply !== null &&
        supplyDecimals !== null
      ) {
        supply =
          rawToNumber(
            rawSupply,
            supplyDecimals
          );
      }
    } catch (e) {
      /*
       * Do not kill the scanner if this endpoint fails.
       * Try supply information from getAsset.
       */
      if (
        tokenInfo.supply != null &&
        tokenInfo.supply !== ""
      ) {
        supply =
          Number(tokenInfo.supply);
      }
    }

    // Final fallback from asset token_info.
    if (
      supply === null &&
      tokenInfo.supply != null
    ) {
      const assetSupply =
        Number(tokenInfo.supply);

      if (Number.isFinite(assetSupply)) {
        supply = assetSupply;
      }
    }

    // =====================================================
    // PRICE
    // =====================================================

    let price = null;

    const assetPrice =
      tokenInfo?.price_info?.price_per_token;

    if (
      assetPrice != null &&
      Number.isFinite(Number(assetPrice))
    ) {
      price = Number(assetPrice);
    }

    // =====================================================
    // AUTHORITIES
    // =====================================================

    const mintAuthority =
      tokenInfo.mint_authority ||
      asset.mint_authority ||
      null;

    const freezeAuthority =
      tokenInfo.freeze_authority ||
      asset.freeze_authority ||
      null;

    // =====================================================
    // TOKEN PROGRAM
    // =====================================================

    const tokenProgram =
      tokenInfo.token_program ||
      tokenInfo.program ||
      asset.owner ||
      "Unknown";

    // =====================================================
    // HOLDER ANALYSIS
    // =====================================================

    const owners = new Map();

    let page = 1;
    let analyzedAccounts = 0;

    const MAX_PAGES = 100;
    const PAGE_SIZE = 1000;

    let holderScanError = null;

    while (page <= MAX_PAGES) {
      try {
        const holderResult =
          await rpc("getTokenAccounts", {
            mint: address,
            page: page,
            limit: PAGE_SIZE
          });

        const accounts =
          holderResult?.token_accounts || [];

        if (!Array.isArray(accounts) ||
            accounts.length === 0) {
          break;
        }

        for (const account of accounts) {
          const owner =
            account?.owner;

          if (!owner) {
            continue;
          }

          let rawAmount = 0n;

          try {
            rawAmount =
              BigInt(
                String(
                  account.amount ?? "0"
                )
              );
          } catch {
            rawAmount = 0n;
          }

          if (rawAmount <= 0n) {
            continue;
          }

          analyzedAccounts++;

          const oldAmount =
            owners.get(owner) || 0n;

          owners.set(
            owner,
            oldAmount + rawAmount
          );
        }

        if (accounts.length < PAGE_SIZE) {
          break;
        }

        page++;
      } catch (e) {
        holderScanError = e.message;
        break;
      }
    }

    const holderCount =
      owners.size;

    // =====================================================
    // TOP HOLDER
    // =====================================================

    let topHolderRaw = 0n;
    let topHolderOwner = null;

    for (const [owner, amount] of owners.entries()) {
      if (amount > topHolderRaw) {
        topHolderRaw = amount;
        topHolderOwner = owner;
      }
    }

    let topHolderPercent = null;
    let topHolderAmount = null;

    /*
     * IMPORTANT:
     * Calculate concentration using raw integer amounts.
     * No floating-point division here.
     */
    if (
      rawSupply !== null &&
      topHolderRaw > 0n
    ) {
      try {
        const rawSupplyBig =
          BigInt(rawSupply);

        if (rawSupplyBig > 0n) {
          topHolderPercent =
            Number(
              (topHolderRaw * 1000000n) /
              rawSupplyBig
            ) / 10000;

          if (
            supplyDecimals !== null &&
            Number.isInteger(supplyDecimals) &&
            supplyDecimals >= 0 &&
            supplyDecimals <= 18
          ) {
            topHolderAmount =
              rawToNumber(
                topHolderRaw.toString(),
                supplyDecimals
              );
          }
        }
      } catch {
        topHolderPercent = null;
        topHolderAmount = null;
      }
    }

    // =====================================================
    // RISK ENGINE
    // =====================================================

    let score = 10;

    const signals = [];

    // Mint authority
    if (mintAuthority) {
      score += 25;

      signals.push({
        level: "HIGH",
        title: "Mint authority detected",
        description:
          "An active mint authority was detected and may be able to increase token supply."
      });
    } else {
      signals.push({
        level: "LOW",
        title: "Mint authority not detected",
        description:
          "No active mint authority was returned."
      });
    }

    // Freeze authority
    if (freezeAuthority) {
      score += 20;

      signals.push({
        level: "HIGH",
        title: "Freeze authority detected",
        description:
          "An active freeze authority may be able to restrict token accounts."
      });
    } else {
      signals.push({
        level: "LOW",
        title: "No freeze authority detected",
        description:
          "No active freeze authority was returned."
      });
    }

    // Metadata
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
        title: "Token metadata incomplete",
        description:
          "Token metadata is missing or incomplete."
      });
    }

    // Supply
    if (
      supply !== null &&
      Number.isFinite(supply)
    ) {
      signals.push({
        level: "LOW",
        title: "Supply information available",
        description:
          "Total on-chain supply: " +
          formatNumber(supply) +
          " " +
          symbol
      });
    } else {
      score += 10;

      signals.push({
        level: "MEDIUM",
        title: "Supply information unavailable",
        description:
          "The token supply could not be read from the Solana network."
      });
    }

    // Price
    if (price !== null) {
      signals.push({
        level: "LOW",
        title: "Market price available",
        description:
          "Indexed price: $" +
          formatPrice(price)
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

    // Holder distribution
    if (holderCount > 0) {
      signals.push({
        level: "LOW",
        title: "Holder distribution analyzed",
        description:
          holderCount.toLocaleString() +
          " unique holders detected across " +
          analyzedAccounts.toLocaleString() +
          " non-zero token accounts in the analyzed snapshot."
      });
    } else {
      score += 5;

      signals.push({
        level: "MEDIUM",
        title: "Holder distribution unavailable",
        description:
          holderScanError
            ? "Holder data could not be retrieved from Helius."
            : "No non-zero token holders were returned."
      });
    }

    // Top holder concentration
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
            "The largest detected holder controls approximately " +
            topHolderPercent.toFixed(2) +
            "% of total supply."
        });
      } else if (topHolderPercent >= 25) {
        score += 20;

        signals.push({
          level: "HIGH",
          title: "High holder concentration",
          description:
            "The largest detected holder controls approximately " +
            topHolderPercent.toFixed(2) +
            "% of total supply."
        });
      } else if (topHolderPercent >= 10) {
        score += 10;

        signals.push({
          level: "MEDIUM",
          title: "Moderate holder concentration",
          description:
            "The largest detected holder controls approximately " +
            topHolderPercent.toFixed(2) +
            "% of total supply."
        });
      } else {
        signals.push({
          level: "LOW",
          title: "Low top-holder concentration",
          description:
            "The largest detected holder controls approximately " +
            topHolderPercent.toFixed(2) +
            "% of total supply."
        });
      }
    } else {
      signals.push({
        level: "INFO",
        title: "Holder concentration unavailable",
        description:
          "A reliable top-holder percentage could not be calculated from the available holder snapshot."
      });
    }

    // Token program
    signals.push({
      level: "LOW",
      title: "Token program identified",
      description:
        "Token program: " +
        tokenProgram
    });

    score =
      Math.max(
        0,
        Math.min(
          100,
          score
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

    // =====================================================
    // FINAL RESPONSE
    // =====================================================

    return response(200, {
      success: true,

      scanner: {
        name: "KYVORA",
        version: "FINAL"
      },

      token: {
        address: address,
        name: name,
        symbol: symbol,
        decimals:
          supplyDecimals ??
          decimalsFromAsset ??
          0,
        supply: supply,
        rawSupply: rawSupply,
        price: price,
        tokenProgram: tokenProgram
      },

      holders: {
        holderCount: holderCount,
        topHolderPercent:
          topHolderPercent,
        topHolderAmount:
          topHolderAmount,
        topHolderOwner:
          topHolderOwner,
        analyzedAccounts:
          analyzedAccounts
      },

      risk: {
        score: score,
        level: level,
        signals: signals
      },

      disclaimer:
        "KYVORA provides risk indicators for research purposes only and does not guarantee that a token is safe or malicious.",

      source: "Helius"
    });

  } catch (error) {
    console.error(
      "KYVORA scanner error:",
      error
    );

    return response(500, {
      success: false,
      error:
        error.message ||
        "Unable to analyze token."
    });
  }
};


// =========================================================
// RESPONSE HELPER
// =========================================================

function response(statusCode, data) {
  return {
    statusCode: statusCode,

    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },

    body: JSON.stringify(data)
  };
}


// =========================================================
// RAW INTEGER → DECIMAL NUMBER
// =========================================================

function rawToNumber(raw, decimals) {
  try {
    const value = BigInt(String(raw));
    const d = Number(decimals);

    if (!Number.isInteger(d) || d < 0 || d > 18) {
      return null;
    }

    if (d === 0) {
      return Number(value);
    }

    const divisor = 10n ** BigInt(d);

    const whole = value / divisor;
    const fraction = value % divisor;

    if (fraction === 0n) {
      return Number(whole);
    }

    const fractionText =
      fraction
        .toString()
        .padStart(d, "0")
        .replace(/0+$/, "");

    return Number(
      whole.toString() +
      "." +
      fractionText
    );
  } catch {
    return null;
  }
}


// =========================================================
// DISPLAY HELPERS
// =========================================================

function formatNumber(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "Unavailable";
  }

  return Number(value).toLocaleString(
    "en-US",
    {
      maximumFractionDigits: 6
    }
  );
}


function formatPrice(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "Unavailable";
  }

  const number = Number(value);

  if (number < 0.000001) {
    return number.toFixed(10);
  }

  if (number < 1) {
    return number.toFixed(6);
  }

  return number.toFixed(4);
}
