const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");

const app = express();

/* =========================================================
   EXPRESS
   ========================================================= */

app.use(cors({ origin: true }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

/* =========================================================
   ENVIRONMENT VARIABLES
   ========================================================= */

const FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID;

const FIREBASE_CLIENT_EMAIL =
  process.env.FIREBASE_CLIENT_EMAIL;

const FIREBASE_PRIVATE_KEY =
  process.env.FIREBASE_PRIVATE_KEY;

const PAYM8_AUTH_HEADER =
  process.env.PAYM8_AUTH_HEADER;

/*
 * We explicitly set the application timezone for Node.
 *
 * IMPORTANT:
 * This does NOT add a made-up timezone field to the
 * PAYM8 request.
 *
 * It simply makes the server's local timezone Africa/Johannesburg
 * so our diagnostics are unambiguous.
 */
process.env.TZ = "Africa/Johannesburg";

/* =========================================================
   FIREBASE DATABASE
   ========================================================= */

const DATABASE_URL =
  "https://tose-ccf8f-default-rtdb.europe-west1.firebasedatabase.app";

/* =========================================================
   PAYM8
   ========================================================= */

const PAYM8_SUBMIT_URL =
  "https://paym8online.com/PaymentsService/api/v1/ecommerce/SubmitPaymentRequest";

const PAYM8_OUTCOME_URL =
  "https://paym8online.com/PaymentsService/api/v1/ecommerce/GetPaymentOutcome";

const MERCHANT_CLIENT_PROFILE =
  "PMV-03";

const MERCHANT_BRANCH_PRODUCT_NUMBER =
  "JQVSND";

/*
 * These are deliberately constants rather than values supplied
 * by the browser.
 *
 * The browser should only tell us:
 * - userId
 * - amount
 * - name/surname
 */

/* =========================================================
   FIREBASE INITIALIZATION
   ========================================================= */

let firebaseApp = null;
let db = null;

try {
  if (
    !FIREBASE_PROJECT_ID ||
    !FIREBASE_CLIENT_EMAIL ||
    !FIREBASE_PRIVATE_KEY
  ) {
    throw new Error(
      "Missing Firebase environment variables."
    );
  }

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,

      clientEmail:
        FIREBASE_CLIENT_EMAIL,

      privateKey:
        FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),

    databaseURL:
      DATABASE_URL,
  });

  db = getDatabase(firebaseApp);

  console.log(
    "Firebase Admin initialized successfully."
  );

  console.log(
    "Firebase Realtime Database connected."
  );
} catch (error) {
  console.error(
    "Firebase initialization error:",
    error
  );
}

/* =========================================================
   GENERAL HELPERS
   ========================================================= */

function normalizeToken(value) {
  if (!value) {
    return "";
  }

  return String(value).trim();
}

function getClientIp(req) {
  const forwarded =
    req.headers["x-forwarded-for"];

  if (forwarded) {
    return String(forwarded)
      .split(",")[0]
      .trim();
  }

  return (
    req.socket?.remoteAddress ||
    req.ip ||
    "127.0.0.1"
  );
}

function nowIso() {
  return new Date().toISOString();
}

function southAfricaTime() {
  return new Intl.DateTimeFormat(
    "en-ZA",
    {
      timeZone: "Africa/Johannesburg",
      dateStyle: "full",
      timeStyle: "medium",
    }
  ).format(new Date());
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

/* =========================================================
   PAYM8 TIMEZONE DIAGNOSTICS
   ========================================================= */

/*
 * Paul's question was:
 *
 * "what time zone are you sending your API call from?"
 *
 * We answer that clearly in the logs.
 *
 * We DO NOT add an undocumented date/time property
 * to the PAYM8 payload.
 */

function logTimezoneInformation() {
  console.log(
    "=============================================="
  );

  console.log(
    "SERVER TIMEZONE INFORMATION"
  );

  console.log(
    "=============================================="
  );

  console.log(
    "Node TZ:",
    process.env.TZ
  );

  console.log(
    "Server timezone:",
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );

  console.log(
    "Server current UTC time:",
    nowIso()
  );

  console.log(
    "Server current South Africa time:",
    southAfricaTime()
  );

  console.log(
    "=============================================="
  );
}

/* =========================================================
   FIND TRANSACTION BY PAYM8 TOKEN
   ========================================================= */

async function findTransactionByToken(
  token
) {
  if (!db || !token) {
    return null;
  }

  try {
    const snapshot =
      await db
        .ref("paymentTransactions")
        .orderByChild("token")
        .equalTo(token)
        .once("value");

    if (!snapshot.exists()) {
      return null;
    }

    let result = null;

    snapshot.forEach((child) => {
      result = {
        key: child.key,
        ...child.val(),
      };
    });

    return result;
  } catch (error) {
    console.error(
      "findTransactionByToken error:",
      error
    );

    return null;
  }
}

/* =========================================================
   FIND TRANSACTION BY CALLBACK TOKEN
   ========================================================= */

async function findTransactionByCallbackToken(
  token
) {
  if (!db || !token) {
    return null;
  }

  try {
    const snapshot =
      await db
        .ref("paymentTransactions")
        .orderByChild("callbackToken")
        .equalTo(token)
        .once("value");

    if (!snapshot.exists()) {
      return null;
    }

    let result = null;

    snapshot.forEach((child) => {
      result = {
        key: child.key,
        ...child.val(),
      };
    });

    return result;
  } catch (error) {
    console.error(
      "findTransactionByCallbackToken error:",
      error
    );

    return null;
  }
}

/* =========================================================
   FIND TRANSACTION BY MERCHANT REFERENCE
   ========================================================= */

async function findTransactionByMerchantReference(
  merchantReference
) {
  if (!db || !merchantReference) {
    return null;
  }

  try {
    const snapshot =
      await db
        .ref("paymentTransactions")
        .orderByChild("merchantReference")
        .equalTo(merchantReference)
        .once("value");

    if (!snapshot.exists()) {
      return null;
    }

    let result = null;

    snapshot.forEach((child) => {
      result = {
        key: child.key,
        ...child.val(),
      };
    });

    return result;
  } catch (error) {
    console.error(
      "findTransactionByMerchantReference error:",
      error
    );

    return null;
  }
}

/* =========================================================
   FIND CALLBACK BY TOKEN
   ========================================================= */

async function findCallbackByToken(token) {
  if (!db || !token) {
    return null;
  }

  try {
    const snapshot =
      await db
        .ref("paym8Callbacks")
        .orderByChild("token")
        .equalTo(token)
        .once("value");

    if (!snapshot.exists()) {
      return null;
    }

    let result = null;

    snapshot.forEach((child) => {
      result = {
        key: child.key,
        ...child.val(),
      };
    });

    return result;
  } catch (error) {
    console.error(
      "findCallbackByToken error:",
      error
    );

    return null;
  }
}

/* =========================================================
   GET PAYM8 PAYMENT OUTCOME
   ========================================================= */

async function getPaym8Outcome(token) {
  if (!token) {
    throw new Error(
      "PAYM8 token is required."
    );
  }

  const url =
    `${PAYM8_OUTCOME_URL}/${encodeURIComponent(token)}`;

  console.log(
    "PAYM8 outcome URL:",
    url
  );

  const response =
    await fetch(
      url,
      {
        method: "GET",

        headers: {
          Accept:
            "application/json",

          Authorization:
            PAYM8_AUTH_HEADER,
        },
      }
    );

  const raw =
    await response.text();

  let parsed = null;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(
      "Could not parse PAYM8 outcome response."
    );
  }

  return {
    httpStatus:
      response.status,

    ok:
      response.ok,

    raw,

    data:
      parsed?.data || null,

    response:
      parsed,
  };
}

/* =========================================================
   UPDATE TRANSACTION FROM PAYM8 OUTCOME
   ========================================================= */

async function savePaym8Outcome(
  transaction,
  outcomeResult
) {
  if (!db || !transaction?.key) {
    return;
  }

  const outcomeData =
    outcomeResult?.data || null;

  await db
    .ref(
      `paymentTransactions/${transaction.key}`
    )
    .update({
      lastPaym8Outcome:
        outcomeResult?.response ||
        outcomeResult?.raw ||
        null,

      paym8OutcomeHttpStatus:
        outcomeResult?.httpStatus ??
        null,

      outcomeCode:
        outcomeData?.outcomeCode ??
        null,

      outcomeDescription:
        outcomeData?.outcomeDescription ||
        "",

      lastCompletedStep:
        outcomeData?.lastCompletedStep ??
        null,

      errorSourceSystem:
        outcomeData?.errorSourceSystem ??
        null,

      errorCodes:
        outcomeData?.errorCodes ??
        [],

      outcomeCheckedAt:
        nowIso(),
    });
}

/* =========================================================
   WALLET CREDIT
   ========================================================= */

/*
 * IMPORTANT:
 *
 * We do NOT credit the wallet merely because:
 *
 * - SubmitPaymentRequest returned HTTP 200
 * - submitWasSuccessful was true
 * - callback was received
 *
 * Those events only prove that the payment process was
 * initiated / communicated.
 *
 * The wallet must only be credited after PAYM8 reports a
 * successful final outcome.
 *
 * Because your current PAYM8 logs have NOT shown us the
 * actual successful outcome code yet, this function only
 * acts when the backend receives an explicitly successful
 * outcome.
 *
 * The accepted successful indicators below are deliberately
 * conservative.
 */

function isSuccessfulPaym8Outcome(
  outcomeData
) {
  if (!outcomeData) {
    return false;
  }

  const code =
    outcomeData.outcomeCode;

  const description =
    String(
      outcomeData.outcomeDescription ||
      ""
    ).toLowerCase();

  /*
   * We accept a clearly successful textual outcome.
   *
   * We DO NOT treat null as success.
   */

  if (
    code === "Successful" ||
    code === "Success" ||
    code === "Completed" ||
    code === "Complete"
  ) {
    return true;
  }

  /*
   * Some integrations may return a successful
   * description while the code is different.
   *
   * Only accept this when there is an explicit
   * success word and no fault/error indication.
   */

  if (
    description &&
    (
      description === "successful" ||
      description === "success" ||
      description === "completed" ||
      description === "complete"
    )
  ) {
    return true;
  }

  return false;
}

/* =========================================================
   CREDIT WALLET ON CONFIRMED SUCCESS
   ========================================================= */

async function creditWalletIfConfirmed(
  transaction,
  outcomeData
) {
  if (!db || !transaction?.key) {
    return {
      credited: false,
      reason:
        "Transaction not available.",
    };
  }

  if (
    !isSuccessfulPaym8Outcome(
      outcomeData
    )
  ) {
    return {
      credited: false,
      reason:
        "PAYM8 outcome is not confirmed successful.",
    };
  }

  if (
    transaction.walletCredited === true
  ) {
    return {
      credited: true,
      alreadyCredited: true,
      reason:
        "Wallet was already credited.",
    };
  }

  const userId =
    transaction.userId;

  const amountInCents =
    Number(
      transaction.amountInCents
    );

  if (!userId) {
    return {
      credited: false,
      reason:
        "Transaction has no userId.",
    };
  }

  if (
    !Number.isFinite(
      amountInCents
    ) ||
    amountInCents <= 0
  ) {
    return {
      credited: false,
      reason:
        "Transaction amount is invalid.",
    };
  }

  /*
   * Use a Firebase transaction so repeated callbacks or
   * repeated payment-status requests cannot credit the
   * wallet twice.
   */

  const walletRef =
    db.ref(
      `wallet/${userId}`
    );

  let walletAfter = null;

  await walletRef.transaction(
    (current) => {
      const wallet =
        current &&
        typeof current === "object"
          ? current
          : {};

      const currentGems =
        Number(wallet.gems || 0);

      const currentLives =
        Number(wallet.lives || 0);

      /*
       * The existing wallet system uses gems and lives.
       *
       * A payment deposits the paid Rand value as gems.
       * Example:
       * R5 = 500 cents = 5 gems.
       */

      const depositAmount =
        amountInCents / 100;

      return {
        ...wallet,

        gems:
          currentGems +
          depositAmount,

        lives:
          currentLives,

        updatedAt:
          nowIso(),
      };
    },
    (error, committed, snapshot) => {
      if (error) {
        throw error;
      }

      if (!committed) {
        throw new Error(
          "Firebase wallet transaction was not committed."
        );
      }

      walletAfter =
        snapshot?.val() || null;
    }
  );

  await db
    .ref(
      `paymentTransactions/${transaction.key}`
    )
    .update({
      walletCredited: true,

      walletCreditedAt:
        nowIso(),

      creditedAmountInCents:
        amountInCents,

      walletAfter:
        walletAfter,

      status:
        "COMPLETED",
    });

  console.log(
    "=============================================="
  );

  console.log(
    "WALLET CREDITED"
  );

  console.log(
    "=============================================="
  );

  console.log(
    "User ID:",
    userId
  );

  console.log(
    "Amount cents:",
    amountInCents
  );

  console.log(
    "Amount Rand:",
    amountInCents / 100
  );

  console.log(
    "=============================================="
  );

  return {
    credited: true,
    alreadyCredited: false,
  };
}

/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      status:
        "ok",

      firebaseConfigured:
        !!db,

      paym8Configured:
        !!PAYM8_AUTH_HEADER,

      merchantClientProfile:
        MERCHANT_CLIENT_PROFILE,

      merchantBranchProductNumber:
        MERCHANT_BRANCH_PRODUCT_NUMBER,

      serverTimezone:
        Intl.DateTimeFormat()
          .resolvedOptions()
          .timeZone,

      nodeTimezone:
        process.env.TZ,
    });
  }
);

/* =========================================================
   ROOT
   ========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      status:
        "Muustandi backend online",

      firebaseConfigured:
        !!db,

      paym8Configured:
        !!PAYM8_AUTH_HEADER,

      serverTimezone:
        Intl.DateTimeFormat()
          .resolvedOptions()
          .timeZone,
    });
  }
);

/* =========================================================
   FIREBASE TEST
   ========================================================= */

app.get(
  "/test-firebase",
  async (req, res) => {
    try {
      if (!db) {
        return res.status(500).json({
          success: false,
          message:
            "Firebase database is not available.",
        });
      }

      const testId =
        `TEST-${Date.now()}`;

      const data = {
        createdAt:
          nowIso(),

        message:
          "Muustandi Firebase connection test",

        test:
          true,
      };

      await db
        .ref(
          `paymentTransactions/${testId}`
        )
        .set(data);

      return res.json({
        success: true,
        testId,
        data,
      });
    } catch (error) {
      console.error(
        "Firebase test error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   1VOUCHER DEPOSIT
   ========================================================= */

app.post(
  "/deposit/1voucher",
  async (req, res) => {
    console.log("");

    console.log(
      "=============================================="
    );

    console.log(
      "1VOUCHER DEPOSIT REQUEST"
    );

    console.log(
      "=============================================="
    );

    try {
      if (!db) {
        return res.status(500).json({
          success: false,
          message:
            "Firebase database is not available.",
        });
      }

      if (!PAYM8_AUTH_HEADER) {
        return res.status(500).json({
          success: false,
          message:
            "PayM8 is not configured.",
        });
      }

      const amount =
        Number(
          req.body.amountInCents
        );

      const userId =
        req.body.userId;

      const firstName =
        req.body.firstName ||
        req.body.name ||
        "Gamer";

      const lastName =
        req.body.lastName ||
        req.body.surname ||
        "Customer";

      console.log(
        "User ID:",
        userId
      );

      console.log(
        "Amount cents:",
        amount
      );

      /* -----------------------------------------------------
         VALIDATION
         ----------------------------------------------------- */

      if (!Number.isFinite(amount)) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid amount.",
        });
      }

      if (amount < 500) {
        return res.status(400).json({
          success: false,
          message:
            "Minimum 1Voucher amount is R5.",
        });
      }

      if (
        !userId ||
        userId === "GUEST"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Valid user ID is required.",
        });
      }

      /* -----------------------------------------------------
         CLIENT IP
         ----------------------------------------------------- */

      const clientIp =
        getClientIp(req);

      console.log(
        "Client IP:",
        clientIp
      );

      /* -----------------------------------------------------
         TIMEZONE INFORMATION
         ----------------------------------------------------- */

      logTimezoneInformation();

      /*
       * IMPORTANT:
       *
       * There is intentionally NO uniqueCustomerId
       * anywhere in this PAYM8 request.
       *
       * There is also intentionally NO invented
       * transactionDate / dateTime / timezone field.
       */

      /* -----------------------------------------------------
         MERCHANT REFERENCE
         ----------------------------------------------------- */

      const merchantReference =
        `DEP-${Date.now().toString().slice(-8)}`;

      console.log(
        "Merchant reference:",
        merchantReference
      );

      /* -----------------------------------------------------
         CALLBACK / RESULT URLS
         ----------------------------------------------------- */

      const callbackUrl =
        "https://muustandibackend.onrender.com/api/1voucher/callback?token={0}";

      const resultRedirectUrl =
        "https://muustandibackend.onrender.com/wallet-success?token={0}";

      console.log(
        "Callback URL:",
        callbackUrl
      );

      console.log(
        "Result redirect:",
        resultRedirectUrl
      );

      /* -----------------------------------------------------
         SAVE INITIAL TRANSACTION
         ----------------------------------------------------- */

      const transactionData = {
        userId:
          String(userId),

        amountInCents:
          amount,

        merchantReference:
          merchantReference,

        status:
          "PENDING",

        walletCredited:
          false,

        createdAt:
          nowIso(),

        serverTimezone:
          Intl.DateTimeFormat()
            .resolvedOptions()
            .timeZone,

        serverUtcTime:
          nowIso(),

        serverSouthAfricaTime:
          southAfricaTime(),

        clientIp:
          clientIp,

        firstName:
          firstName,

        lastName:
          lastName,
      };

      await db
        .ref(
          `paymentTransactions/${merchantReference}`
        )
        .set(transactionData);

      console.log(
        "Transaction saved:",
        merchantReference
      );

      /* =====================================================
         PAYM8 REQUEST PAYLOAD

         THIS IS THE IMPORTANT PART.

         uniqueCustomerId IS NOT INCLUDED.

         No undocumented timezone/date property is included.
         ===================================================== */

      const payload = {
        merchantBranchProductNumber:
          MERCHANT_BRANCH_PRODUCT_NUMBER,

        totalCostInCents:
          amount,

        transactionDescription:
          "1Voucher Wallet Deposit",

        merchantReferenceNumber:
          merchantReference,

        userHostAddress:
          clientIp,

        resultRedirectUrl:
          resultRedirectUrl,

        callbackUrl:
          callbackUrl,

        paymentChannels: [
          {
            channelName:
              "OneVoucher",

            settings:
              null,
          },
        ],

        merchantClientProfile:
          MERCHANT_CLIENT_PROFILE,

        FirstName:
          firstName,

        Lastname:
          lastName,
      };

      /* =====================================================
         COMPLETE PAYM8 POST REQUEST BODY
         ===================================================== */

      console.log("");

      console.log(
        "=============================================="
      );

      console.log(
        "COMPLETE PAYM8 POST REQUEST BODY"
      );

      console.log(
        "=============================================="
      );

      console.log(
        JSON.stringify(
          payload,
          null,
          2
        )
      );

      console.log(
        "=============================================="
      );

      console.log(
        "END COMPLETE PAYM8 POST REQUEST BODY"
      );

      console.log(
        "=============================================="
      );

      console.log("");

      /* =====================================================
         EXPLICIT PAUL DEBUG INFORMATION
         ===================================================== */

      console.log(
        "PAYM8 TEST CONFIGURATION"
      );

      console.log(
        "uniqueCustomerId: NOT SENT"
      );

      console.log(
        "timezone:",
        Intl.DateTimeFormat()
          .resolvedOptions()
          .timeZone
      );

      console.log(
        "UTC timestamp:",
        nowIso()
      );

      console.log(
        "South Africa timestamp:",
        southAfricaTime()
      );

      console.log(
        "merchantClientProfile:",
        MERCHANT_CLIENT_PROFILE
      );

      console.log(
        "merchantBranchProductNumber:",
        MERCHANT_BRANCH_PRODUCT_NUMBER
      );

      /* =====================================================
         PAYM8 SUBMIT PAYMENT
         ===================================================== */

      console.log(
        "=============================================="
      );

      console.log(
        "PAYM8 PAYMENT REQUEST"
      );

      console.log(
        "=============================================="
      );

      console.log(
        "PayM8 endpoint: SubmitPaymentRequest"
      );

      console.log(
        "Merchant reference:",
        merchantReference
      );

      console.log(
        "Amount cents:",
        amount
      );

      console.log(
        "MerchantClientProfile:",
        MERCHANT_CLIENT_PROFILE
      );

      console.log(
        "UniqueCustomerId: NOT SENT"
      );

      console.log(
        "Callback URL:",
        callbackUrl
      );

      console.log(
        "Result redirect:",
        resultRedirectUrl
      );

      console.log(
        "Sending PayM8 payload..."
      );

      const response =
        await fetch(
          PAYM8_SUBMIT_URL,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",

              Accept:
                "application/json",

              Authorization:
                PAYM8_AUTH_HEADER,
            },

            body:
              JSON.stringify(
                payload
              ),
          }
        );

      const rawResponse =
        await response.text();

      console.log(
        "PayM8 HTTP status:",
        response.status
      );

      console.log(
        "PayM8 raw response:"
      );

      console.log(
        rawResponse
      );

      let paym8Response =
        null;

      try {
        paym8Response =
          JSON.parse(
            rawResponse
          );
      } catch (error) {
        console.error(
          "Could not parse PayM8 response as JSON."
        );
      }

      /* =====================================================
         PAYM8 SUBMIT FAILED
         ===================================================== */

      if (
        !response.ok ||
        !paym8Response ||
        !paym8Response.data ||
        !paym8Response.data.submitWasSuccessful
      ) {
        await db
          .ref(
            `paymentTransactions/${merchantReference}`
          )
          .update({
            status:
              "PAYM8_SUBMIT_FAILED",

            paym8HttpStatus:
              response.status,

            paym8Response:
              paym8Response ||
              rawResponse,

            updatedAt:
              nowIso(),
          });

        return res.status(400).json({
          success: false,

          message:
            paym8Response?.data
              ?.failureReason ||
            paym8Response?.description ||
            "PayM8 payment request failed.",

          paym8Response:
            paym8Response,
        });
      }

      /* =====================================================
         PAYM8 TOKEN / REDIRECT
         ===================================================== */

      const token =
        normalizeToken(
          paym8Response.data.token
        );

      const redirectUri =
        paym8Response.data.redirectUri ||
        null;

      console.log(
        "PayM8 payment request successful."
      );

      console.log(
        "PayM8 token received:",
        token
          ? "YES"
          : "NO"
      );

      console.log(
        "PayM8 redirect created:",
        redirectUri
          ? "YES"
          : "NO"
      );

      /* -----------------------------------------------------
         SAVE PAYM8 SUBMISSION
         ----------------------------------------------------- */

      await db
        .ref(
          `paymentTransactions/${merchantReference}`
        )
        .update({
          token:
            token,

          redirectUri:
            redirectUri,

          paym8Response:
            paym8Response,

          status:
            "PAYM8_SUBMITTED",

          updatedAt:
            nowIso(),
        });

      /* -----------------------------------------------------
         RETURN TO FRONTEND
         ----------------------------------------------------- */

      return res.json({
        success:
          true,

        merchantReference:
          merchantReference,

        token:
          token,

        redirectUri:
          redirectUri,

        status:
          "PAYM8_SUBMITTED",
      });
    } catch (error) {
      console.error(
        "1Voucher deposit error:",
        error
      );

      return res.status(500).json({
        success:
          false,

        message:
          "Unable to start 1Voucher payment.",

        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   PAYM8 CALLBACK
   ========================================================= */

app.all(
  "/api/1voucher/callback",
  async (req, res) => {
    console.log("");

    console.log(
      "=============================================="
    );

    console.log(
      "PAYM8 CALLBACK RECEIVED"
    );

    console.log(
      "=============================================="
    );

    try {
      if (!db) {
        return res
          .status(500)
          .send(
            "Firebase unavailable"
          );
      }

      const callbackToken =
        normalizeToken(
          req.query?.token ||
          req.body?.token ||
          req.body?.transactionToken
        );

      const merchantReference =
        req.body?.merchantReference ||
        req.body?.merchantReferenceNumber ||
        req.query?.merchantReference ||
        null;

      console.log(
        "Token received:",
        callbackToken
          ? "YES"
          : "NO"
      );

      console.log(
        "Merchant reference received:",
        merchantReference
          ? "YES"
          : "NO"
      );

      console.log(
        "Callback token:",
        callbackToken ||
        "NONE"
      );

      const callbackId =
        callbackToken ||
        `callback-${Date.now()}`;

      const callbackData = {
        token:
          callbackToken ||
          null,

        merchantReference:
          merchantReference ||
          null,

        method:
          req.method,

        query:
          req.query ||
          {},

        body:
          req.body ||
          {},

        receivedAt:
          nowIso(),
      };

      await db
        .ref(
          `paym8Callbacks/${callbackId}`
        )
        .set(callbackData);

      console.log(
        "PayM8 callback saved."
      );

      /* =====================================================
         FIND TRANSACTION
         ===================================================== */

      let transaction =
        null;

      /*
       * First, callback token.
       */

      if (callbackToken) {
        transaction =
          await findTransactionByToken(
            callbackToken
          );

        if (!transaction) {
          transaction =
            await findTransactionByCallbackToken(
              callbackToken
            );
        }
      }

      /*
       * Then merchant reference.
       */

      if (
        !transaction &&
        merchantReference
      ) {
        transaction =
          await findTransactionByMerchantReference(
            merchantReference
          );
      }

      /*
       * Save callback information.
       */

      if (transaction?.key) {
        await db
          .ref(
            `paymentTransactions/${transaction.key}`
          )
          .update({
            callbackReceived:
              true,

            callbackToken:
              callbackToken ||
              null,

            callbackMerchantReference:
              merchantReference ||
              null,

            callbackReceivedAt:
              nowIso(),
          });

        console.log(
          "Transaction matched from callback."
        );

        console.log(
          "Transaction key:",
          transaction.key
        );
      } else {
        console.log(
          "No transaction matched directly from callback."
        );
      }

      /*
       * IMPORTANT:
       *
       * We now attempt to obtain the final outcome.
       *
       * If the callback token is different from the original
       * submit token, we use the callback token first because
       * that is the token PAYM8 sent to this callback endpoint.
       *
       * We NEVER assume that merely receiving the callback means
       * the payment succeeded.
       */

      let outcomeResult =
        null;

      if (callbackToken) {
        try {
          outcomeResult =
            await getPaym8Outcome(
              callbackToken
            );

          console.log(
            "Callback PAYM8 outcome:"
          );

          console.log(
            JSON.stringify(
              outcomeResult,
              null,
              2
            )
          );
        } catch (error) {
          console.error(
            "Could not retrieve PAYM8 callback outcome:",
            error.message
          );
        }
      }

      /*
       * If we found the transaction, save the outcome.
       */

      if (
        transaction &&
        outcomeResult
      ) {
        await savePaym8Outcome(
          transaction,
          outcomeResult
        );

        const outcomeData =
          outcomeResult.data;

        /*
         * Credit only if PAYM8 explicitly confirms success.
         */

        if (
          isSuccessfulPaym8Outcome(
            outcomeData
          )
        ) {
          try {
            await creditWalletIfConfirmed(
              transaction,
              outcomeData
            );
          } catch (creditError) {
            console.error(
              "Wallet credit error:",
              creditError
            );
          }
        }
      }

      /*
       * PAYM8 callback must receive HTTP 200.
       */

      return res
        .status(200)
        .send("OK");
    } catch (error) {
      console.error(
        "PayM8 callback error:",
        error
      );

      return res
        .status(500)
        .send("ERROR");
    }
  }
);

/* =========================================================
   PAYMENT STATUS
   ========================================================= */

app.get(
  "/payment-status",
  async (req, res) => {
    console.log("");

    console.log(
      "=============================================="
    );

    console.log(
      "PAYM8 PAYMENT OUTCOME"
    );

    console.log(
      "=============================================="
    );

    try {
      if (!db) {
        return res.status(500).json({
          success:
            false,

          message:
            "Firebase database is not available.",
        });
      }

      const token =
        normalizeToken(
          req.query.token
        );

      console.log(
        "Token:",
        token
      );

      if (!token) {
        return res.status(400).json({
          success:
            false,

          message:
            "Payment token is required.",
        });
      }

      /* =====================================================
         FIND TRANSACTION BY ORIGINAL TOKEN
         ===================================================== */

      let transaction =
        await findTransactionByToken(
          token
        );

      /* =====================================================
         IF ORIGINAL TOKEN DOES NOT MATCH,
         TRY CALLBACK TOKEN
         ===================================================== */

      if (!transaction) {
        transaction =
          await findTransactionByCallbackToken(
            token
          );
      }

      /* =====================================================
         CALLBACK RECORD
         ===================================================== */

      let callbackRecord =
        await findCallbackByToken(
          token
        );

      /* =====================================================
         GET PAYM8 OUTCOME
         ===================================================== */

      const outcomeResult =
        await getPaym8Outcome(
          token
        );

      console.log(
        "HTTP status:",
        outcomeResult.httpStatus
      );

      console.log(
        "Outcome:"
      );

      console.log(
        outcomeResult.raw
      );

      const outcomeData =
        outcomeResult.data;

      /* =====================================================
         MERCHANT REFERENCE
         ===================================================== */

      const merchantReference =
        outcomeData?.merchantReference ||
        transaction?.merchantReference ||
        callbackRecord?.merchantReference ||
        null;

      console.log(
        "Merchant reference from outcome:",
        merchantReference
      );

      /* =====================================================
         IF TOKEN DID NOT MATCH,
         USE MERCHANT REFERENCE
         ===================================================== */

      if (
        !transaction &&
        merchantReference
      ) {
        transaction =
          await findTransactionByMerchantReference(
            merchantReference
          );

        if (transaction) {
          console.log(
            "Transaction matched using merchant reference from PayM8 outcome:",
            merchantReference
          );
        }
      }

      /* =====================================================
         FIND CALLBACK AGAIN AFTER MERCHANT REFERENCE
         ===================================================== */

      if (
        !callbackRecord &&
        transaction?.callbackToken
      ) {
        callbackRecord =
          await findCallbackByToken(
            transaction.callbackToken
          );
      }

      /* =====================================================
         SAVE OUTCOME
         ===================================================== */

      if (transaction?.key) {
        await savePaym8Outcome(
          transaction,
          outcomeResult
        );

        /*
         * Refresh transaction after update.
         */

        const refreshed =
          await db
            .ref(
              `paymentTransactions/${transaction.key}`
            )
            .once("value");

        if (refreshed.exists()) {
          transaction = {
            key:
              refreshed.key,

            ...refreshed.val(),
          };
        }

        /* ===================================================
           CREDIT WALLET ONLY ON CONFIRMED SUCCESS
           =================================================== */

        if (
          isSuccessfulPaym8Outcome(
            outcomeData
          )
        ) {
          try {
            await creditWalletIfConfirmed(
              transaction,
              outcomeData
            );
          } catch (creditError) {
            console.error(
              "Wallet credit error:",
              creditError
            );
          }

          const refreshedAfterCredit =
            await db
              .ref(
                `paymentTransactions/${transaction.key}`
              )
              .once("value");

          if (
            refreshedAfterCredit.exists()
          ) {
            transaction = {
              key:
                refreshedAfterCredit.key,

              ...refreshedAfterCredit.val(),
            };
          }
        }
      }

      const outcomeCode =
        outcomeData?.outcomeCode ??
        null;

      const outcomeDescription =
        outcomeData?.outcomeDescription ||
        "";

      console.log(
        "Outcome code:",
        outcomeCode
      );

      console.log(
        "Outcome description:",
        outcomeDescription
      );

      console.log(
        "Callback record found:",
        callbackRecord
          ? "YES"
          : "NO"
      );

      /* =====================================================
         DETERMINE STATUS
         ===================================================== */

      let status =
        "PENDING";

      if (
        outcomeCode ===
        "Faulted"
      ) {
        status =
          "FAILED";
      } else if (
        transaction?.walletCredited === true
      ) {
        status =
          "COMPLETED";
      }

      return res.json({
        success:
          true,

        status:
          status,

        walletCredited:
          transaction?.walletCredited === true,

        token:
          token,

        merchantReference:
          merchantReference,

        outcomeCode:
          outcomeCode,

        outcomeDescription:
          outcomeDescription,

        lastCompletedStep:
          outcomeData?.lastCompletedStep ??
          null,

        errorSourceSystem:
          outcomeData?.errorSourceSystem ??
          null,

        errorCodes:
          outcomeData?.errorCodes ??
          [],

        transactionFound:
          !!transaction,

        callbackReceived:
          !!callbackRecord,

        paym8Outcome:
          outcomeData,

        serverTimezone:
          Intl.DateTimeFormat()
            .resolvedOptions()
            .timeZone,

        serverUtcTime:
          nowIso(),

        serverSouthAfricaTime:
          southAfricaTime(),
      });
    } catch (error) {
      console.error(
        "Payment status error:",
        error
      );

      return res.status(500).json({
        success:
          false,

        message:
          "Unable to check payment status.",

        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   WALLET SUCCESS PAGE
   ========================================================= */

app.get(
  "/wallet-success",
  (req, res) => {
    const token =
      normalizeToken(
        req.query.token
      );

    const html = `
<!DOCTYPE html>
<html>
<head>

<meta charset="UTF-8">

<title>
Payment Verification
</title>

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<style>

body {
  font-family: Arial, sans-serif;
  background: #f5f5f5;
  text-align: center;
  padding: 40px 20px;
}

.box {
  max-width: 500px;
  margin: auto;
  background: white;
  padding: 30px;
  border-radius: 12px;
  box-shadow:
    0 2px 10px rgba(0,0,0,0.08);
}

#status {
  margin-top: 20px;
  line-height: 1.6;
}

</style>

</head>

<body>

<div class="box">

<h2>
Checking your payment...
</h2>

<p>
Please wait while we verify your
1Voucher payment with PAYM8.
</p>

<p>
Do not submit the voucher again.
</p>

<div id="status">
Checking PAYM8...
</div>

</div>

<script>

const token =
${JSON.stringify(token)};

let finished = false;

async function checkPayment() {

  if (finished) {
    return;
  }

  if (!token) {

    document.getElementById(
      "status"
    ).innerHTML =
      "Payment token is missing.";

    finished = true;

    return;
  }

  try {

    const response =
      await fetch(
        "/payment-status?token=" +
        encodeURIComponent(token)
      );

    const data =
      await response.json();

    console.log(
      "Payment status:",
      data
    );

    /*
     * CONFIRMED SUCCESS
     */

    if (
      data.walletCredited === true &&
      data.status === "COMPLETED"
    ) {

      document.getElementById(
        "status"
      ).innerHTML =
        "<strong>Payment successful.</strong><br>" +
        "Your wallet has been credited.";

      finished = true;

      return;
    }

    /*
     * CONFIRMED FAILURE
     */

    if (
      data.status === "FAILED" ||
      data.outcomeCode === "Faulted"
    ) {

      document.getElementById(
        "status"
      ).innerHTML =
        "This voucher cannot be processed now.<br>" +
        "PAYM8/1Voucher reported:<br>" +
        "<strong>" +
        (
          data.outcomeDescription ||
          "Payment faulted."
        ) +
        "</strong>";

      finished = true;

      return;
    }

    /*
     * STILL WAITING
     */

    document.getElementById(
      "status"
    ).innerHTML =
      "PAYM8 is still processing the payment.<br>" +
      "Please wait...";

  } catch (error) {

    console.error(
      "Payment verification error:",
      error
    );

    document.getElementById(
      "status"
    ).innerHTML =
      "We are still checking your payment.<br>" +
      "Please wait...";
  }
}

checkPayment();

setInterval(
  checkPayment,
  5000
);

</script>

</body>
</html>
`;

    res.send(html);
  }
);

/* =========================================================
   DEBUG PAYMENT OUTCOME
   ========================================================= */

app.get(
  "/debug/payment-outcome",
  async (req, res) => {
    try {
      const token =
        normalizeToken(
          req.query.token
        );

      if (!token) {
        return res.status(400).json({
          success:
            false,

          message:
            "Token is required.",
        });
      }

      const result =
        await getPaym8Outcome(
          token
        );

      return res
        .status(
          result.httpStatus
        )
        .send(
          result.raw
        );
    } catch (error) {
      console.error(
        "Debug outcome error:",
        error
      );

      return res.status(500).json({
        success:
          false,

        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   DEBUG CONFIGURATION
   ========================================================= */

app.get(
  "/debug/paym8-config",
  (req, res) => {
    res.json({
      paym8Configured:
        !!PAYM8_AUTH_HEADER,

      merchantClientProfile:
        MERCHANT_CLIENT_PROFILE,

      merchantBranchProductNumber:
        MERCHANT_BRANCH_PRODUCT_NUMBER,

      submitUrl:
        PAYM8_SUBMIT_URL,

      outcomeUrl:
        PAYM8_OUTCOME_URL,

      uniqueCustomerId:
        "NOT USED",

      timezone:
        Intl.DateTimeFormat()
          .resolvedOptions()
          .timeZone,

      nodeTimezone:
        process.env.TZ,

      utcNow:
        nowIso(),

      southAfricaNow:
        southAfricaTime(),
    });
  }
);

/* =========================================================
   SERVER
   ========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Server listening on port ${PORT}`
    );

    console.log(
      "Node timezone:",
      process.env.TZ
    );

    console.log(
      "Resolved timezone:",
      Intl.DateTimeFormat()
        .resolvedOptions()
        .timeZone
    );

    console.log(
      "PAYM8 uniqueCustomerId: NOT USED"
    );

    console.log(
      "PAYM8 merchant client profile:",
      MERCHANT_CLIENT_PROFILE
    );

    console.log(
      "PAYM8 merchant branch product number:",
      MERCHANT_BRANCH_PRODUCT_NUMBER
    );
  }
);
