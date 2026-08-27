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

    const rpcUrl =
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    async function rpc(method, params) {
      const response = await fetch(rpcUrl, {
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
          `Helius ${method} request failed.`
        );
      }

      return data.result;
    }

    // =====================================================
    // 1. TOKEN METADATA / PRICE / PROGRAM
    // =====================================================

    const asset = await rpc("getAsset", {
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

    const name =
      metadata.name ||
      "Unknown Token";

    const symbol =
      metadata.symbol ||
      "UNKNOWN";

    const decimals =
      Number(tokenInfo.decimals ?? 0);

    const priceValue =
      tokenInfo.price_info?.price_per_token;

    const price =
      priceValue !== undefined &&
      priceValue !== null &&
      Number.isFinite(Number(priceValue))
        ? Number(priceValue)
        : null;

    const tokenProgram =
      tokenInfo.token_program ||
      tokenInfo.program ||
      "Unknown";

    // =====================================================
    // 2. AUTHORITIES
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
    // 3. TRUE ON-CHAIN SUPPLY
    //
    // IMPORTANT:
    // Use getTokenSupply instead of relying on Number()
    // conversion of a potentially huge raw integer.
    // =====================================================

    const supplyResult =
      await rpc("getTokenSupply", [
        address
      ]);

    const supplyValue =
      supplyResult?.value || {};

    const rawSupplyString =
      String(supplyValue.amount || "0");

    const supplyDecimals =
      Number(
        supplyValue.decimals ??
        decimals
      );

    let supply = null;

    try {
      const rawSupply =
        BigInt(rawSupplyString);

      const divisor =
        10n ** BigInt(supplyDecimals);

      const whole =
        rawSupply / divisor;

      const fraction =
        rawSupply % divisor;

      if (fraction === 0n) {
        supply = Number(whole);
      } else {
        const fractionText =
          fraction
            .toString()
            .padStart(
              supplyDecimals,
              "0"
            )
            .replace(/0+$/, "");

        supply =
          Number(
            `${whole.toString()}.${fractionText}`
          );
      }

    } catch (error) {
      supply = null;
    }

    // =====================================================
    // 4. HOLDER ANALYSIS
    //
    // Fetch token accounts page by page.
    // Aggregate balances by wallet owner.
    // Keep balances as BigInt to avoid precision loss.
    // =====================================================

    const owners = new Map();

    let page = 1;
    let totalAccountsAnalyzed = 0;
    const MAX_PAGES = 100;

    while (page <= MAX_PAGES) {

      const holderResult =
        await rpc("getTokenAccounts", {
          mint: address,
          page,
          limit: 1000
        });

      const accounts =
        holderResult?.token_accounts || [];

      if (!accounts.length) {
        break;
      }

      for (const account of accounts) {

        const owner =
          account.owner;

        if (!owner) {
          continue;
        }

        let rawAmount;

        try {
          rawAmount =
            BigInt(
              String(
                account.amount || "0"
              )
            );
        } catch {
          rawAmount = 0n;
        }

        // Ignore empty token accounts.
        if (rawAmount <= 0n) {
          continue;
        }

        totalAccountsAnalyzed++;

        const previous =
          owners.get(owner) || 0n;

        owners.set(
          owner,
          previous + rawAmount
        );
      }

      if (accounts.length < 1000) {
        break;
      }

      page++;
    }

    const holderCount =
      owners.size;

    // =====================================================
    // 5. TOP HOLDER CONCENTRATION
    //
    // Compare raw top-holder balance directly against
    // raw total supply. No floating-point conversion.
    // =====================================================

    let topHolderPercent = null;
    let topHolderAmount = null;

    let topHolderRaw = 0n;

    for (const amount of owners.values()) {
      if (amount > topHolderRaw) {
        topHolderRaw = amount;
      }
    }

    try {

      const rawSupply =
        BigInt(rawSupplyString);

      if (
        rawSupply > 0n &&
        topHolderRaw > 0n
      ) {

        /*
          Calculate percentage using integer arithmetic.
          Multiply by 10,000,000 to retain precision,
          then divide by supply.
        */

        const scaled =
          (topHolderRaw * 10000000n) /
          rawSupply;

        topHolderPercent =
          Number(scaled) / 100000;

        const divisor =
          10n ** BigInt(supplyDecimals);

        const whole =
          topHolderRaw / divisor;

        const fraction =
          topHolderRaw % divisor;

        if (fraction === 0n) {

          topHolderAmount =
            Number(whole);

        } else {

          const fractionText =
            fraction
              .toString()
              .padStart(
                supplyDecimals,
                "0"
              )
              .replace(/0+$/, "");

          topHolderAmount =
            Number(
              `${whole.toString()}.${fractionText}`
            );
        }
      }

    } catch {
      topHolderPercent = null;
      topHolderAmount = null;
    }

    // =====================================================
    // 6. RISK ENGINE
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
          `Total on-chain supply: ${formatNumber(supply)} ${symbol}`
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

    // Holder count
    if (holderCount > 0) {

      signals.push({
        level: "LOW",
        title: "Holder distribution analyzed",
        description:
          `${holderCount.toLocaleString()} unique holders detected across ${totalAccountsAnalyzed.toLocaleString()} non-zero token accounts analyzed.`
      });

    } else {

      score += 5;

      signals.push({
        level: "MEDIUM",
        title: "Holder distribution unavailable",
        description:
          "No non-zero token holders were returned."
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
            `The largest detected holder controls approximately ${topHolderPercent.toFixed(2)}% of total supply.`
        });

      } else if (topHolderPercent >= 25) {

        score += 20;

        signals.push({
          level: "HIGH",
          title: "High holder concentration",
          description:
            `The largest detected holder controls approximately ${topHolderPercent.toFixed(2)}% of total supply.`
        });

      } else if (topHolderPercent >= 10) {

        score += 10;

        signals.push({
          level: "MEDIUM",
          title: "Moderate holder concentration",
          description:
            `The largest detected holder controls approximately ${topHolderPercent.toFixed(2)}% of total supply.`
        });

      } else {

        signals.push({
          level: "LOW",
          title: "Low top-holder concentration",
          description:
            `The largest detected holder controls approximately ${topHolderPercent.toFixed(2)}% of total supply.`
        });
      }

    } else {

      signals.push({
        level: "INFO",
        title: "Holder concentration unavailable",
        description:
          "A reliable top-holder percentage could not be calculated."
      });
    }

    // Token program
    signals.push({
      level: "LOW",
      title: "Token program identified",
      description:
        `Token program: ${tokenProgram}`
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
    // 7. RESPONSE
    // =====================================================

    return {
      statusCode: 200,
      headers,

      body: JSON.stringify({

        success: true,

        scanner: {
          name: "KYVORA",
          version: "4.1"
        },

        token: {
          address,
          name,
          symbol,
          decimals: supplyDecimals,
          supply,
          rawSupply: rawSupplyString,
          price,
          tokenProgram
        },

        holders: {
          holderCount,
          topHolderPercent,
          topHolderAmount,
          analyzedAccounts: totalAccountsAnalyzed
        },

        risk: {
          score,
          level,
          signals
        },

        disclaimer:
          "KYVORA provides risk indicators for research purposes only and does not guarantee that a token is safe or malicious.",

        source:
          "Helius"
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


// =========================================================
// NUMBER FORMATTER
// =========================================================

function formatNumber(value) {

  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "Unavailable";
  }

  return Number(value)
    .toLocaleString(
      "en-US",
      {
        maximumFractionDigits: 6
      }
    );
}
