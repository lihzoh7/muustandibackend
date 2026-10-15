
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

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;
const PAYM8_AUTH_HEADER = process.env.PAYM8_AUTH_HEADER;

const DATABASE_URL =
  "https://tose-ccf8f-default-rtdb.europe-west1.firebasedatabase.app";

const PAYM8_SUBMIT_URL =
  "https://paym8online.com/PaymentsService/api/v1/ecommerce/SubmitPaymentRequest";

const PAYM8_OUTCOME_URL =
  "https://paym8online.com/PaymentsService/api/v1/ecommerce/GetPaymentOutcome";

const MERCHANT_CLIENT_PROFILE = "PMV-03";
const MERCHANT_BRANCH_PRODUCT_NUMBER = "JQVSND";

const BACKEND_URL = "https://muustandibackend.onrender.com";
const WALLET_URL = "https://muustandigamin.xyz/wallet.html";

let db = null;

/* =========================================================
   FIREBASE INITIALIZATION
   ========================================================= */

try {
  if (
    !FIREBASE_PROJECT_ID ||
    !FIREBASE_CLIENT_EMAIL ||
    !FIREBASE_PRIVATE_KEY
  ) {
    throw new Error("Missing Firebase environment variables.");
  }

  const firebaseApp = admin.initializeApp({
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
   GENERAL HELPERS
   ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function normalizeToken(value) {
  if (!value) return "";

  return String(value)
    .trim()
    .replace(/^["']|["']$/g, "");
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
  console.log("Node timezone:", process.env.TZ);
  console.log(
    "Resolved timezone:",
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  console.log("UTC time:", nowIso());
  console.log("South Africa time:", southAfricaTime());
}

/*
 * Only the final PayM8 outcome "Complete" is accepted as success.
 *
 * A successful SubmitPaymentRequest response is not proof that
 * the voucher itself was successfully redeemed.
 */

function isConfirmedSuccess(data) {
  return (
    !!data &&
    String(data.outcomeCode || "").toLowerCase() === "complete"
  );
}

function isConfirmedFailure(data) {
  return (
    !!data &&
    String(data.outcomeCode || "").toLowerCase() === "faulted"
  );
}

/* =========================================================
   FIREBASE TRANSACTION LOOKUP
   ========================================================= */

async function findByChild(child, value) {
  if (!db || value === undefined || value === null || value === "") {
    return null;
  }

  const snapshot = await db
    .ref("paymentTransactions")
    .orderByChild(child)
    .equalTo(String(value))
    .once("value");

  if (!snapshot.exists()) return null;

  let found = null;

  snapshot.forEach((item) => {
    if (!found) {
      found = {
        key: item.key,
        ...item.val(),
      };
    }
  });

  return found;
}

async function findTransactionByToken(token) {
  return findByChild("token", normalizeToken(token));
}

async function findTransactionByCallbackToken(token) {
  return findByChild("callbackToken", normalizeToken(token));
}

async function findTransactionByMerchantReference(reference) {
  return findByChild("merchantReference", reference);
}

async function findTransactionForOutcome(token, outcomeData) {
  let transaction = await findTransactionByToken(token);

  if (!transaction) {
    transaction = await findTransactionByCallbackToken(token);
  }

  /*
   * PayM8's callback token may differ from the original submission
   * token. Use PayM8's returned merchantReference to locate the
   * original transaction when necessary.
   */

  const reference = outcomeData?.merchantReference;

  if (!transaction && reference) {
    transaction = await findTransactionByMerchantReference(reference);
  }

  return transaction;
}

/* =========================================================
   PAYM8: GET FINAL PAYMENT OUTCOME
   ========================================================= */

async function getPaym8Outcome(token) {
  if (!PAYM8_AUTH_HEADER) {
    throw new Error("PayM8 authentication is not configured.");
  }

  if (!token) {
    throw new Error("PayM8 payment token is missing.");
  }

  const response = await fetch(
    `${PAYM8_OUTCOME_URL}/${encodeURIComponent(token)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: PAYM8_AUTH_HEADER,
      },
    }
  );

  const raw = await response.text();

  let parsed = null;

  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  return {
    httpStatus: response.status,
    ok: response.ok,
    raw,
    response: parsed,
    data: parsed?.data || null,
  };
}

async function saveOutcome(transaction, outcome) {
  if (!db || !transaction?.key) return;

  await db.ref(`paymentTransactions/${transaction.key}`).update({
    lastPaym8Outcome: outcome.response || outcome.raw,
    paym8OutcomeHttpStatus: outcome.httpStatus,
    outcomeCode: outcome.data?.outcomeCode || null,
    outcomeDescription: outcome.data?.outcomeDescription || "",
    lastCompletedStep: outcome.data?.lastCompletedStep ?? null,
    errorSourceSystem: outcome.data?.errorSourceSystem ?? null,
    errorCodes: outcome.data?.errorCodes ?? [],
    outcomeCheckedAt: nowIso(),
    updatedAt: nowIso(),
  });
}

/* =========================================================
   WALLET CREDIT — SUCCESS ONLY, EXACTLY ONCE
   ========================================================= */

/*
 * IMPORTANT:
 *
 * This function is called only after PayM8 returns outcomeCode
 * "Complete".
 *
 * The wallet transaction atomically:
 *   1. Checks wallet.creditedPayments for this deposit.
 *   2. Adds the deposit amount if it has not been credited.
   *   3. Records the deposit in creditedPayments.
 *
 * The balance increment and ledger marker are saved together.
 * This prevents duplicate credits if callbacks or browser polling
 * repeat, or if the server restarts after updating the wallet.
 */

async function creditWalletIfConfirmed(transaction, outcomeData) {
  if (!db || !transaction?.key) {
    return {
      credited: false,
      reason: "Transaction not found.",
    };
  }

  if (!isConfirmedSuccess(outcomeData)) {
    return {
      credited: false,
      reason: "PayM8 has not confirmed a successful payment.",
    };
  }

  const transactionKey = transaction.key;
  const transactionRef = db.ref(
    `paymentTransactions/${transactionKey}`
  );

  /*
   * Reload the authoritative transaction from Firebase instead
   * of relying only on an older in-memory copy.
   */

  const transactionSnapshot = await transactionRef.once("value");
  const currentTransaction = transactionSnapshot.val();

  if (!currentTransaction) {
    return {
      credited: false,
      reason: "Firebase transaction record does not exist.",
    };
  }

  const userId = String(currentTransaction.userId || "");
  const amountInCents = Number(currentTransaction.amountInCents);

  if (
    !userId ||
    userId === "GUEST" ||
    !Number.isInteger(amountInCents) ||
    amountInCents < 1
  ) {
    await transactionRef.update({
      status: "CREDIT_REVIEW_REQUIRED",
      creditError: "Missing or invalid user ID or deposit amount.",
      updatedAt: nowIso(),
    });

    return {
      credited: false,
      reason: "Missing or invalid user ID or deposit amount.",
    };
  }

  const depositAmount = amountInCents / 100;
  const walletRef = db.ref(`wallet/${userId}`);

  let alreadyCredited = false;
  let selectedBalanceField = "gems";

  const walletResult = await walletRef.transaction((current) => {
    const wallet =
      current && typeof current === "object" ? current : {};

    const ledger =
      wallet.creditedPayments &&
      typeof wallet.creditedPayments === "object"
        ? wallet.creditedPayments
        : {};

    /*
     * This marker and the balance change are in the SAME atomic
     * wallet transaction. A repeated request cannot add the same
     * deposit again.
     */

    if (ledger[transactionKey] === true) {
      alreadyCredited = true;
      return;
    }

    /*
     * Support the existing wallet balance field:
     * - use gems when the wallet already uses gems;
     * - use cashBalance when the wallet uses cashBalance only;
     * - default to gems for a new wallet.
     */

    selectedBalanceField =
      Object.prototype.hasOwnProperty.call(wallet, "gems")
        ? "gems"
        : Object.prototype.hasOwnProperty.call(wallet, "cashBalance")
          ? "cashBalance"
          : "gems";

    const oldBalance = Number(wallet[selectedBalanceField] || 0);

    if (!Number.isFinite(oldBalance)) {
      return;
    }

    return {
      ...wallet,

      [selectedBalanceField]: oldBalance + depositAmount,

      creditedPayments: {
        ...ledger,
        [transactionKey]: true,
      },

      updatedAt: nowIso(),
    };
  });

  if (!walletResult.committed) {
    /*
     * A transaction can be uncommitted because the deposit was
     * already in the ledger. Check the saved ledger before deciding
     * whether the wallet credit succeeded.
     */

    const freshWalletSnapshot = await walletRef.once("value");
    const freshWallet = freshWalletSnapshot.val() || {};
    const freshLedger = freshWallet.creditedPayments || {};

    if (freshLedger[transactionKey] === true) {
      const actualBalanceField =
        Object.prototype.hasOwnProperty.call(freshWallet, "gems")
          ? "gems"
          : Object.prototype.hasOwnProperty.call(
                freshWallet,
                "cashBalance"
              )
            ? "cashBalance"
            : "gems";

      await transactionRef.update({
        walletCredited: true,
        creditInProgress: false,
        walletCreditedAt:
          currentTransaction.walletCreditedAt || nowIso(),
        creditedAmountInCents: amountInCents,
        walletBalanceField: actualBalanceField,
        walletAfter: freshWallet,
        status: "COMPLETED",
        updatedAt: nowIso(),
      });

      console.log("Wallet deposit was already credited.");
      console.log("Transaction:", transactionKey);

      return {
        credited: true,
        alreadyCredited: true,
      };
    }

    await transactionRef.update({
      status: "CREDIT_REVIEW_REQUIRED",
      creditError: "Firebase wallet transaction was not committed.",
      updatedAt: nowIso(),
    });

    return {
      credited: false,
      reason: "Firebase wallet transaction was not committed.",
    };
  }

  /*
   * The balance and ledger have now been committed together.
   * Save the transaction status after the wallet update.
   */

  const walletAfter = walletResult.snapshot.val();

  await transactionRef.update({
    walletCredited: true,
    creditInProgress: false,
    walletCreditedAt: nowIso(),
    creditedAmountInCents: amountInCents,
    walletBalanceField: selectedBalanceField,
    walletAfter,
    status: "COMPLETED",
    updatedAt: nowIso(),
  });

  console.log("==============================================");
  console.log("WALLET CREDITED");
  console.log("User ID:", userId);
  console.log("Transaction:", transactionKey);
  console.log("Merchant reference:", currentTransaction.merchantReference);
  console.log("Amount cents:", amountInCents);
  console.log("Amount Rand:", depositAmount);
  console.log("Balance field:", selectedBalanceField);
  console.log(
    "New balance:",
    walletAfter?.[selectedBalanceField]
  );
  console.log("Already credited before this attempt:", alreadyCredited);
  console.log("==============================================");

  return {
    credited: true,
    alreadyCredited: false,
    balanceField: selectedBalanceField,
    balance: walletAfter?.[selectedBalanceField],
  };
}

/* =========================================================
   PAYMENT RECONCILIATION
   ========================================================= */

async function reconcilePayment(token) {
  const outcome = await getPaym8Outcome(token);

  let transaction = await findTransactionForOutcome(
    token,
    outcome.data
  );

  let creditResult = {
    credited: false,
    reason: "Payment is not confirmed yet.",
  };

  if (!transaction) {
    return {
      outcome,
      transaction: null,
      creditResult,
    };
  }

  await saveOutcome(transaction, outcome);

  if (isConfirmedSuccess(outcome.data)) {
    creditResult = await creditWalletIfConfirmed(
      transaction,
      outcome.data
    );
  } else if (isConfirmedFailure(outcome.data)) {
    /*
     * Faulted means no new wallet credit.
     * Never overwrite a genuine previous wallet credit.
     */

    const freshSnapshot = await db
      .ref(`paymentTransactions/${transaction.key}`)
      .once("value");

    const freshTransaction = freshSnapshot.val() || {};

    await db.ref(`paymentTransactions/${transaction.key}`).update({
      status:
        freshTransaction.walletCredited === true
          ? "COMPLETED"
          : "FAILED",
      walletCredited: freshTransaction.walletCredited === true,
      failedAt: nowIso(),
      updatedAt: nowIso(),
    });

    creditResult = {
      credited: freshTransaction.walletCredited === true,
      reason: "PayM8 reported a faulty or rejected payment.",
    };
  }

  const freshSnapshot = await db
    .ref(`paymentTransactions/${transaction.key}`)
    .once("value");

  transaction = {
    key: freshSnapshot.key,
    ...freshSnapshot.val(),
  };

  return {
    outcome,
    transaction,
    creditResult,
  };
}

/* =========================================================
   HEALTH CHECKS
   ========================================================= */

app.get("/health", (req, res) => {
  res.json({
    success: true,
    server: "online",
    firebaseConfigured: !!db,
    paym8Configured: !!PAYM8_AUTH_HEADER,
    merchantClientProfile: MERCHANT_CLIENT_PROFILE,
    merchantBranchProductNumber: MERCHANT_BRANCH_PRODUCT_NUMBER,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Muustandi backend is online.",
    firebaseConfigured: !!db,
    paym8Configured: !!PAYM8_AUTH_HEADER,
  });
});

app.get("/test-firebase", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Firebase is not configured.",
      });
    }

    const testId = `TEST-${Date.now()}`;

    await db.ref(`paymentTransactions/${testId}`).set({
      test: true,
      message: "Muustandi Firebase connection test",
      createdAt: nowIso(),
    });

    return res.json({
      success: true,
      message: "Firebase write successful.",
      testId,
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
   START 1VOUCHER DEPOSIT
   ========================================================= */

app.post("/deposit/1voucher", async (req, res) => {
  let merchantReference = null;

  try {
    console.log("==============================================");
    console.log("1VOUCHER DEPOSIT REQUEST");
    console.log("==============================================");

    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Firebase is not configured.",
      });
    }

    if (!PAYM8_AUTH_HEADER) {
      return res.status(500).json({
        success: false,
        error: "PayM8 authentication is not configured.",
      });
    }

    const amount = Number(req.body.amountInCents);
    const userId = String(req.body.userId || "");

    const firstName = String(
      req.body.firstName || req.body.name || "Gamer"
    );

    const lastName = String(
      req.body.lastName || req.body.surname || "Customer"
    );

    if (!Number.isInteger(amount) || amount < 500) {
      return res.status(400).json({
        success: false,
        error: "Minimum deposit amount is R5 (500 cents).",
      });
    }

    if (!userId || userId === "GUEST") {
      return res.status(400).json({
        success: false,
        error: "You must be logged in to make a deposit.",
      });
    }

    const clientIp = getClientIp(req);

    logTimezoneInformation();

    /*
     * PayM8 requires a short merchant reference.
     * Keep the reference below its documented 15-character limit.
     */

    merchantReference =
      `D${Date.now().toString().slice(-9)}${Math.floor(
        Math.random() * 90 + 10
      )}`;

    const callbackUrl =
      `${BACKEND_URL}/api/1voucher/callback?token={0}`;

    const resultRedirectUrl =
      `${BACKEND_URL}/wallet-success?token={0}`;

    const transactionData = {
      merchantReference,
      userId,
      amountInCents: amount,
      amountRand: amount / 100,
      firstName,
      lastName,
      status: "PENDING",
      walletCredited: false,
      creditInProgress: false,
      token: null,
      callbackToken: null,
      callbackReceived: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      serverTimezone: "Africa/Johannesburg",
      serverUtcTime: nowIso(),
      serverSouthAfricaTime: southAfricaTime(),
      clientIp,
    };

    await db
      .ref(`paymentTransactions/${merchantReference}`)
      .set(transactionData);

    /*
     * Preserve the PayM8 fields confirmed in the integration
     * instructions. Do not send the voucher PIN from this server.
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

    console.log("User ID:", userId);
    console.log("Amount cents:", amount);
    console.log("Merchant reference:", merchantReference);
    console.log(
      "Complete PayM8 request body:",
      JSON.stringify(payload, null, 2)
    );
    console.log("Sending PayM8 request...");

    const response = await fetch(PAYM8_SUBMIT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: PAYM8_AUTH_HEADER,
      },
      body: JSON.stringify(payload),
    });

    const raw = await response.text();

    let result = null;

    try {
      result = JSON.parse(raw);
    } catch {
      result = null;
    }

    console.log("PayM8 HTTP status:", response.status);
    console.log("PayM8 response:", raw);

    const data = result?.data;

    /*
     * This confirms only that PayM8 accepted the submission.
     * The wallet is NOT credited here.
     */

    if (
      !response.ok ||
      !data?.submitWasSuccessful ||
      !data?.redirectUri ||
      !data?.token
    ) {
      const message =
        data?.failureReason ||
        result?.description ||
        `PayM8 submission failed (HTTP ${response.status}).`;

      await db
        .ref(`paymentTransactions/${merchantReference}`)
        .update({
          status: "PAYM8_REQUEST_REJECTED",
          paym8HttpStatus: response.status,
          paym8Response: result || raw,
          error: message,
          updatedAt: nowIso(),
        });

      return res.status(400).json({
        success: false,
        error: message,
        merchantReference,
      });
    }

    const token = normalizeToken(data.token);

    await db
      .ref(`paymentTransactions/${merchantReference}`)
      .update({
        token,
        redirectUri: data.redirectUri,
        paym8Response: result,
        status: "PAYM8_SUBMITTED",
        updatedAt: nowIso(),
      });

    console.log("PayM8 submission accepted.");
    console.log("Payment token received:", !!token);

    return res.json({
      success: true,
      redirectUri: data.redirectUri,
      token,
      merchantReference,
      status: "PAYM8_SUBMITTED",
    });
  } catch (error) {
    console.error("1Voucher submission error:", error);

    if (db && merchantReference) {
      await db
        .ref(`paymentTransactions/${merchantReference}`)
        .update({
          status: "SUBMISSION_ERROR",
          error: error.message,
          updatedAt: nowIso(),
        })
        .catch(() => {});
    }

    return res.status(500).json({
      success: false,
      error: "Unable to start 1Voucher payment.",
      details: error.message,
    });
  }
});

/* =========================================================
   PAYM8 CALLBACK
   ========================================================= */

async function handlePayM8Callback(req, res) {
  console.log("==============================================");
  console.log("PAYM8 CALLBACK RECEIVED");
  console.log("==============================================");

  try {
    if (!db) {
      return res.status(500).send("Firebase unavailable");
    }

    const token = normalizeToken(
      req.query?.token ||
      req.body?.token ||
      req.body?.transactionToken
    );

    const suppliedReference =
      req.body?.merchantReference ||
      req.body?.merchantReferenceNumber ||
      req.query?.merchantReference ||
      null;

    console.log("Token received:", token ? "YES" : "NO");
    console.log(
      "Merchant reference received:",
      suppliedReference ? "YES" : "NO"
    );

    if (!token) {
      await db.ref(`paym8Callbacks/callback-${Date.now()}`).set({
        token: null,
        merchantReference: suppliedReference,
        method: req.method,
        query: req.query || {},
        body: req.body || {},
        receivedAt: nowIso(),
      });

      return res.status(200).send("OK");
    }

    await db.ref(`paym8Callbacks/${token}`).update({
      token,
      merchantReference: suppliedReference,
      method: req.method,
      query: req.query || {},
      body: req.body || {},
      receivedAt: nowIso(),
    });

    /*
     * Always verify the callback with PayM8's outcome endpoint.
     * A callback alone does not authorize wallet credit.
     */

    const outcome = await getPaym8Outcome(token);

    console.log("Callback outcome HTTP status:", outcome.httpStatus);
    console.log("Callback outcome:", outcome.raw);

    let transaction = await findTransactionForOutcome(
      token,
      outcome.data
    );

    if (transaction) {
      await db.ref(`paymentTransactions/${transaction.key}`).update({
        callbackReceived: true,
        callbackToken: token,
        callbackMerchantReference:
          suppliedReference ||
          outcome.data?.merchantReference ||
          null,
        callbackReceivedAt: nowIso(),
        updatedAt: nowIso(),
      });

      await saveOutcome(transaction, outcome);

      if (isConfirmedSuccess(outcome.data)) {
        await creditWalletIfConfirmed(transaction, outcome.data);
      } else if (isConfirmedFailure(outcome.data)) {
        const freshSnapshot = await db
          .ref(`paymentTransactions/${transaction.key}`)
          .once("value");

        const fresh = freshSnapshot.val() || {};

        await db.ref(`paymentTransactions/${transaction.key}`).update({
          status:
            fresh.walletCredited === true
              ? "COMPLETED"
              : "FAILED",
          walletCredited: fresh.walletCredited === true,
          failedAt: nowIso(),
          updatedAt: nowIso(),
        });
      }

      await db.ref(`paym8Callbacks/${token}`).update({
        reconciled: true,
        reconciledMerchantReference:
          transaction.merchantReference || transaction.key,
        reconciledAt: nowIso(),
      });

      console.log("Callback matched transaction:", transaction.key);
    } else {
      console.log(
        "Callback saved; transaction has not yet been matched."
      );
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("PayM8 callback error:", error);
    return res.status(500).send("ERROR");
  }
}

app.all("/api/1voucher/callback", handlePayM8Callback);

/* =========================================================
   CHECK PAYMENT STATUS AND CREDIT IF CONFIRMED
   ========================================================= */

app.get("/payment-status", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Firebase is not configured.",
      });
    }

    if (!PAYM8_AUTH_HEADER) {
      return res.status(500).json({
        success: false,
        error: "PayM8 authentication is not configured.",
      });
    }

    const token = normalizeToken(req.query.token);

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Missing payment token.",
      });
    }

    console.log("==============================================");
    console.log("PAYM8 PAYMENT STATUS CHECK");
    console.log("Token:", token);

    const result = await reconcilePayment(token);
    const outcome = result.outcome;
    const transaction = result.transaction;

    console.log("PayM8 HTTP status:", outcome.httpStatus);
    console.log("PayM8 outcome:", outcome.raw);
    console.log(
      "Merchant reference:",
      outcome.data?.merchantReference || "not returned"
    );
    console.log(
      "Outcome code:",
      outcome.data?.outcomeCode || "pending"
    );

    let status = "PENDING";

    if (transaction?.walletCredited === true) {
      status = "COMPLETED";
    } else if (isConfirmedFailure(outcome.data)) {
      status = "FAILED";
    } else if (
      transaction?.status === "CREDIT_REVIEW_REQUIRED"
    ) {
      status = "CREDIT_REVIEW_REQUIRED";
    }

    return res.json({
      success: outcome.ok,
      status,
      walletCredited: transaction?.walletCredited === true,
      token,
      merchantReference:
        outcome.data?.merchantReference ||
        transaction?.merchantReference ||
        null,
      outcomeCode: outcome.data?.outcomeCode || null,
      outcomeDescription: outcome.data?.outcomeDescription || "",
      lastCompletedStep: outcome.data?.lastCompletedStep ?? null,
      transactionFound: !!transaction,
      callbackReceived: transaction?.callbackReceived === true,
      paym8HttpStatus: outcome.httpStatus,
      outcome: outcome.data,
    });
  } catch (error) {
    console.error("Payment status error:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to check payment status.",
      details: error.message,
    });
  }
});

/* =========================================================
   PAYMENT RETURN PAGE
   ========================================================= */

app.get("/wallet-success", (req, res) => {
  const token = normalizeToken(req.query.token);
  const safeToken = JSON.stringify(token);
  const walletUrl = JSON.stringify(WALLET_URL);

  res.status(200).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>1Voucher Payment Verification</title>
<style>
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #001f3f;
  color: white;
  font-family: Arial, sans-serif;
  text-align: center;
}
.box {
  width: min(90%, 450px);
  box-sizing: border-box;
  padding: 28px;
  background: #001428;
  border-radius: 14px;
  box-shadow: 0 0 20px #0008;
}
h1 { color: #00e5ff; font-size: 24px; }
p { line-height: 1.55; overflow-wrap: anywhere; }
button {
  padding: 12px 20px;
  border: 0;
  border-radius: 7px;
  background: #00e5ff;
  color: #001f3f;
  font-weight: bold;
  cursor: pointer;
  margin-top: 12px;
}
</style>
</head>
<body>
<main class="box">
  <h1 id="heading">Checking your payment…</h1>
  <p id="message">
    Please wait while we verify the payment with PayM8.
    Do not enter the voucher again.
  </p>
  <p id="detail">Checking payment status…</p>
  <button id="returnButton" hidden>RETURN TO WALLET</button>
</main>

<script>
const token = ${safeToken};
const walletUrl = ${walletUrl};

let finished = false;
let attempts = 0;
const maxAttempts = 24;

function finish(kind, message) {
  if (finished) return;
  finished = true;

  document.getElementById("heading").textContent =
    kind === "success" ? "PAYMENT SUCCESSFUL" :
    kind === "failed" ? "PAYMENT FAILED" :
    "PAYMENT STATUS";

  document.getElementById("message").textContent = message;

  document.getElementById("detail").textContent =
    "Returning to your wallet in 5 seconds…";

  const button = document.getElementById("returnButton");
  button.hidden = false;

  button.onclick = () => {
    window.location.href =
      walletUrl + "?payment=" + encodeURIComponent(kind);
  };

  setTimeout(() => {
    window.location.href =
      walletUrl + "?payment=" + encodeURIComponent(kind);
  }, 5000);
}

async function checkPayment() {
  if (finished) return;

  attempts++;

  if (!token) {
    finish(
      "pending",
      "PayM8 did not return a payment token. Please check your transaction history."
    );
    return;
  }

  try {
    const response = await fetch(
      "/payment-status?token=" + encodeURIComponent(token),
      { cache: "no-store" }
    );

    const data = await response.json();

    console.log("PayM8 payment status:", data);

    if (
      data.walletCredited === true &&
      data.status === "COMPLETED"
    ) {
      finish(
        "success",
        "PayM8 confirmed the payment and your wallet has been credited."
      );
      return;
    }

    if (
      data.status === "FAILED" ||
      data.outcomeCode === "Faulted"
    ) {
      finish(
        "failed",
        "PayM8 reported: " +
        (data.outcomeDescription ||
          "The voucher was not accepted. Your wallet was not credited.")
      );
      return;
    }

    if (data.status === "CREDIT_REVIEW_REQUIRED") {
      finish(
        "pending",
        "The payment needs wallet-credit review. Please contact support and do not redeem the voucher again."
      );
      return;
    }

    if (attempts < maxAttempts) {
      document.getElementById("detail").textContent =
        "PayM8 is still processing. Checking again… (" +
        attempts + "/" + maxAttempts + ")";

      setTimeout(checkPayment, 3000);
    } else {
      finish(
        "pending",
        "The final payment status is still pending. Your wallet has not been confirmed as credited. Check your transaction history before trying again."
      );
    }
  } catch (error) {
    console.error("Payment verification error:", error);

    if (attempts < maxAttempts) {
      document.getElementById("detail").textContent =
        "Connection issue. Retrying payment verification…";

      setTimeout(checkPayment, 3000);
    } else {
      finish(
        "pending",
        "We could not confirm the final payment status. Check your wallet transaction history before trying again."
      );
    }
  }
}

checkPayment();
</script>
</body>
</html>`);
});

/* =========================================================
   DEBUG: PAYM8 OUTCOME
   ========================================================= */

app.get("/debug/payment-outcome", async (req, res) => {
  try {
    const token = normalizeToken(req.query.token);

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Token is required.",
      });
    }

    const outcome = await getPaym8Outcome(token);

    return res
      .status(outcome.httpStatus)
      .type("application/json")
      .send(outcome.raw);
  } catch (error) {
    console.error("Debug payment outcome error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   START SERVER
   ========================================================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
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
