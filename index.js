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
   CONSTANTS
   ========================================================= */

const FIREBASE_DATABASE_URL =
  "https://tose-ccf8f-default-rtdb.europe-west1.firebasedatabase.app";

const PAYM8_SUBMIT_URL =
  "https://paym8online.com/PaymentsService/api/v1/ecommerce/SubmitPaymentRequest";

const PAYM8_OUTCOME_URL =
  "https://paym8online.com/PaymentsService/api/v1/ecommerce/GetPaymentOutcome";

/*
   IMPORTANT:
   This is the value Paul confirmed is correct for
   the MerchantClientProfile in the successful example.
*/
const MERCHANT_CLIENT_PROFILE = "PMV-03";

/*
   This is your PayM8 merchant branch/product number.
*/
const MERCHANT_BRANCH_PRODUCT_NUMBER = "JQVSND";

/* =========================================================
   FIREBASE INITIALIZATION
   ========================================================= */

let db = null;
let firebaseReady = false;

try {
  if (
    FIREBASE_PROJECT_ID &&
    FIREBASE_CLIENT_EMAIL &&
    FIREBASE_PRIVATE_KEY
  ) {
    const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

    const firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey
      }),
      databaseURL: FIREBASE_DATABASE_URL
    });

    db = getDatabase(firebaseApp);

    firebaseReady = true;

    console.log("Firebase Admin initialized successfully.");
    console.log("Firebase Realtime Database connected.");
  } else {
    console.error(
      "Firebase environment variables are missing."
    );

    console.error(
      "Required: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY"
    );
  }
} catch (err) {
  console.error(
    "Firebase initialization error:",
    err
  );
}

/* =========================================================
   HELPERS
   ========================================================= */

function normalizeToken(value) {
  if (!value) {
    return null;
  }

  return String(value)
    .trim()
    .replace(/^["']|["']$/g, "");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  return (
    forwarded ||
    req.socket.remoteAddress ||
    "127.0.0.1"
  )
    .split(",")[0]
    .trim();
}

/* =========================================================
   FIND TRANSACTION BY TOKEN
   ========================================================= */

async function findTransactionByToken(token) {
  if (!token || !firebaseReady || !db) {
    return null;
  }

  const normalizedToken = normalizeToken(token);

  if (!normalizedToken) {
    return null;
  }

  const snapshot = await db
    .ref("paymentTransactions")
    .orderByChild("token")
    .equalTo(normalizedToken)
    .once("value");

  if (!snapshot.exists()) {
    return null;
  }

  const transactions = snapshot.val();

  const keys = Object.keys(transactions);

  if (!keys.length) {
    return null;
  }

  const key = keys[0];

  return {
    key: key,
    data: transactions[key]
  };
}

/* =========================================================
   FIND TRANSACTION BY MERCHANT REFERENCE
   ========================================================= */

async function findTransactionByMerchantReference(
  merchantReference
) {
  if (
    !merchantReference ||
    !firebaseReady ||
    !db
  ) {
    return null;
  }

  const snapshot = await db
    .ref("paymentTransactions")
    .orderByChild("merchantReference")
    .equalTo(merchantReference)
    .once("value");

  if (!snapshot.exists()) {
    return null;
  }

  const transactions = snapshot.val();

  const keys = Object.keys(transactions);

  if (!keys.length) {
    return null;
  }

  const key = keys[0];

  return {
    key: key,
    data: transactions[key]
  };
}

/* =========================================================
   FIND TRANSACTION BY USER + RECENT TRANSACTION
   ========================================================= */

async function findRecentUserTransaction(userId) {
  if (
    !userId ||
    !firebaseReady ||
    !db
  ) {
    return null;
  }

  const snapshot = await db
    .ref("paymentTransactions")
    .orderByChild("userId")
    .equalTo(userId)
    .once("value");

  if (!snapshot.exists()) {
    return null;
  }

  const transactions = snapshot.val();

  const entries = Object.entries(transactions);

  if (!entries.length) {
    return null;
  }

  entries.sort((a, b) => {
    const aTime =
      new Date(a[1].createdAt || 0).getTime();

    const bTime =
      new Date(b[1].createdAt || 0).getTime();

    return bTime - aTime;
  });

  return {
    key: entries[0][0],
    data: entries[0][1]
  };
}

/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get("/health", (req, res) => {
  return res.json({
    success: true,
    server: "online",
    firebaseConfigured: firebaseReady,
    paym8Configured: !!PAYM8_AUTH_HEADER,
    merchantClientProfile: MERCHANT_CLIENT_PROFILE,
    merchantBranchProductNumber:
      MERCHANT_BRANCH_PRODUCT_NUMBER
  });
});

/* =========================================================
   ROOT
   ========================================================= */

app.get("/", (req, res) => {
  return res.json({
    success: true,
    message: "Muustandi backend is online.",
    firebaseConfigured: firebaseReady,
    paym8Configured: !!PAYM8_AUTH_HEADER
  });
});

/* =========================================================
   TEST FIREBASE
   ========================================================= */

app.get("/test-firebase", async (req, res) => {
  try {
    if (!firebaseReady || !db) {
      return res.status(500).json({
        success: false,
        error: "Firebase is not configured."
      });
    }

    const testId = `TEST-${Date.now()}`;

    await db
      .ref(`paymentTransactions/${testId}`)
      .set({
        test: true,
        message:
          "Muustandi Firebase connection test",
        createdAt:
          new Date().toISOString()
      });

    console.log(
      "Firebase test transaction written:",
      testId
    );

    return res.json({
      success: true,
      message:
        "Firebase write successful.",
      testId: testId
    });
  } catch (err) {
    console.error(
      "Firebase test error:",
      err
    );

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/* =========================================================
   CREATE 1VOUCHER PAYMENT
   ========================================================= */

app.post(
  "/deposit/1voucher",
  async (req, res) => {
    try {
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

      const {
        amountInCents,
        userId,
        firstName,
        lastName
      } = req.body;

      /* ---------------------------------------------------
         VALIDATE AMOUNT
         --------------------------------------------------- */

      const amount =
        parseInt(amountInCents, 10);

      if (
        !Number.isFinite(amount) ||
        amount < 500
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Minimum deposit amount is R5 (500 cents)."
        });
      }

      /* ---------------------------------------------------
         VALIDATE USER
         --------------------------------------------------- */

      if (
        !userId ||
        userId === "GUEST"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "You must be logged in to make a deposit."
        });
      }

      /* ---------------------------------------------------
         FIREBASE
         --------------------------------------------------- */

      if (!firebaseReady || !db) {
        return res.status(500).json({
          success: false,
          error:
            "Firebase is not configured on the server."
        });
      }

      /* ---------------------------------------------------
         PAYM8 AUTH
         --------------------------------------------------- */

      if (!PAYM8_AUTH_HEADER) {
        console.error(
          "PAYM8_AUTH_HEADER is not configured."
        );

        return res.status(500).json({
          success: false,
          error:
            "PayM8 authentication is not configured on the server."
        });
      }

      /* ---------------------------------------------------
         CLIENT IP
         --------------------------------------------------- */

      const clientIp =
        getClientIp(req);

      /* ---------------------------------------------------
         MERCHANT REFERENCE
         --------------------------------------------------- */

      const merchantReference =
        `DEP-${Date.now()
          .toString()
          .slice(-8)}`;

      /* ---------------------------------------------------
         CALLBACK URL

         IMPORTANT:
         Paul specifically told us NOT to include
         ?userId=... in this URL.

         Therefore the callback is now:

         /api/1voucher/callback?token={0}
         --------------------------------------------------- */

      const callbackUrl =
        "https://muustandibackend.onrender.com/api/1voucher/callback" +
        "?token={0}";

      /* ---------------------------------------------------
         RESULT REDIRECT
         --------------------------------------------------- */

      const resultRedirectUrl =
        "https://muustandibackend.onrender.com/wallet-success?token={0}";

      /* ---------------------------------------------------
         TRANSACTION
         --------------------------------------------------- */

      const transactionData = {
        merchantReference:
          merchantReference,

        userId:
          userId,

        amountInCents:
          amount,

        amountRand:
          amount / 100,

        firstName:
          firstName || "Gamer",

        lastName:
          lastName || "Customer",

        status:
          "PAYMENT_REQUEST_CREATED",

        walletCredited:
          false,

        token:
          null,

        callbackReceived:
          false,

        callbackReconciled:
          false,

        paym8Outcome:
          null,

        createdAt:
          new Date().toISOString(),

        updatedAt:
          new Date().toISOString()
      };

      await db
        .ref(
          `paymentTransactions/${merchantReference}`
        )
        .set(transactionData);

      console.log(
        "User ID:",
        userId
      );

      console.log(
        "Amount cents:",
        amount
      );

      console.log(
        "Transaction saved:",
        merchantReference
      );

      /* ---------------------------------------------------
         UNIQUE CUSTOMER ID

         Paul explained that MerchantClientProfile is NOT
         the customer identifier.

         We therefore send the logged-in user's Firebase UID
         as UniqueCustomerId.
         --------------------------------------------------- */

      const uniqueCustomerId =
        String(userId);

      /* ---------------------------------------------------
         PAYM8 PAYLOAD
         --------------------------------------------------- */

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
              null
          }
        ],

        /*
          This is the corrected value from Paul's
          successful transaction comparison.
        */
        merchantClientProfile:
          MERCHANT_CLIENT_PROFILE,

        /*
          Customer identifier.
        */
        uniqueCustomerId:
          uniqueCustomerId,

        FirstName:
          firstName || "Gamer",

        Lastname:
          lastName || "Customer"
      };

      console.log("");
      console.log(
        "PAYM8 PAYMENT REQUEST"
      );

      console.log(
        "PayM8 endpoint:",
        "SubmitPaymentRequest"
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

      /* ---------------------------------------------------
         CALL PAYM8
         --------------------------------------------------- */

      const response = await fetch(
        PAYM8_SUBMIT_URL,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "Accept":
              "application/json",

            "Authorization":
              PAYM8_AUTH_HEADER
          },

          body:
            JSON.stringify(payload)
        }
      );

      /* ---------------------------------------------------
         READ RESPONSE
         --------------------------------------------------- */

      const responseText =
        await response.text();

      console.log(
        "PayM8 HTTP status:",
        response.status
      );

      console.log(
        "PayM8 raw response:",
        responseText
      );

      let data = {};

      if (
        responseText &&
        responseText.trim()
      ) {
        try {
          data =
            JSON.parse(responseText);
        } catch (parseErr) {
          console.error(
            "PayM8 response was not JSON."
          );
        }
      }

      /* ---------------------------------------------------
         PAYMENT REQUEST ACCEPTED
         --------------------------------------------------- */

      if (
        response.ok &&
        data.data &&
        data.data.submitWasSuccessful &&
        data.data.redirectUri
      ) {
        const token =
          normalizeToken(
            data.data.token
          );

        await db
          .ref(
            `paymentTransactions/${merchantReference}`
          )
          .update({
            token:
              token,

            status:
              "PAYM8_REDIRECT_CREATED",

            paym8Response:
              data,

            updatedAt:
              new Date().toISOString()
          });

        console.log(
          "PayM8 payment request successful."
        );

        console.log(
          "PayM8 token received:",
          token ? "YES" : "NO"
        );

        console.log(
          "PayM8 redirect created."
        );

        return res.json({
          success: true,

          redirectUri:
            data.data.redirectUri,

          token:
            token,

          merchantReference:
            merchantReference
        });
      }

      /* ---------------------------------------------------
         PAYM8 REQUEST REJECTED
         --------------------------------------------------- */

      const gatewayError =
        (
          data.data &&
          data.data.failureReason
        ) ||
        data.description ||
        data.errorMessage ||
        data.message ||
        `Gateway error (HTTP ${response.status})`;

      await db
        .ref(
          `paymentTransactions/${merchantReference}`
        )
        .update({
          status:
            "PAYM8_REQUEST_REJECTED",

          paym8HttpStatus:
            response.status,

          paym8Response:
            data,

          error:
            gatewayError,

          updatedAt:
            new Date().toISOString()
        });

      console.error(
        "PayM8 payment request failed:",
        gatewayError
      );

      return res.status(400).json({
        success: false,

        error:
          gatewayError,

        paym8HttpStatus:
          response.status,

        merchantReference:
          merchantReference
      });
    } catch (err) {
      console.error(
        "1Voucher submission error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   PAYM8 CALLBACK
   ========================================================= */

async function handlePayM8Callback(
  req,
  res
) {
  try {
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

    const rawToken =
      req.query.token ||
      (
        req.body &&
        (
          req.body.token ||
          req.body.transactionToken
        )
      ) ||
      null;

    const token =
      normalizeToken(rawToken);

    const merchantReference =
      (
        req.query.merchantReference ||
        req.query.merchantReferenceNumber ||
        (
          req.body &&
          (
            req.body.merchantReference ||
            req.body.merchantReferenceNumber
          )
        )
      ) || null;

    console.log(
      "Token received:",
      token ? "YES" : "NO"
    );

    console.log(
      "Merchant reference received:",
      merchantReference
        ? merchantReference
        : "NO"
    );

    if (token) {
      console.log(
        "Callback token:",
        token
      );
    }

    /* ---------------------------------------------------
       ALWAYS SAVE CALLBACK FIRST
       --------------------------------------------------- */

    if (
      token &&
      firebaseReady &&
      db
    ) {
      try {
        await db
          .ref(
            `paym8Callbacks/${token}`
          )
          .update({
            token:
              token,

            merchantReference:
              merchantReference,

            receivedAt:
              new Date().toISOString(),

            method:
              req.method,

            query:
              req.query || {},

            body:
              req.body || {},

            reconciled:
              false
          });

        console.log(
          "PayM8 callback saved."
        );
      } catch (callbackSaveError) {
        console.error(
          "Could not save PayM8 callback:",
          callbackSaveError
        );
      }
    }

    /* ---------------------------------------------------
       TRY TOKEN MATCH
       --------------------------------------------------- */

    let matchedTransaction = null;

    if (token) {
      const maxLookupAttempts = 5;

      for (
        let attempt = 1;
        attempt <= maxLookupAttempts;
        attempt++
      ) {
        try {
          matchedTransaction =
            await findTransactionByToken(
              token
            );

          if (matchedTransaction) {
            console.log(
              "Callback matched transaction by token on attempt:",
              attempt
            );

            break;
          }

          console.log(
            `Callback token lookup attempt ${attempt}/${maxLookupAttempts}: no match yet.`
          );

          if (
            attempt <
            maxLookupAttempts
          ) {
            await new Promise(
              resolve =>
                setTimeout(
                  resolve,
                  1000
                )
            );
          }
        } catch (lookupError) {
          console.error(
            "Callback transaction token lookup error:",
            lookupError
          );
        }
      }
    }

    /* ---------------------------------------------------
       TRY MERCHANT REFERENCE MATCH
       --------------------------------------------------- */

    if (
      !matchedTransaction &&
      merchantReference
    ) {
      try {
        matchedTransaction =
          await findTransactionByMerchantReference(
            merchantReference
          );

        if (matchedTransaction) {
          console.log(
            "Callback matched transaction by merchant reference."
          );
        }
      } catch (merchantLookupError) {
        console.error(
          "Merchant reference lookup error:",
          merchantLookupError
        );
      }
    }

    /* ---------------------------------------------------
       UPDATE MATCHED TRANSACTION
       --------------------------------------------------- */

    if (
      matchedTransaction &&
      firebaseReady &&
      db
    ) {
      try {
        const updateData = {
          callbackReceived:
            true,

          callbackReceivedAt:
            new Date().toISOString(),

          callbackReconciled:
            true,

          status:
            "CALLBACK_RECEIVED",

          updatedAt:
            new Date().toISOString()
        };

        /*
          If the callback token differs from the original
          token, keep the callback token separately rather
          than destroying the original transaction token.
        */
        if (
          token &&
          token !==
            matchedTransaction.data.token
        ) {
          updateData.callbackToken =
            token;
        }

        if (merchantReference) {
          updateData.callbackMerchantReference =
            merchantReference;
        }

        await db
          .ref(
            `paymentTransactions/${matchedTransaction.key}`
          )
          .update(updateData);

        if (token) {
          await db
            .ref(
              `paym8Callbacks/${token}`
            )
            .update({
              reconciled:
                true,

              reconciledMerchantReference:
                matchedTransaction.key,

              reconciledAt:
                new Date().toISOString()
            });
        }

        console.log(
          "Callback successfully linked to transaction:",
          matchedTransaction.key
        );
      } catch (updateError) {
        console.error(
          "Callback transaction update error:",
          updateError
        );
      }
    } else {
      console.log(
        "Callback did not match a stored transaction."
      );

      console.log(
        "The callback has still been saved under paym8Callbacks."
      );
    }

    /*
      IMPORTANT:
      We DO NOT credit the wallet from the callback alone.
    */

    return res.status(200).json({
      received: true,

      matched:
        !!matchedTransaction,

      walletCredited:
        false
    });
  } catch (err) {
    console.error(
      "PayM8 callback handler error:",
      err
    );

    return res.status(200).json({
      received: true,
      matched: false,
      walletCredited: false
    });
  }
}

app.post(
  "/api/1voucher/callback",
  handlePayM8Callback
);

app.get(
  "/api/1voucher/callback",
  handlePayM8Callback
);

/* =========================================================
   PAYMENT STATUS
   ========================================================= */

app.get(
  "/payment-status",
  async (req, res) => {
    try {
      const rawToken =
        req.query.token;

      const token =
        normalizeToken(rawToken);

      if (!token) {
        return res.status(400).json({
          success: false,
          error:
            "Missing payment token."
        });
      }

      if (!PAYM8_AUTH_HEADER) {
        return res.status(500).json({
          success: false,
          error:
            "PayM8 authentication is not configured."
        });
      }

      /* ---------------------------------------------------
         FIND TRANSACTION BY ORIGINAL TOKEN
         --------------------------------------------------- */

      let transaction = null;
      let transactionKey = null;

      if (
        firebaseReady &&
        db
      ) {
        const found =
          await findTransactionByToken(
            token
          );

        if (found) {
          transactionKey =
            found.key;

          transaction =
            found.data;
        }
      }

      /* ---------------------------------------------------
         CALLBACK RECORD
         --------------------------------------------------- */

      let callbackRecord = null;

      if (
        firebaseReady &&
        db
      ) {
        const callbackSnapshot =
          await db
            .ref(
              `paym8Callbacks/${token}`
            )
            .once("value");

        if (
          callbackSnapshot.exists()
        ) {
          callbackRecord =
            callbackSnapshot.val();
        }
      }

      /* ---------------------------------------------------
         ASK PAYM8 FOR OUTCOME
         --------------------------------------------------- */

      const outcomeResponse =
        await fetch(
          `${PAYM8_OUTCOME_URL}/${encodeURIComponent(token)}`,
          {
            method: "GET",

            headers: {
              Accept:
                "application/json",

              Authorization:
                PAYM8_AUTH_HEADER
            }
          }
        );

      const outcomeText =
        await outcomeResponse.text();

      let outcomeData = {};

      try {
        outcomeData =
          JSON.parse(
            outcomeText
          );
      } catch (err) {
        outcomeData = {
          rawResponse:
            outcomeText
        };
      }

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

      console.log(
        "Token:",
        token
      );

      console.log(
        "HTTP status:",
        outcomeResponse.status
      );

      console.log(
        "Outcome:",
        outcomeText
      );

      console.log(
        "Callback record found:",
        callbackRecord
          ? "YES"
          : "NO"
      );

      /* ---------------------------------------------------
         GET MERCHANT REFERENCE FROM OUTCOME
         --------------------------------------------------- */

      const outcomeMerchantReference =
        outcomeData &&
        outcomeData.data &&
        outcomeData.data.merchantReference
          ? outcomeData.data.merchantReference
          : null;

      const outcomeCode =
        outcomeData &&
        outcomeData.data
          ? outcomeData.data.outcomeCode
          : null;

      const outcomeDescription =
        outcomeData &&
        outcomeData.data
          ? outcomeData.data.outcomeDescription
          : null;

      console.log(
        "Merchant reference from outcome:",
        outcomeMerchantReference ||
          "NONE"
      );

      console.log(
        "Outcome code:",
        outcomeCode
      );

      console.log(
        "Outcome description:",
        outcomeDescription
      );

      /* ---------------------------------------------------
         IF ORIGINAL TOKEN DOES NOT MATCH, USE MERCHANT
         REFERENCE FROM PAYM8 OUTCOME
         --------------------------------------------------- */

      if (
        !transaction &&
        outcomeMerchantReference &&
        firebaseReady &&
        db
      ) {
        const foundByMerchant =
          await findTransactionByMerchantReference(
            outcomeMerchantReference
          );

        if (foundByMerchant) {
          transactionKey =
            foundByMerchant.key;

          transaction =
            foundByMerchant.data;

          console.log(
            "Transaction matched using merchant reference from PayM8 outcome:",
            transactionKey
          );
        }
      }

      /* ---------------------------------------------------
         SAVE OUTCOME
         --------------------------------------------------- */

      if (
        transactionKey &&
        firebaseReady &&
        db
      ) {
        await db
          .ref(
            `paymentTransactions/${transactionKey}`
          )
          .update({
            paym8Outcome:
              outcomeData,

            paym8OutcomeHttpStatus:
              outcomeResponse.status,

            lastKnownOutcomeCode:
              outcomeCode,

            lastKnownOutcomeDescription:
              outcomeDescription,

            updatedAt:
              new Date().toISOString()
          });
      }

      /* ---------------------------------------------------
         IMPORTANT

         DO NOT CREDIT THE WALLET YET.

         We need to see the actual successful PayM8
         outcome from a real successful 1Voucher payment.

         The current response can be:

         outcomeCode: null
         lastCompletedStep: 1

         That is NOT proof of payment success.
         --------------------------------------------------- */

      return res.json({
        success:
          outcomeResponse.ok,

        status:
          "PENDING",

        walletCredited:
          transaction &&
          transaction.walletCredited
            ? true
            : false,

        transaction:
          transactionKey ||
          null,

        merchantReference:
          outcomeMerchantReference ||
          (
            transaction &&
            transaction.merchantReference
          ) ||
          null,

        callbackReceived:
          !!callbackRecord,

        paym8HttpStatus:
          outcomeResponse.status,

        outcomeCode:
          outcomeCode,

        outcomeDescription:
          outcomeDescription,

        outcome:
          outcomeData
      });
    } catch (err) {
      console.error(
        "Payment status error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   WALLET SUCCESS / RESULT REDIRECT
   ========================================================= */

app.get(
  "/wallet-success",
  (req, res) => {
    const token =
      req.query.token || "";

    console.log("");
    console.log(
      "=============================================="
    );
    console.log(
      "PAYM8 RESULT REDIRECT RECEIVED"
    );
    console.log(
      "=============================================="
    );

    console.log(
      "Token received:",
      token ? "YES" : "NO"
    );

    /*
      The wallet page should call /payment-status?token=...
      to check the transaction.

      We are intentionally NOT saying "payment successful"
      here because reaching this URL alone does not prove
      that the voucher was successfully redeemed.
    */

    const safeToken =
      encodeURIComponent(
        normalizeToken(token) || ""
      );

    res.status(200).send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Muustandi Payment</title>
</head>

<body style="
  font-family: Arial, sans-serif;
  background: #07152f;
  color: white;
  text-align: center;
  padding: 50px;
">

  <h2>We are checking your payment...</h2>

  <p>
    Please wait while we verify your 1Voucher payment.
  </p>

  <p>
    Do not submit the voucher again.
  </p>

  <p id="status">
    Checking PayM8...
  </p>

  <script>
    const token = "${safeToken}";

    async function checkPayment() {
      if (!token) {
        document.getElementById("status").innerText =
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

        /*
          We intentionally do not automatically declare
          payment successful here yet.
        */

        if (
          data.outcomeCode === "Faulted"
        ) {
          document.getElementById("status").innerText =
            data.outcomeDescription ||
            "Payment failed. Your wallet was not credited.";

          return;
        }

        if (
          data.walletCredited === true
        ) {
          document.getElementById("status").innerText =
            "Payment successful. Your wallet has been credited.";

          return;
        }

        document.getElementById("status").innerText =
          "Payment is still being verified...";

        setTimeout(
          checkPayment,
          5000
        );
      } catch (error) {
        console.error(
          "Payment status error:",
          error
        );

        document.getElementById("status").innerText =
          "We are still checking your payment...";

        setTimeout(
          checkPayment,
          5000
        );
      }
    }

    checkPayment();
  </script>

</body>
</html>
`);
  }
);

/* =========================================================
   DEBUG PAYMENT OUTCOME
   ========================================================= */

app.get(
  "/debug/payment-outcome",
  async (req, res) => {
    try {
      const rawToken =
        req.query.token;

      const token =
        normalizeToken(rawToken);

      if (!token) {
        return res.status(400).json({
          success: false,
          error:
            "Missing transaction token."
        });
      }

      if (!PAYM8_AUTH_HEADER) {
        return res.status(500).json({
          success: false,
          error:
            "PayM8 authentication is not configured."
        });
      }

      const outcomeResponse =
        await fetch(
          `${PAYM8_OUTCOME_URL}/${encodeURIComponent(token)}`,
          {
            method: "GET",

            headers: {
              Accept:
                "application/json",

              Authorization:
                PAYM8_AUTH_HEADER
            }
          }
        );

      const outcomeText =
        await outcomeResponse.text();

      let outcomeData;

      try {
        outcomeData =
          JSON.parse(
            outcomeText
          );
      } catch (err) {
        outcomeData = {
          rawResponse:
            outcomeText
        };
      }

      console.log(
        "PayM8 Outcome HTTP Status:",
        outcomeResponse.status
      );

      console.log(
        "PayM8 Outcome Response:",
        outcomeText
      );

      return res.status(
        outcomeResponse.ok
          ? 200
          : outcomeResponse.status
      ).json({
        success:
          outcomeResponse.ok,

        paym8HttpStatus:
          outcomeResponse.status,

        outcome:
          outcomeData
      });
    } catch (err) {
      console.error(
        "Payment outcome error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   SERVER START
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
