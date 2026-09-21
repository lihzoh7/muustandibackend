const express = require("express");
const cors = require("cors");

const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ============================================================
// ENVIRONMENT VARIABLES
// ============================================================

const PAYM8_AUTH_HEADER = process.env.PAYM8_AUTH_HEADER;

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

// IMPORTANT: Your Firebase Realtime Database URL
const FIREBASE_DATABASE_URL =
  "https://tose-ccf8f-default-rtdb.europe-west1.firebasedatabase.app";

// ============================================================
// FIREBASE ADMIN INITIALIZATION
// ============================================================

let db = null;
let firebaseReady = false;

try {
  if (
    !FIREBASE_PROJECT_ID ||
    !FIREBASE_CLIENT_EMAIL ||
    !FIREBASE_PRIVATE_KEY
  ) {
    console.error("Firebase environment variables are missing.");
  } else {
    const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

    const firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey
      })
    });

    // Firebase Admin SDK v12+ modular Realtime Database API
    db = getDatabase(firebaseApp, FIREBASE_DATABASE_URL);

    firebaseReady = true;

    console.log("Firebase Admin initialized successfully.");
    console.log("Firebase Realtime Database connected.");
  }
} catch (error) {
  console.error("Firebase initialization failed:");
  console.error(error);
}

// ============================================================
// BASIC HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    server: "online",
    firebaseConfigured: firebaseReady,
    paym8Configured: !!PAYM8_AUTH_HEADER
  });
});

// ============================================================
// PAYM8 CONFIGURATION
// ============================================================

const PAYM8_PAYMENT_URL =
  "https://paym8online.com/PaymentsService/api/V1/ecommerce/Payment";

const PAYM8_OUTCOME_URL =
  "https://paym8online.com/PaymentsService/api/V1/ecommerce/GetPaymentOutcome";

// ============================================================
// HELPER: GENERATE MERCHANT REFERENCE
// ============================================================

function generateMerchantReference() {
  return (
    "DEP-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    Math.floor(Math.random() * 100000)
  );
}

// ============================================================
// HELPER: GET PAYM8 PAYMENT OUTCOME
// ============================================================

async function getPaym8Outcome(token) {
  if (!token) {
    throw new Error("Missing PayM8 token.");
  }

  if (!PAYM8_AUTH_HEADER) {
    throw new Error("PAYM8_AUTH_HEADER is not configured.");
  }

  const url = `${PAYM8_OUTCOME_URL}/${encodeURIComponent(token)}`;

  console.log("==============================================");
  console.log("PAYM8 OUTCOME REQUEST");
  console.log("==============================================");
  console.log("Token received:", token ? "YES" : "NO");
  console.log("URL:", url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: PAYM8_AUTH_HEADER,
      Accept: "application/json"
    }
  });

  const text = await response.text();

  console.log("PayM8 outcome HTTP status:", response.status);
  console.log("PayM8 outcome raw response:", text);

  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `PayM8 returned non-JSON response. HTTP ${response.status}: ${text}`
    );
  }

  return {
    httpStatus: response.status,
    data
  };
}

// ============================================================
// HELPER: INTERPRET PAYM8 OUTCOME
// ============================================================

function interpretPaym8Outcome(outcome) {
  const data =
    outcome &&
    outcome.data &&
    outcome.data.data
      ? outcome.data.data
      : outcome && outcome.data
        ? outcome.data
        : {};

  const result =
    outcome &&
    outcome.data &&
    typeof outcome.data.result !== "undefined"
      ? outcome.data.result
      : null;

  const resultToString =
    outcome &&
    outcome.data &&
    outcome.data.resultToString
      ? outcome.data.resultToString
      : null;

  const outcomeCode =
    typeof data.outcomeCode !== "undefined"
      ? data.outcomeCode
      : null;

  const outcomeDescription =
    typeof data.outcomeDescription !== "undefined"
      ? data.outcomeDescription
      : "";

  const lastCompletedStep =
    typeof data.lastCompletedStep !== "undefined"
      ? data.lastCompletedStep
      : null;

  const errorSourceSystem =
    typeof data.errorSourceSystem !== "undefined"
      ? data.errorSourceSystem
      : null;

  const errorCodes =
    Array.isArray(data.errorCodes)
      ? data.errorCodes
      : [];

  /*
   * STAGE 1:
   *
   * We deliberately DO NOT credit the wallet here.
   *
   * PayM8 currently returns:
   *
   * result: 0
   * lastCompletedStep: 1
   * outcomeCode: null
   *
   * That means we do not yet have a confirmed final
   * successful payment.
   */

  if (
    outcomeCode !== null &&
    outcomeCode !== undefined &&
    String(outcomeCode).trim() !== ""
  ) {
    return {
      status: "OUTCOME_RECEIVED",
      safeToCredit: false,
      result,
      resultToString,
      outcomeCode,
      outcomeDescription,
      lastCompletedStep,
      errorSourceSystem,
      errorCodes
    };
  }

  return {
    status: "PENDING",
    safeToCredit: false,
    result,
    resultToString,
    outcomeCode,
    outcomeDescription,
    lastCompletedStep,
    errorSourceSystem,
    errorCodes
  };
}

// ============================================================
// HELPER: FIND TRANSACTION BY TOKEN
// ============================================================

async function findTransactionByToken(token) {
  if (!db || !token) {
    return null;
  }

  const snapshot = await db
    .ref("paymentTransactions")
    .once("value");

  if (!snapshot.exists()) {
    return null;
  }

  const transactions = snapshot.val();

  for (const merchantReference of Object.keys(transactions)) {
    const transaction = transactions[merchantReference];

    if (
      transaction &&
      transaction.token &&
      String(transaction.token) === String(token)
    ) {
      return {
        merchantReference,
        ...transaction
      };
    }
  }

  return null;
}

// ============================================================
// 1VOUCHER DEPOSIT START
// ============================================================

app.post("/deposit/1voucher", async (req, res) => {
  try {
    console.log("==============================================");
    console.log("1VOUCHER DEPOSIT REQUEST");
    console.log("==============================================");

    const {
      amountInCents,
      userId,
      firstName,
      lastName
    } = req.body;

    console.log("User ID:", userId);
    console.log("Amount cents:", amountInCents);
    console.log("First name:", firstName);
    console.log("Last name:", lastName);

    if (!amountInCents || Number(amountInCents) <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid amountInCents."
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Missing userId."
      });
    }

    if (!PAYM8_AUTH_HEADER) {
      return res.status(500).json({
        success: false,
        error: "PAYM8_AUTH_HEADER is not configured on the server."
      });
    }

    if (!firebaseReady || !db) {
      return res.status(500).json({
        success: false,
        error: "Firebase is not configured correctly on the backend."
      });
    }

    const merchantReferenceNumber =
      generateMerchantReference();

    const transactionData = {
      merchantReferenceNumber,
      userId,
      amountInCents: Number(amountInCents),
      amountRand: Number(amountInCents) / 100,
      firstName: firstName || "",
      lastName: lastName || "",
      status: "CREATED",
      walletCredited: false,
      token: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // ========================================================
    // SAVE TRANSACTION BEFORE PAYM8
    // ========================================================

    await db
      .ref(`paymentTransactions/${merchantReferenceNumber}`)
      .set(transactionData);

    console.log(
      "Transaction saved:",
      merchantReferenceNumber
    );

    // ========================================================
    // PAYM8 REQUEST
    // ========================================================

    const paym8Payload = {
      merchantBranchProductNumber: "JQVSND",
      merchantClientProfile: "PMV00003",

      totalCostInCents: Number(amountInCents),

      transactionDescription: "1Voucher Wallet Deposit",

      merchantReferenceNumber,

      userHostAddress:
        req.headers["x-forwarded-for"] ||
        req.socket.remoteAddress ||
        "0.0.0.0",

      resultRedirectUrl:
        "https://muustandibackend.onrender.com/wallet-success?token={0}",

      callbackUrl:
        `https://muustandibackend.onrender.com/api/1voucher/callback?userId=${encodeURIComponent(
          userId
        )}&token={0}`,

      paymentChannels: [
        {
          channelName: "OneVoucher",
          settings: null
        }
      ],

      firstName: firstName || "",
      lastName: lastName || ""
    };

    console.log("==============================================");
    console.log("PAYM8 PAYMENT REQUEST");
    console.log("==============================================");

    console.log(
      JSON.stringify(paym8Payload, null, 2)
    );

    const paym8Response = await fetch(
      PAYM8_PAYMENT_URL,
      {
        method: "POST",
        headers: {
          Authorization: PAYM8_AUTH_HEADER,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(paym8Payload)
      }
    );

    const paym8Text = await paym8Response.text();

    console.log("PayM8 HTTP status:", paym8Response.status);
    console.log("PayM8 raw response:", paym8Text);

    let paym8Data;

    try {
      paym8Data = JSON.parse(paym8Text);
    } catch (error) {
      await db
        .ref(
          `paymentTransactions/${merchantReferenceNumber}`
        )
        .update({
          status: "PAYM8_INVALID_RESPONSE",
          updatedAt: new Date().toISOString(),
          paym8HttpStatus: paym8Response.status,
          paym8RawResponse: paym8Text
        });

      return res.status(502).json({
        success: false,
        error: "PayM8 returned an invalid response.",
        httpStatus: paym8Response.status
      });
    }

    console.log(
      "PayM8 parsed response:",
      JSON.stringify(paym8Data, null, 2)
    );

    // ========================================================
    // GET REDIRECT URI
    // ========================================================

    const redirectUri =
      paym8Data.redirectUri ||
      paym8Data.data?.redirectUri ||
      paym8Data.result?.redirectUri ||
      paym8Data.outcome?.redirectUri ||
      null;

    const token =
      paym8Data.token ||
      paym8Data.data?.token ||
      paym8Data.result?.token ||
      paym8Data.outcome?.token ||
      null;

    await db
      .ref(
        `paymentTransactions/${merchantReferenceNumber}`
      )
      .update({
        status:
          paym8Response.ok
            ? "PAYM8_CREATED"
            : "PAYM8_ERROR",

        token: token || null,

        paym8HttpStatus: paym8Response.status,

        paym8Response: paym8Data,

        updatedAt: new Date().toISOString()
      });

    if (!paym8Response.ok) {
      return res.status(502).json({
        success: false,
        error: "PayM8 rejected the payment request.",
        paym8HttpStatus: paym8Response.status,
        paym8Response: paym8Data
      });
    }

    if (!redirectUri) {
      console.error(
        "PayM8 did not return a redirectUri."
      );

      return res.status(502).json({
        success: false,
        error:
          "PayM8 accepted the request but did not return a redirect URL.",
        paym8Response: paym8Data
      });
    }

    console.log(
      "PayM8 redirect URI received."
    );

    return res.json({
      success: true,
      redirectUri,
      merchantReferenceNumber,
      token
    });

  } catch (error) {
    console.error(
      "1Voucher deposit error:"
    );
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// PAYM8 CALLBACK
// ============================================================

app.all(
  "/api/1voucher/callback",
  async (req, res) => {
    try {
      console.log("==============================================");
      console.log("PAYM8 CALLBACK RECEIVED");
      console.log("==============================================");

      console.log("Method:", req.method);
      console.log("Query:", req.query);
      console.log("Body:", req.body);

      const token =
        req.query.token ||
        req.body?.token ||
        req.body?.Token ||
        req.query.Token ||
        null;

      const userId =
        req.query.userId ||
        req.body?.userId ||
        req.body?.UserId ||
        null;

      console.log(
        "Token received:",
        token ? "YES" : "NO"
      );

      console.log(
        "User ID:",
        userId || "NOT PROVIDED"
      );

      if (!token) {
        console.error(
          "Callback received without token."
        );

        return res.status(400).json({
          received: false,
          error: "Missing token."
        });
      }

      // ======================================================
      // FIND TRANSACTION
      // ======================================================

      const transaction =
        await findTransactionByToken(token);

      if (!transaction) {
        console.error(
          "No transaction found for callback token."
        );

        return res.status(200).json({
          received: true,
          transactionFound: false
        });
      }

      console.log(
        "Transaction found:",
        transaction.merchantReferenceNumber
      );

      // ======================================================
      // CHECK PAYM8 OUTCOME
      // ======================================================

      let outcome;

      try {
        outcome = await getPaym8Outcome(token);
      } catch (error) {
        console.error(
          "Could not retrieve PayM8 outcome:"
        );
        console.error(error);

        await db
          .ref(
            `paymentTransactions/${transaction.merchantReferenceNumber}`
          )
          .update({
            status: "OUTCOME_CHECK_FAILED",
            callbackReceivedAt:
              new Date().toISOString(),
            outcomeError: error.message,
            updatedAt: new Date().toISOString()
          });

        return res.status(200).json({
          received: true,
          outcomeChecked: false
        });
      }

      const interpretation =
        interpretPaym8Outcome(outcome);

      await db
        .ref(
          `paymentTransactions/${transaction.merchantReferenceNumber}`
        )
        .update({
          status: interpretation.status,

          callbackReceivedAt:
            new Date().toISOString(),

          paym8OutcomeHttpStatus:
            outcome.httpStatus,

          paym8Outcome:
            outcome.data,

          interpretedOutcome:
            interpretation,

          updatedAt:
            new Date().toISOString()
        });

      console.log(
        "Callback transaction updated."
      );

      // ======================================================
      // IMPORTANT:
      // DO NOT CREDIT WALLET IN STAGE 1
      // ======================================================

      console.log(
        "STAGE 1: Wallet NOT credited."
      );

      return res.status(200).json({
        received: true,
        transactionFound: true,
        status: interpretation.status,
        safeToCredit: false
      });

    } catch (error) {
      console.error(
        "Callback processing error:"
      );
      console.error(error);

      return res.status(500).json({
        received: false,
        error: error.message
      });
    }
  }
);

// ============================================================
// PAYMENT STATUS
// ============================================================

app.get(
  "/payment-status",
  async (req, res) => {
    try {
      const token = req.query.token;

      if (!token) {
        return res.status(400).json({
          success: false,
          error: "Missing token."
        });
      }

      if (!db) {
        return res.status(500).json({
          success: false,
          error: "Firebase database is unavailable."
        });
      }

      const transaction =
        await findTransactionByToken(token);

      if (!transaction) {
        return res.json({
          success: true,
          found: false,
          status: "NOT_FOUND"
        });
      }

      // ======================================================
      // CHECK PAYM8 AGAIN
      // ======================================================

      let outcome;

      try {
        outcome = await getPaym8Outcome(token);
      } catch (error) {
        return res.json({
          success: true,
          found: true,
          status: "OUTCOME_CHECK_FAILED",
          merchantReferenceNumber:
            transaction.merchantReferenceNumber,
          error: error.message
        });
      }

      const interpretation =
        interpretPaym8Outcome(outcome);

      await db
        .ref(
          `paymentTransactions/${transaction.merchantReferenceNumber}`
        )
        .update({
          status: interpretation.status,

          paym8OutcomeHttpStatus:
            outcome.httpStatus,

          paym8Outcome:
            outcome.data,

          interpretedOutcome:
            interpretation,

          updatedAt:
            new Date().toISOString()
        });

      return res.json({
        success: true,
        found: true,

        merchantReferenceNumber:
          transaction.merchantReferenceNumber,

        userId:
          transaction.userId,

        amountInCents:
          transaction.amountInCents,

        amountRand:
          transaction.amountRand,

        status:
          interpretation.status,

        walletCredited:
          transaction.walletCredited === true,

        safeToCredit:
          false,

        paym8: {
          httpStatus:
            outcome.httpStatus,

          result:
            interpretation.result,

          resultToString:
            interpretation.resultToString,

          outcomeCode:
            interpretation.outcomeCode,

          outcomeDescription:
            interpretation.outcomeDescription,

          lastCompletedStep:
            interpretation.lastCompletedStep,

          errorSourceSystem:
            interpretation.errorSourceSystem,

          errorCodes:
            interpretation.errorCodes
        }
      });

    } catch (error) {
      console.error(
        "Payment status error:"
      );
      console.error(error);

      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// ============================================================
// WALLET SUCCESS PAGE
// ============================================================

app.get(
  "/wallet-success",
  async (req, res) => {
    const token = req.query.token || "";

    const safeToken =
      String(token)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>Payment Verification</title>

<style>

body {
  margin: 0;
  min-height: 100vh;
  background: #001f3f;
  color: white;
  font-family: Arial, sans-serif;

  display: flex;
  justify-content: center;
  align-items: center;
}

.box {
  width: 90%;
  max-width: 500px;

  background: #003b66;

  border-radius: 16px;

  padding: 30px;

  text-align: center;

  box-sizing: border-box;
}

h1 {
  margin-top: 0;
}

#status {
  margin-top: 20px;
  line-height: 1.6;
}

button {
  margin-top: 25px;

  padding: 12px 22px;

  border: none;
  border-radius: 8px;

  background: white;
  color: #001f3f;

  font-size: 16px;
  font-weight: bold;

  cursor: pointer;
}

</style>
</head>

<body>

<div class="box">

<h1>Payment Verification</h1>

<div id="status">
Checking your payment...
</div>

<button onclick="goBack()">
RETURN TO WALLET
</button>

</div>

<script>

const token = "${safeToken}";

let attempts = 0;

const maxAttempts = 10;

async function checkPayment() {

  attempts++;

  if (!token) {

    document.getElementById("status").innerHTML =
      "No payment token was received.";

    return;
  }

  try {

    const response = await fetch(
      "/payment-status?token=" +
      encodeURIComponent(token)
    );

    const data = await response.json();

    console.log("Payment status:", data);

    if (
      data.success &&
      data.found &&
      data.status === "PENDING"
    ) {

      document.getElementById("status").innerHTML =
        "Your payment was received by the payment system.<br><br>" +
        "We are still waiting for the final payment result.<br>" +
        "Please do not enter the voucher again.";

    } else if (
      data.success &&
      data.found &&
      data.status === "OUTCOME_RECEIVED"
    ) {

      document.getElementById("status").innerHTML =
        "Paym8 returned a payment outcome.<br><br>" +
        "The Muustandi wallet will only be credited after the final " +
        "payment result has been confirmed.";

    } else if (
      data.status === "OUTCOME_CHECK_FAILED"
    ) {

      document.getElementById("status").innerHTML =
        "We are temporarily unable to check the payment result.<br><br>" +
        "Please wait and try again.";

    } else {

      document.getElementById("status").innerHTML =
        "We are verifying the transaction...";

    }

  } catch (error) {

    console.error(error);

    document.getElementById("status").innerHTML =
      "We are verifying the transaction...";

  }

  if (attempts < maxAttempts) {

    setTimeout(
      checkPayment,
      3000
    );

  }

}

function goBack() {

  window.location.href =
    "https://muustandigaming.github.io/muustandi-gaming/wallet.html";

}

checkPayment();

</script>

</body>
</html>
`);
  }
);

// ============================================================
// DEBUG PAYM8 OUTCOME
// ============================================================

app.get(
  "/debug/payment-outcome",
  async (req, res) => {

    try {

      const token = req.query.token;

      if (!token) {
        return res.status(400).json({
          success: false,
          error:
            "Use /debug/payment-outcome?token=YOUR_TOKEN"
        });
      }

      const outcome =
        await getPaym8Outcome(token);

      const interpretation =
        interpretPaym8Outcome(outcome);

      return res.json({
        success: true,

        paym8HttpStatus:
          outcome.httpStatus,

        outcome:
          outcome.data,

        interpretation
      });

    } catch (error) {

      console.error(
        "Debug outcome error:"
      );

      console.error(error);

      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {

  res.json({
    success: true,
    message: "Muustandi backend is online."
  });

});
// ============================================================
// TEMPORARY FIREBASE WRITE TEST
// ============================================================

app.get("/test-firebase", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Firebase database is not available."
      });
    }

    const testId = "TEST-" + Date.now();

    const testData = {
      test: true,
      message: "Muustandi Firebase connection test",
      createdAt: new Date().toISOString()
    };

    await db
      .ref(`paymentTransactions/${testId}`)
      .set(testData);

    console.log("Firebase test transaction written:", testId);

    return res.json({
      success: true,
      message: "Firebase write successful.",
      testId
    });

  } catch (error) {
    console.error("Firebase write test failed:");
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {

  console.log(
    `Server listening on port ${PORT}`
  );

});
