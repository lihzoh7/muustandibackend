const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

/* =========================================================
   ENVIRONMENT VARIABLES
   ========================================================= */

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

const PAYM8_AUTH_HEADER = process.env.PAYM8_AUTH_HEADER;

/* =========================================================
   FIREBASE DATABASE
   ========================================================= */

const DATABASE_URL =
  "https://tose-ccf8f-default-rtdb.europe-west1.firebasedatabase.app";

/* =========================================================
   PAYM8 CONFIGURATION
   ========================================================= */

const PAYM8_SUBMIT_URL =
  "https://paym8online.com/PaymentsService/api/v1/ecommerce/SubmitPaymentRequest";

const PAYM8_OUTCOME_URL =
  "https://paym8online.com/PaymentsService/api/v1/ecommerce/GetPaymentOutcome";

const MERCHANT_CLIENT_PROFILE = "PMV-03";

const MERCHANT_BRANCH_PRODUCT_NUMBER = "JQVSND";

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
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
    databaseURL: DATABASE_URL,
  });

  db = getDatabase(firebaseApp);

  console.log("Firebase Admin initialized successfully.");
  console.log("Firebase Realtime Database connected.");
} catch (error) {
  console.error("Firebase initialization error:", error);
}

/* =========================================================
   HELPER FUNCTIONS
   ========================================================= */

function normalizeToken(token) {
  if (!token) {
    return "";
  }

  return String(token).trim();
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }

  return (
    req.socket?.remoteAddress ||
    req.ip ||
    "127.0.0.1"
  );
}

/* =========================================================
   FIND TRANSACTION BY PAYM8 TOKEN
   ========================================================= */

async function findTransactionByToken(token) {
  if (!db || !token) {
    return null;
  }

  try {
    const snapshot = await db
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
   FIND TRANSACTION BY MERCHANT REFERENCE
   ========================================================= */

async function findTransactionByMerchantReference(
  merchantReference
) {
  if (!db || !merchantReference) {
    return null;
  }

  try {
    const snapshot = await db
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
   FIND RECENT USER TRANSACTION
   ========================================================= */

async function findRecentUserTransaction(userId) {
  if (!db || !userId) {
    return null;
  }

  try {
    const snapshot = await db
      .ref("paymentTransactions")
      .orderByChild("userId")
      .equalTo(userId)
      .once("value");

    if (!snapshot.exists()) {
      return null;
    }

    let latest = null;

    snapshot.forEach((child) => {
      const value = child.val();

      if (!latest) {
        latest = {
          key: child.key,
          ...value,
        };
        return;
      }

      const latestTime = new Date(
        latest.createdAt || 0
      ).getTime();

      const currentTime = new Date(
        value.createdAt || 0
      ).getTime();

      if (currentTime > latestTime) {
        latest = {
          key: child.key,
          ...value,
        };
      }
    });

    return latest;
  } catch (error) {
    console.error(
      "findRecentUserTransaction error:",
      error
    );

    return null;
  }
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
    merchantBranchProductNumber:
      MERCHANT_BRANCH_PRODUCT_NUMBER,
  });
});

/* =========================================================
   ROOT
   ========================================================= */

app.get("/", (req, res) => {
  res.json({
    status: "Muustandi backend online",
    firebaseConfigured: !!db,
    paym8Configured: !!PAYM8_AUTH_HEADER,
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
      createdAt: new Date().toISOString(),
      message: "Muustandi Firebase connection test",
      test: true,
    };

    await db
      .ref(`paymentTransactions/${testId}`)
      .set(data);

    res.json({
      success: true,
      testId,
      data,
    });
  } catch (error) {
    console.error("Firebase test error:", error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   1VOUCHER DEPOSIT
   ========================================================= */

app.post("/deposit/1voucher", async (req, res) => {
  console.log("");
  console.log("==============================================");
  console.log("1VOUCHER DEPOSIT REQUEST");
  console.log("==============================================");

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
    const userId = req.body.userId;

    const firstName =
      req.body.firstName ||
      req.body.name ||
      "Gamer";

    const lastName =
      req.body.lastName ||
      req.body.surname ||
      "Customer";

    console.log("User ID:", userId);
    console.log("Amount cents:", amount);

    /* -------------------------------------------------------
       VALIDATION
       ------------------------------------------------------- */

    if (!Number.isFinite(amount)) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount.",
      });
    }

    if (amount < 500) {
      return res.status(400).json({
        success: false,
        message: "Minimum 1Voucher amount is R5.",
      });
    }

    if (!userId || userId === "GUEST") {
      return res.status(400).json({
        success: false,
        message: "Valid user ID is required.",
      });
    }

    /* -------------------------------------------------------
       CLIENT IP
       ------------------------------------------------------- */

    const clientIp = getClientIp(req);

    /* -------------------------------------------------------
       MERCHANT REFERENCE
       ------------------------------------------------------- */

    const merchantReference =
      `DEP-${Date.now().toString().slice(-8)}`;

    console.log(
      "Merchant reference:",
      merchantReference
    );

    /* -------------------------------------------------------
       PAYM8 CALLBACK / RESULT URLS
       ------------------------------------------------------- */

    const callbackUrl =
      "https://muustandibackend.onrender.com/api/1voucher/callback?token={0}";

    const resultRedirectUrl =
      "https://muustandibackend.onrender.com/wallet-success?token={0}";

    console.log("Callback URL:", callbackUrl);
    console.log("Result redirect:", resultRedirectUrl);

    /* -------------------------------------------------------
       SAVE INITIAL TRANSACTION
       ------------------------------------------------------- */

    const transactionData = {
      userId: String(userId),
      amountInCents: amount,
      merchantReference: merchantReference,
      status: "PENDING",
      walletCredited: false,
      createdAt: new Date().toISOString(),
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

    /* -------------------------------------------------------
       PAYM8 UNIQUE CUSTOMER ID
       ------------------------------------------------------- */

    const uniqueCustomerId = String(userId);

    /* -------------------------------------------------------
       PAYM8 REQUEST PAYLOAD
       
       IMPORTANT:
       We are NOT adding a guessed date/time field here.
       Paul needs to identify the exact field and format.
       ------------------------------------------------------- */

    const payload = {
      merchantBranchProductNumber:
        MERCHANT_BRANCH_PRODUCT_NUMBER,

      totalCostInCents: amount,

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
          channelName: "OneVoucher",
          settings: null,
        },
      ],

      merchantClientProfile:
        MERCHANT_CLIENT_PROFILE,

      uniqueCustomerId:
        uniqueCustomerId,

      FirstName:
        firstName,

      Lastname:
        lastName,
    };

    /* =====================================================
       IMPORTANT DEBUG LOG FOR PAUL
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
      JSON.stringify(payload, null, 2)
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

    /* -------------------------------------------------------
       PAYM8 REQUEST
       ------------------------------------------------------- */

    console.log("PAYM8 PAYMENT REQUEST");
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
      "UniqueCustomerId:",
      uniqueCustomerId
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

    const response = await fetch(
      PAYM8_SUBMIT_URL,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": PAYM8_AUTH_HEADER,
        },

        body: JSON.stringify(payload),
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

    console.log(rawResponse);

    let paym8Response = null;

    try {
      paym8Response =
        JSON.parse(rawResponse);
    } catch (error) {
      console.error(
        "Could not parse PayM8 response as JSON."
      );
    }

    /* -------------------------------------------------------
       PAYM8 RESPONSE FAILED
       ------------------------------------------------------- */

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
          status: "PAYM8_SUBMIT_FAILED",
          paym8HttpStatus: response.status,
          paym8Response:
            paym8Response || rawResponse,
          updatedAt:
            new Date().toISOString(),
        });

      return res.status(400).json({
        success: false,
        message:
          paym8Response?.data?.failureReason ||
          paym8Response?.description ||
          "PayM8 payment request failed.",
        paym8Response,
      });
    }

    /* -------------------------------------------------------
       PAYM8 TOKEN
       ------------------------------------------------------- */

    const token =
      paym8Response.data.token ||
      null;

    const redirectUri =
      paym8Response.data.redirectUri ||
      null;

    console.log(
      "PayM8 payment request successful."
    );

    console.log(
      "PayM8 token received:",
      token ? "YES" : "NO"
    );

    console.log(
      "PayM8 redirect created:",
      redirectUri ? "YES" : "NO"
    );

    /* -------------------------------------------------------
       SAVE PAYM8 TOKEN
       ------------------------------------------------------- */

    await db
      .ref(
        `paymentTransactions/${merchantReference}`
      )
      .update({
        token: token,
        redirectUri: redirectUri,
        paym8Response: paym8Response,
        status: "PAYM8_SUBMITTED",
        updatedAt:
          new Date().toISOString(),
      });

    /* -------------------------------------------------------
       RETURN TO FRONTEND
       ------------------------------------------------------- */

    return res.json({
      success: true,

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
      success: false,
      message:
        "Unable to start 1Voucher payment.",
      error: error.message,
    });
  }
});

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
        return res.status(500).send("Firebase unavailable");
      }

      const callbackToken =
        normalizeToken(
          req.query.token ||
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
        callbackToken ? "YES" : "NO"
      );

      console.log(
        "Merchant reference received:",
        merchantReference ? "YES" : "NO"
      );

      console.log(
        "Callback token:",
        callbackToken || "NONE"
      );

      const callbackId =
        callbackToken ||
        `callback-${Date.now()}`;

      const callbackData = {
        token: callbackToken || null,
        merchantReference:
          merchantReference || null,

        method: req.method,

        query: req.query || {},

        body: req.body || {},

        receivedAt:
          new Date().toISOString(),
      };

      await db
        .ref(
          `paym8Callbacks/${callbackId}`
        )
        .set(callbackData);

      console.log(
        "PayM8 callback saved."
      );

      /* -----------------------------------------------------
         TRY TOKEN LOOKUP
         ----------------------------------------------------- */

      let transaction = null;

      if (callbackToken) {
        for (let attempt = 1; attempt <= 5; attempt++) {
          transaction =
            await findTransactionByToken(
              callbackToken
            );

          console.log(
            `Callback token lookup attempt ${attempt}:`,
            transaction
              ? "MATCH FOUND"
              : "no match yet"
          );

          if (transaction) {
            break;
          }

          await new Promise(
            (resolve) =>
              setTimeout(resolve, 1000)
          );
        }
      }

      /* -----------------------------------------------------
         TRY MERCHANT REFERENCE LOOKUP
         ----------------------------------------------------- */

      if (!transaction && merchantReference) {
        transaction =
          await findTransactionByMerchantReference(
            merchantReference
          );
      }

      /* -----------------------------------------------------
         UPDATE TRANSACTION
         ----------------------------------------------------- */

      if (transaction?.key) {
        await db
          .ref(
            `paymentTransactions/${transaction.key}`
          )
          .update({
            callbackReceived: true,
            callbackToken:
              callbackToken || null,
            callbackMerchantReference:
              merchantReference || null,
            callbackReceivedAt:
              new Date().toISOString(),
          });
      }

      /*
       * IMPORTANT:
       *
       * Do NOT credit the wallet here.
       *
       * The callback by itself does not prove that
       * the 1Voucher payment was successfully completed.
       *
       * Final Paym8 outcome must be checked first.
       */

      return res.status(200).send("OK");
    } catch (error) {
      console.error(
        "PayM8 callback error:",
        error
      );

      return res.status(500).send("ERROR");
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
          success: false,
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
          success: false,
          message:
            "Payment token is required.",
        });
      }

      /* -----------------------------------------------------
         FIND ORIGINAL TRANSACTION
         ----------------------------------------------------- */

      let transaction =
        await findTransactionByToken(
          token
        );

      /* -----------------------------------------------------
         CALLBACK LOOKUP
         ----------------------------------------------------- */

      let callbackRecord = null;

      const callbackSnapshot =
        await db
          .ref("paym8Callbacks")
          .orderByChild("token")
          .equalTo(token)
          .once("value");

      if (callbackSnapshot.exists()) {
        callbackSnapshot.forEach(
          (child) => {
            callbackRecord = {
              key: child.key,
              ...child.val(),
            };
          }
        );
      }

      /* -----------------------------------------------------
         GET PAYM8 OUTCOME
         ----------------------------------------------------- */

      const outcomeResponse =
        await fetch(
          `${PAYM8_OUTCOME_URL}/${encodeURIComponent(
            token
          )}`,
          {
            method: "GET",

            headers: {
              "Accept": "application/json",
              "Authorization":
                PAYM8_AUTH_HEADER,
            },
          }
        );

      const outcomeRaw =
        await outcomeResponse.text();

      console.log(
        "HTTP status:",
        outcomeResponse.status
      );

      console.log(
        "Outcome:"
      );

      console.log(
        outcomeRaw
      );

      let outcome = null;

      try {
        outcome =
          JSON.parse(outcomeRaw);
      } catch (error) {
        console.error(
          "Could not parse PayM8 outcome."
        );
      }

      const outcomeData =
        outcome?.data || null;

      const merchantReference =
        outcomeData?.merchantReference ||
        transaction?.merchantReference ||
        callbackRecord?.merchantReference ||
        null;

      const outcomeCode =
        outcomeData?.outcomeCode ??
        null;

      const outcomeDescription =
        outcomeData?.outcomeDescription ||
        "";

      /* -----------------------------------------------------
         IF TOKEN DID NOT MATCH TRANSACTION,
         USE MERCHANT REFERENCE
         ----------------------------------------------------- */

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
            "Transaction matched using merchant reference from Paym8 outcome:",
            merchantReference
          );
        }
      }

      /* -----------------------------------------------------
         SAVE OUTCOME
         ----------------------------------------------------- */

      if (transaction?.key) {
        await db
          .ref(
            `paymentTransactions/${transaction.key}`
          )
          .update({
            lastPaym8Outcome:
              outcome || outcomeRaw,

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
              null,

            outcomeCheckedAt:
              new Date().toISOString(),
          });
      }

      console.log(
        "Merchant reference from outcome:",
        merchantReference
      );

      console.log(
        "Outcome code:",
        outcomeCode
      );

      console.log(
        "Outcome description:",
        outcomeDescription
      );

      if (!callbackRecord) {
        console.log(
          "Callback record found: NO initially"
        );
      } else {
        console.log(
          "Callback record found: YES"
        );
      }

      /* -----------------------------------------------------
         IMPORTANT:
         DO NOT CREDIT WALLET YET.
         ----------------------------------------------------- */

      return res.json({
        success: true,

        status: "PENDING",

        walletCredited:
          transaction?.walletCredited
            ? true
            : false,

        token: token,

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
      });
    } catch (error) {
      console.error(
        "Payment status error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to check payment status.",
        error: error.message,
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
  <title>Payment Verification</title>

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
      box-shadow: 0 2px 10px rgba(0,0,0,0.08);
    }

    #status {
      margin-top: 20px;
      line-height: 1.6;
    }
  </style>
</head>

<body>

<div class="box">

  <h2>We are checking your payment...</h2>

  <p>
    Please wait while we verify your
    1Voucher payment.
  </p>

  <p>
    Do not submit the voucher again.
  </p>

  <div id="status">
    Checking PayM8...
  </div>

</div>

<script>

const token =
  ${JSON.stringify(token)};

async function checkPayment() {

  if (!token) {
    document.getElementById("status").innerHTML =
      "Payment token is missing.";
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

    if (
      data.outcomeCode === "Faulted"
    ) {

      document.getElementById(
        "status"
      ).innerHTML =
        "This voucher cannot be processed now. " +
        "Try another voucher or contact PAYM8/1Voucher.";

      return;
    }

    if (
      data.walletCredited === true
    ) {

      document.getElementById(
        "status"
      ).innerHTML =
        "Payment successful. Your wallet has been credited.";

      return;
    }

    document.getElementById(
      "status"
    ).innerHTML =
      "Payment is still being verified...";

  } catch (error) {

    console.error(
      "Payment verification error:",
      error
    );

    document.getElementById(
      "status"
    ).innerHTML =
      "We are still checking your payment. " +
      "Please wait.";
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
          success: false,
          message:
            "Token is required.",
        });
      }

      const response =
        await fetch(
          `${PAYM8_OUTCOME_URL}/${encodeURIComponent(
            token
          )}`,
          {
            method: "GET",

            headers: {
              "Accept": "application/json",
              "Authorization":
                PAYM8_AUTH_HEADER,
            },
          }
        );

      const raw =
        await response.text();

      res.status(response.status).send(raw);
    } catch (error) {
      console.error(
        "Debug outcome error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
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
  }
);
