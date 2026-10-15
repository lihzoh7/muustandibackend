
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

process.env.TZ = "Africa/Johannesburg";

const PORT = process.env.PORT || 10000;

/* =========================================================
   ENVIRONMENT VARIABLES
   ========================================================= */

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;
const PAYM8_AUTH_HEADER = process.env.PAYM8_AUTH_HEADER;

/*
 * Set WALLET_URL in Render to your actual public wallet.html URL.
 * This fallback is the wallet URL previously intended for Muustandi.
 */
const WALLET_URL =
  process.env.WALLET_URL ||
  "https://muustandigamin.xyz/wallet.html";

const BACKEND_URL =
  (process.env.BACKEND_URL ||
    "https://muustandibackend.onrender.com").replace(/\/+$/, "");

/* =========================================================
   FIREBASE
   ========================================================= */

const DATABASE_URL =
  "https://tose-ccf8f-default-rtdb.europe-west1.firebasedatabase.app";

let firebaseApp = null;
let db = null;

try {
  if (
    !FIREBASE_PROJECT_ID ||
    !FIREBASE_CLIENT_EMAIL ||
    !FIREBASE_PRIVATE_KEY
  ) {
    throw new Error("Missing Firebase environment variables.");
  }

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
    databaseURL: DATABASE_URL,
  });

  db = getDatabase(firebaseApp);

  console.log("Firebase Admin initialized successfully.");
  console.log("Firebase Realtime Database initialized.");
} catch (error) {
  console.error("Firebase initialization error:", error.message);
}

/* =========================================================
   PAYM8
   ========================================================= */

const PAYM8_SUBMIT_URL =
  "https://paym8online.com/PaymentsService/api/v1/ecommerce/SubmitPaymentRequest";

const PAYM8_OUTCOME_URL =
  "https://paym8online.com/PaymentsService/api/v1/ecommerce/GetPaymentOutcome";

const MERCHANT_CLIENT_PROFILE = "PMV-03";
const MERCHANT_BRANCH_PRODUCT_NUMBER = "JQVSND";

/* =========================================================
   GENERAL HELPERS
   ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function normalizeToken(value) {
  return value == null ? "" : String(value).trim();
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }

  return req.socket?.remoteAddress || req.ip || "127.0.0.1";
}

function southAfricaTime() {
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    dateStyle: "full",
    timeStyle: "medium",
  }).format(new Date());
}

function logTimezoneInformation() {
  console.log("========== SERVER TIMEZONE ==========");
  console.log("Node TZ:", process.env.TZ);
  console.log(
    "Resolved timezone:",
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  console.log("UTC time:", nowIso());
  console.log("South Africa time:", southAfricaTime());
  console.log("=====================================");
}

function getOutcomeData(parsed) {
  /*
   * Support either a wrapped { data: {...} } response
   * or a response whose outcome fields are at the top level.
   */
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  if (parsed.data && typeof parsed.data === "object") {
    return parsed.data;
  }

  if (parsed.Data && typeof parsed.Data === "object") {
    return parsed.Data;
  }

  return parsed;
}

function isSuccessfulPaym8Outcome(outcomeData) {
  if (!outcomeData) return false;

  const code = String(outcomeData.outcomeCode ?? "")
    .trim()
    .toLowerCase();

  const description = String(
    outcomeData.outcomeDescription ?? ""
  ).trim().toLowerCase();

  /*
   * Only explicit success indicators are accepted.
   * HTTP 200, submitWasSuccessful, or a callback alone
   * is not proof that the payment completed.
   */
  const successfulCodes = new Set([
    "successful",
    "success",
    "completed",
    "complete",
  ]);

  const successfulDescriptions = new Set([
    "successful",
    "success",
    "completed",
    "complete",
  ]);

  return (
    successfulCodes.has(code) ||
    successfulDescriptions.has(description)
  );
}

function isFailedPaym8Outcome(outcomeData) {
  if (!outcomeData) return false;

  const code = String(outcomeData.outcomeCode ?? "")
    .trim()
    .toLowerCase();

  return code === "faulted";
}

/* =========================================================
   FIND TRANSACTIONS
   ========================================================= */

async function findByChildValue(path, childName, value) {
  if (!db || !value) return null;

  try {
    const snapshot = await db
      .ref(path)
      .orderByChild(childName)
      .equalTo(value)
      .once("value");

    if (!snapshot.exists()) return null;

    let found = null;

    snapshot.forEach((child) => {
      found = {
        key: child.key,
        ...child.val(),
      };
    });

    return found;
  } catch (error) {
    console.error(
      `Lookup error for ${path}.${childName}:`,
      error.message
    );
    return null;
  }
}

async function findTransactionByToken(token) {
  return findByChildValue("paymentTransactions", "token", token);
}

async function findTransactionByCallbackToken(token) {
  return findByChildValue(
    "paymentTransactions",
    "callbackToken",
    token
  );
}

async function findTransactionByMerchantReference(reference) {
  return findByChildValue(
    "paymentTransactions",
    "merchantReference",
    reference
  );
}

async function findCallbackByToken(token) {
  return findByChildValue("paym8Callbacks", "token", token);
}

async function readTransaction(transactionKey) {
  if (!db || !transactionKey) return null;

  const snapshot = await db
    .ref(`paymentTransactions/${transactionKey}`)
    .once("value");

  if (!snapshot.exists()) return null;

  return {
    key: snapshot.key,
    ...snapshot.val(),
  };
}

/* =========================================================
   PAYM8 PAYMENT OUTCOME
   ========================================================= */

async function getPaym8Outcome(token) {
  if (!PAYM8_AUTH_HEADER) {
    throw new Error("PAYM8_AUTH_HEADER is not configured.");
  }

  if (!token) {
    throw new Error("PAYM8 token is required.");
  }

  const url =
    `${PAYM8_OUTCOME_URL}/${encodeURIComponent(token)}`;

  console.log("PayM8 outcome URL:", url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: PAYM8_AUTH_HEADER,
    },
  });

  const raw = await response.text();

  let parsed = null;

  try {
    parsed = JSON.parse(raw);
  } catch {
    // Preserve the raw response for diagnostics.
  }

  return {
    httpStatus: response.status,
    ok: response.ok,
    raw,
    response: parsed,
    data: getOutcomeData(parsed),
  };
}

async function savePaym8Outcome(transaction, result) {
  if (!db || !transaction?.key) return;

  const data = result?.data || {};

  await db
    .ref(`paymentTransactions/${transaction.key}`)
    .update({
      lastPaym8Outcome: result?.response ?? result?.raw ?? null,
      paym8OutcomeHttpStatus: result?.httpStatus ?? null,
      outcomeCode: data.outcomeCode ?? null,
      outcomeDescription: data.outcomeDescription ?? "",
      lastCompletedStep: data.lastCompletedStep ?? null,
      errorSourceSystem: data.errorSourceSystem ?? null,
      errorCodes: data.errorCodes ?? [],
      outcomeCheckedAt: nowIso(),
    });
}

/* =========================================================
   WALLET CREDIT — IDEMPOTENT
   ========================================================= */

/*
 * The wallet transaction is the idempotency guard.
 *
 * The wallet and the credited-payment ledger are changed
 * together in one Firebase transaction. If a callback and
 * a browser status check arrive together, only one can add
 * the deposit for this transaction key.
 *
 * A repeat request can repair paymentTransactions.walletCredited
 * if the wallet was credited but the server stopped before
 * updating the transaction record.
 */

async function creditWalletIfConfirmed(transaction, outcomeData) {
  if (!db || !transaction?.key) {
    return {
      credited: false,
      reason: "Transaction not available.",
    };
  }

  if (!isSuccessfulPaym8Outcome(outcomeData)) {
    return {
      credited: false,
      reason: "PAYM8 final success has not been confirmed.",
    };
  }

  const userId = String(transaction.userId || "");
  const amountInCents = Number(transaction.amountInCents);
  const transactionKey = String(transaction.key);

  if (!userId || userId === "GUEST") {
    return {
      credited: false,
      reason: "Transaction user ID is invalid.",
    };
  }

  if (
    !Number.isSafeInteger(amountInCents) ||
    amountInCents < 500
  ) {
    return {
      credited: false,
      reason: "Transaction amount is invalid.",
    };
  }

  const walletRef = db.ref(`wallet/${userId}`);
  const depositAmount = amountInCents / 100;
  const creditTime = nowIso();

  const result = await walletRef.transaction((current) => {
    const wallet =
      current && typeof current === "object"
        ? current
        : {};

    const creditedPayments =
      wallet.creditedPayments &&
      typeof wallet.creditedPayments === "object"
        ? wallet.creditedPayments
        : {};

    /*
     * Firebase transaction keys must not contain forbidden
     * characters. Our generated DEP-... reference is safe.
     */
    if (creditedPayments[transactionKey] === true) {
      return; // Abort: this payment was already credited.
    }

    const currentGems = Number(wallet.gems || 0);
    const currentLives = Number(wallet.lives || 0);

    if (
      !Number.isFinite(currentGems) ||
      !Number.isFinite(currentLives)
    ) {
      throw new Error("Wallet contains an invalid gems/lives value.");
    }

    return {
      ...wallet,
      gems: currentGems + depositAmount,
      lives: currentLives,
      updatedAt: creditTime,
      creditedPayments: {
        ...creditedPayments,
        [transactionKey]: true,
      },
    };
  });

  /*
   * If the transaction aborted because the ledger already
   * contains this key, verify that it really is recorded.
   */
  const walletSnapshot = await walletRef.once("value");
  const walletAfter = walletSnapshot.val() || {};
  const ledger = walletAfter.creditedPayments || {};
  const alreadyInLedger = ledger[transactionKey] === true;

  if (!result.committed && !alreadyInLedger) {
    return {
      credited: false,
      reason: "Wallet transaction was not committed.",
    };
  }

  /*
   * Keep the transaction record synchronized with the wallet
   * ledger, including after a retry.
   */
  await db
    .ref(`paymentTransactions/${transactionKey}`)
    .update({
      walletCredited: true,
      walletCreditedAt:
        transaction.walletCreditedAt || creditTime,
      creditedAmountInCents: amountInCents,
      walletAfter,
      status: "COMPLETED",
      updatedAt: nowIso(),
    });

  console.log("========== WALLET CREDIT ==========");
  console.log("User ID:", userId);
  console.log("Transaction:", transactionKey);
  console.log("Amount cents:", amountInCents);
  console.log("Amount Rand:", depositAmount);
  console.log("Already in ledger:", alreadyInLedger);
  console.log("====================================");

  return {
    credited: true,
    alreadyCredited: alreadyInLedger,
  };
}

/* =========================================================
   PAYMENT PROCESSING HELPER
   ========================================================= */

async function processOutcomeForTransaction(transaction, outcomeResult) {
  if (!transaction?.key || !outcomeResult) {
    return transaction;
  }

  await savePaym8Outcome(transaction, outcomeResult);

  if (isSuccessfulPaym8Outcome(outcomeResult.data)) {
    try {
      await creditWalletIfConfirmed(
        transaction,
        outcomeResult.data
      );
    } catch (error) {
      console.error("Wallet credit error:", error.message);
    }
  } else if (isFailedPaym8Outcome(outcomeResult.data)) {
    /*
     * Do not overwrite an already completed transaction.
     */
    const fresh = await readTransaction(transaction.key);

    if (fresh?.walletCredited !== true) {
      await db
        .ref(`paymentTransactions/${transaction.key}`)
        .update({
          status: "FAILED",
          updatedAt: nowIso(),
        });
    }
  }

  return readTransaction(transaction.key);
}

/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    firebaseConfigured: !!db,
    paym8Configured: !!PAYM8_AUTH_HEADER,
    merchantClientProfile: MERCHANT_CLIENT_PROFILE,
    merchantBranchProductNumber: MERCHANT_BRANCH_PRODUCT_NUMBER,
    serverTimezone:
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    nodeTimezone: process.env.TZ,
  });
});

app.get("/", (req, res) => {
  res.json({
    status: "Muustandi backend online",
    firebaseConfigured: !!db,
    paym8Configured: !!PAYM8_AUTH_HEADER,
    serverTimezone:
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

/* =========================================================
   FIREBASE TEST
   ========================================================= */

app.get("/test-firebase", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: "Firebase database is not available.",
      });
    }

    const testId = `TEST-${Date.now()}`;
    const data = {
      createdAt: nowIso(),
      message: "Muustandi Firebase connection test",
      test: true,
    };

    await db
      .ref(`paymentTransactions/${testId}`)
      .set(data);

    return res.json({
      success: true,
      testId,
      data,
    });
  } catch (error) {
    console.error("Firebase test error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   1VOUCHER DEPOSIT
   ========================================================= */

app.post("/deposit/1voucher", async (req, res) => {
  console.log("========== 1VOUCHER DEPOSIT ==========");

  let merchantReference = null;

  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: "Firebase database is not available.",
      });
    }

    if (!PAYM8_AUTH_HEADER) {
      return res.status(500).json({
        success: false,
        message: "PayM8 is not configured.",
      });
    }

    const amount = Number(req.body.amountInCents);
    const userId = String(req.body.userId || "").trim();

    const firstName = String(
      req.body.firstName || req.body.name || "Gamer"
    ).trim();

    const lastName = String(
      req.body.lastName || req.body.surname || "Customer"
    ).trim();

    console.log("User ID:", userId);
    console.log("Amount cents:", amount);

    if (!Number.isSafeInteger(amount) || amount < 500) {
      return res.status(400).json({
        success: false,
        message: "Minimum 1Voucher deposit is R5.",
      });
    }

    if (!userId || userId === "GUEST") {
      return res.status(400).json({
        success: false,
        message: "Valid user ID is required.",
      });
    }

    const clientIp = getClientIp(req);

    logTimezoneInformation();

    merchantReference =
      `DEP-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const callbackUrl =
      `${BACKEND_URL}/api/1voucher/callback?token={0}`;

    const resultRedirectUrl =
      `${BACKEND_URL}/wallet-success?token={0}`;

    const transactionData = {
      userId,
      amountInCents: amount,
      merchantReference,
      status: "PENDING",
      walletCredited: false,
      createdAt: nowIso(),
      serverTimezone:
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      serverUtcTime: nowIso(),
      serverSouthAfricaTime: southAfricaTime(),
      clientIp,
      firstName,
      lastName,
    };

    await db
      .ref(`paymentTransactions/${merchantReference}`)
      .set(transactionData);

    /*
     * Keep the payload aligned with the structure you supplied.
     * Do not add undocumented date/time fields or uniqueCustomerId.
     */
    const payload = {
      merchantBranchProductNumber:
        MERCHANT_BRANCH_PRODUCT_NUMBER,
      totalCostInCents: amount,
      transactionDescription: "1Voucher Wallet Deposit",
      merchantReferenceNumber: merchantReference,
      userHostAddress: clientIp,
      resultRedirectUrl,
      callbackUrl,
      paymentChannels: [
        {
          channelName: "OneVoucher",
          settings: null,
        },
      ],
      merchantClientProfile: MERCHANT_CLIENT_PROFILE,
      FirstName: firstName,
      Lastname: lastName,
    };

    console.log("PAYM8 SUBMIT REQUEST BODY:");
    console.log(JSON.stringify(payload, null, 2));

    const response = await fetch(PAYM8_SUBMIT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: PAYM8_AUTH_HEADER,
      },
      body: JSON.stringify(payload),
    });

    const rawResponse = await response.text();

    console.log("PayM8 HTTP status:", response.status);
    console.log("PayM8 raw response:", rawResponse);

    let paym8Response = null;

    try {
      paym8Response = JSON.parse(rawResponse);
    } catch {
      // Keep raw response for transaction diagnostics.
    }

    const submitData = paym8Response?.data || null;
    const submitWasSuccessful =
      submitData?.submitWasSuccessful === true;

    if (!response.ok || !submitWasSuccessful) {
      await db
        .ref(`paymentTransactions/${merchantReference}`)
        .update({
          status: "PAYM8_SUBMIT_FAILED",
          paym8HttpStatus: response.status,
          paym8Response: paym8Response || rawResponse,
          updatedAt: nowIso(),
        });

      return res.status(400).json({
        success: false,
        message:
          submitData?.failureReason ||
          paym8Response?.description ||
          "PayM8 payment request failed.",
        merchantReference,
        paym8Response: paym8Response || rawResponse,
      });
    }

    const token = normalizeToken(submitData.token);
    const redirectUri = submitData.redirectUri || null;

    await db
      .ref(`paymentTransactions/${merchantReference}`)
      .update({
        token: token || null,
        redirectUri,
        paym8Response,
        status: "PAYM8_SUBMITTED",
        updatedAt: nowIso(),
      });

    console.log("PayM8 submit successful.");
    console.log("Token received:", !!token);
    console.log("Redirect received:", !!redirectUri);

    if (!redirectUri) {
      return res.status(502).json({
        success: false,
        message:
          "PayM8 accepted the request but did not return a payment redirect URL. The payment has not been confirmed.",
        merchantReference,
        token: token || null,
        status: "PAYM8_SUBMITTED",
      });
    }

    return res.json({
      success: true,
      merchantReference,
      token: token || null,
      redirectUri,
      status: "PAYM8_SUBMITTED",
    });
  } catch (error) {
    console.error("1Voucher deposit error:", error);

    if (db && merchantReference) {
      try {
        await db
          .ref(`paymentTransactions/${merchantReference}`)
          .update({
            backendError: error.message,
            updatedAt: nowIso(),
          });
      } catch (saveError) {
        console.error(
          "Could not save deposit error:",
          saveError.message
        );
      }
    }

    return res.status(500).json({
      success: false,
      message: "Unable to start 1Voucher payment.",
      error: error.message,
    });
  }
});

/* =========================================================
   PAYM8 CALLBACK
   ========================================================= */

app.all("/api/1voucher/callback", async (req, res) => {
  console.log("========== PAYM8 CALLBACK ==========");

  try {
    if (!db) {
      return res.status(500).send("Firebase unavailable");
    }

    const callbackToken = normalizeToken(
      req.query?.token ||
      req.body?.token ||
      req.body?.transactionToken
    );

    const merchantReference =
      req.body?.merchantReference ||
      req.body?.merchantReferenceNumber ||
      req.query?.merchantReference ||
      null;

    const callbackId =
      callbackToken || `callback-${Date.now()}`;

    const callbackData = {
      token: callbackToken || null,
      merchantReference: merchantReference || null,
      method: req.method,
      query: req.query || {},
      body: req.body || {},
      receivedAt: nowIso(),
    };

    await db
      .ref(`paym8Callbacks/${callbackId}`)
      .set(callbackData);

    let transaction = null;

    if (callbackToken) {
      transaction = await findTransactionByToken(callbackToken);

      if (!transaction) {
        transaction =
          await findTransactionByCallbackToken(callbackToken);
      }
    }

    if (!transaction && merchantReference) {
      transaction =
        await findTransactionByMerchantReference(
          merchantReference
        );
    }

    if (transaction?.key) {
      await db
        .ref(`paymentTransactions/${transaction.key}`)
        .update({
          callbackReceived: true,
          callbackToken: callbackToken || null,
          callbackMerchantReference:
            merchantReference || null,
          callbackReceivedAt: nowIso(),
        });
    }

    /*
     * Receiving the callback is not itself proof of payment.
     * Query PayM8 for the final outcome before considering credit.
     */
    if (callbackToken && transaction) {
      try {
        const outcomeResult =
          await getPaym8Outcome(callbackToken);

        console.log(
          "Callback outcome:",
          JSON.stringify(outcomeResult.response || outcomeResult.raw)
        );

        transaction = await processOutcomeForTransaction(
          transaction,
          outcomeResult
        );
      } catch (error) {
        console.error(
          "Could not verify callback outcome:",
          error.message
        );
      }
    }

    /*
     * Acknowledge the callback. The browser's payment-status
     * endpoint will independently check the outcome if needed.
     */
    return res.status(200).send("OK");
  } catch (error) {
    console.error("PayM8 callback error:", error);
    return res.status(500).send("ERROR");
  }
});

/* =========================================================
   PAYMENT STATUS
   ========================================================= */

app.get("/payment-status", async (req, res) => {
  console.log("========== PAYMENT STATUS ==========");

  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: "Firebase database is not available.",
      });
    }

    const token = normalizeToken(req.query.token);

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Payment token is required.",
      });
    }

    let transaction = await findTransactionByToken(token);

    if (!transaction) {
      transaction = await findTransactionByCallbackToken(token);
    }

    const callbackRecord = await findCallbackByToken(token);

    const outcomeResult = await getPaym8Outcome(token);

    console.log("PayM8 outcome HTTP status:", outcomeResult.httpStatus);
    console.log("PayM8 outcome response:", outcomeResult.raw);

    const outcomeData = outcomeResult.data;

    const merchantReference =
      outcomeData?.merchantReference ||
      outcomeData?.merchantReferenceNumber ||
      transaction?.merchantReference ||
      callbackRecord?.merchantReference ||
      null;

    if (!transaction && merchantReference) {
      transaction =
        await findTransactionByMerchantReference(
          merchantReference
        );
    }

    if (transaction) {
      transaction = await processOutcomeForTransaction(
        transaction,
        outcomeResult
      );
    }

    const outcomeCode = outcomeData?.outcomeCode ?? null;
    const outcomeDescription =
      outcomeData?.outcomeDescription || "";

    let status = "PENDING";

    if (transaction?.walletCredited === true) {
      status = "COMPLETED";
    } else if (isFailedPaym8Outcome(outcomeData)) {
      status = "FAILED";
    }

    return res.json({
      success: true,
      status,
      walletCredited: transaction?.walletCredited === true,
      token,
      merchantReference,
      outcomeCode,
      outcomeDescription,
      lastCompletedStep: outcomeData?.lastCompletedStep ?? null,
      errorSourceSystem: outcomeData?.errorSourceSystem ?? null,
      errorCodes: outcomeData?.errorCodes ?? [],
      transactionFound: !!transaction,
      callbackReceived:
        !!transaction?.callbackReceived || !!callbackRecord,
      paym8Outcome: outcomeData,
      serverTimezone:
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      serverUtcTime: nowIso(),
      serverSouthAfricaTime: southAfricaTime(),
    });
  } catch (error) {
    console.error("Payment status error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to check payment status.",
      error: error.message,
    });
  }
});

/* =========================================================
   RETURN URL — VERIFY, SHOW RESULT, RETURN TO WALLET
   ========================================================= */

app.get("/wallet-success", (req, res) => {
  const token = normalizeToken(req.query.token);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muustandi Payment Verification</title>
<style>
body {
  font-family: Arial, sans-serif;
  background: #f5f5f5;
  text-align: center;
  padding: 40px 20px;
  color: #222;
}
.box {
  max-width: 500px;
  margin: auto;
  background: #fff;
  padding: 28px;
  border-radius: 12px;
  box-shadow: 0 2px 10px rgba(0,0,0,.08);
}
#status {
  margin-top: 20px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
</style>
</head>
<body>
<div class="box">
  <h2 id="heading">Checking your payment...</h2>
  <p>Please wait while we verify your 1Voucher payment with PayM8.</p>
  <p>Do not submit the same voucher again while verification is in progress.</p>
  <div id="status">Connecting to PayM8...</div>
</div>

<script>
const token = ${JSON.stringify(token)};
const walletUrl = ${JSON.stringify(WALLET_URL)};
let finished = false;
let attempts = 0;
const maxAttempts = 24;

function returnToWallet(result, message, reference) {
  if (finished) return;
  finished = true;

  document.getElementById("heading").textContent = result;
  document.getElementById("status").textContent =
    message + " Returning to your wallet shortly...";

  const url = new URL(walletUrl);
  url.searchParams.set("paymentStatus", result.toLowerCase());
  url.searchParams.set("paymentMessage", message);

  if (reference) {
    url.searchParams.set("merchantReference", reference);
  }

  setTimeout(() => {
    window.location.replace(url.toString());
  }, 2500);
}

async function checkPayment() {
  if (finished) return;

  if (!token) {
    returnToWallet(
      "Payment status unknown",
      "The PayM8 payment token is missing. Please check your wallet before trying again.",
      ""
    );
    return;
  }

  attempts += 1;

  try {
    const response = await fetch(
      "/payment-status?token=" + encodeURIComponent(token),
      { cache: "no-store" }
    );

    const data = await response.json();

    console.log("Payment verification:", data);

    if (data.walletCredited === true && data.status === "COMPLETED") {
      returnToWallet(
        "Payment successful",
        "Your payment was confirmed and your wallet has been credited.",
        data.merchantReference || ""
      );
      return;
    }

    if (data.status === "FAILED" || data.outcomeCode === "Faulted") {
      const reason =
        data.outcomeDescription ||
        "PayM8 reported that the payment faulted.";

      returnToWallet(
        "Payment failed",
        reason + " Your wallet was not credited for this failed transaction.",
        data.merchantReference || ""
      );
      return;
    }

    document.getElementById("status").textContent =
      "PayM8 has not confirmed a final result yet. Please wait...";

    if (attempts >= maxAttempts) {
      returnToWallet(
        "Payment pending",
        "We could not confirm the final result yet. Your wallet has not been credited by this check. Please check your wallet and payment history before retrying.",
        data.merchantReference || ""
      );
    }
  } catch (error) {
    console.error("Payment verification error:", error);

    document.getElementById("status").textContent =
      "We are still trying to verify your payment. Please wait...";
    
    if (attempts >= maxAttempts) {
      returnToWallet(
        "Payment pending",
        "Verification could not be completed. Please check your wallet and payment history before retrying.",
        ""
      );
    }
  }
}

checkPayment();
const timer = setInterval(() => {
  if (finished) {
    clearInterval(timer);
    return;
  }
  checkPayment();
}, 5000);
</script>
</body>
</html>`;

  res.status(200).type("html").send(html);
});

/* =========================================================
   DEBUG PAYMENT OUTCOME
   ========================================================= */

app.get("/debug/payment-outcome", async (req, res) => {
  try {
    const token = normalizeToken(req.query.token);

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Token is required.",
      });
    }

    const result = await getPaym8Outcome(token);

    return res.status(result.httpStatus).send(result.raw);
  } catch (error) {
    console.error("Debug outcome error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   DEBUG PAYM8 CONFIGURATION
   ========================================================= */

app.get("/debug/paym8-config", (req, res) => {
  res.json({
    paym8Configured: !!PAYM8_AUTH_HEADER,
    merchantClientProfile: MERCHANT_CLIENT_PROFILE,
    merchantBranchProductNumber: MERCHANT_BRANCH_PRODUCT_NUMBER,
    submitUrl: PAYM8_SUBMIT_URL,
    outcomeUrl: PAYM8_OUTCOME_URL,
    uniqueCustomerId: "NOT SENT",
    walletUrl: WALLET_URL,
    backendUrl: BACKEND_URL,
    timezone:
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    nodeTimezone: process.env.TZ,
    utcNow: nowIso(),
    southAfricaNow: southAfricaTime(),
  });
});

/* =========================================================
   SERVER
   ========================================================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
  console.log("Node timezone:", process.env.TZ);
  console.log(
    "Resolved timezone:",
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  console.log("Firebase configured:", !!db);
  console.log("PayM8 configured:", !!PAYM8_AUTH_HEADER);
  console.log("Merchant client profile:", MERCHANT_CLIENT_PROFILE);
  console.log(
    "Merchant branch product number:",
    MERCHANT_BRANCH_PRODUCT_NUMBER
  );
  console.log("Wallet URL:", WALLET_URL);
  console.log("Backend URL:", BACKEND_URL);
});
