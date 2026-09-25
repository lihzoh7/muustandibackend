
let db = null;

try {
  if (
    FIREBASE_PROJECT_ID &&
    FIREBASE_CLIENT_EMAIL &&
    FIREBASE_PRIVATE_KEY
  ) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
      databaseURL:
        "https://tose-ccf8f-default-rtdb.europe-west1.firebasedatabase.app",
    });

    db = admin.database();

    console.log("Firebase Admin initialized successfully.");
    console.log("Firebase Realtime Database connected.");
  } else {
    console.log("Firebase environment variables are missing.");
  }
} catch (error) {
  console.error("Firebase initialization error:", error);
}

// ============================================================
// HELPERS
// ============================================================

function normalizeToken(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
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

async function findTransactionByToken(token) {
  if (!db || !token) {
    return null;
  }

  const snapshot = await db
    .ref("paymentTransactions")
    .orderByChild("token")
    .equalTo(token)
    .once("value");

  if (!snapshot.exists()) {
    return null;
  }

  let found = null;

  snapshot.forEach((child) => {
    found = {
      key: child.key,
      ...child.val(),
    };
  });

  return found;
}

async function findTransactionByMerchantReference(
  merchantReference
) {
  if (!db || !merchantReference) {
    return null;
  }

  const snapshot = await db
    .ref(`paymentTransactions/${merchantReference}`)
    .once("value");

  if (!snapshot.exists()) {
    return null;
  }

  return {
    key: snapshot.key,
    ...snapshot.val(),
  };
}

// ============================================================
// EXTRACT VALUES FROM PAYM8 CALLBACK
// ============================================================

function extractCallbackValues(req) {
  const body =
    req.body && typeof req.body === "object"
      ? req.body
      : {};

  const query =
    req.query && typeof req.query === "object"
      ? req.query
      : {};

  const token =
    normalizeToken(query.token) ||
    normalizeToken(body.token) ||
    normalizeToken(body.Token) ||
    normalizeToken(body.transactionToken) ||
    normalizeToken(body.TransactionToken);

  const merchantReference =
    normalizeToken(query.merchantReference) ||
    normalizeToken(query.merchantReferenceNumber) ||
    normalizeToken(body.merchantReference) ||
    normalizeToken(body.MerchantReference) ||
    normalizeToken(body.merchantReferenceNumber) ||
    normalizeToken(body.MerchantReferenceNumber);

  return {
    token,
    merchantReference,
    query,
    body,
  };
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    server: "online",
    firebaseConfigured: !!db,
    paym8Configured: !!PAYM8_AUTH_HEADER,
  });
});

// ============================================================
// TEST FIREBASE
// ============================================================

app.get("/test-firebase", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Firebase is not configured.",
      });
    }

    const testRef = db.ref("systemTests").push();

    await testRef.set({
      test: true,
      createdAt: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: "Firebase write successful.",
      key: testRef.key,
    });
  } catch (error) {
    console.error("Firebase test error:", error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================
// 1VOUCHER DEPOSIT
// ============================================================

app.post("/deposit/1voucher", async (req, res) => {
  console.log("==============================================");
  console.log("1VOUCHER DEPOSIT REQUEST");
  console.log("==============================================");

  try {
    const {
      userId,
      amount,
      firstName,
      lastName,
    } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Missing userId.",
      });
    }

    const amountCents = Number(amount);

    if (!Number.isFinite(amountCents)) {
      return res.status(400).json({
        success: false,
        error: "Invalid amount.",
      });
    }

    if (amountCents < 500) {
      return res.status(400).json({
        success: false,
        error: "Minimum deposit is R5.",
      });
    }

    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Firebase is not configured.",
      });
    }

    if (!PAYM8_AUTH_HEADER) {
      return res.status(500).json({
        success: false,
        error: "PAYM8_AUTH_HEADER is not configured.",
      });
    }

    const merchantReference =
      `DEP-${Date.now().toString().slice(-8)}`;

    const clientIp = getClientIp(req);

    console.log("User ID:", userId);
    console.log("Amount cents:", amountCents);
    console.log("Transaction reference:", merchantReference);

    // ========================================================
    // IMPORTANT:
    // Do NOT put userId into MerchantOutcomeCallbackUrl.
    // ========================================================

    const callbackUrl = CALLBACK_URL;
    const resultRedirectUrl = RESULT_URL;

    // ========================================================
    // PAYM8 PAYLOAD
    // ========================================================

    const payload = {
      merchantBranchProductNumber: "JQVSND",

      totalCostInCents: amountCents,

      merchantReferenceNumber: merchantReference,

      transactionDescription:
        "1Voucher Wallet Deposit",

      userHostAddress: clientIp,

      resultRedirectUrl: resultRedirectUrl,

      callbackUrl: callbackUrl,

      paymentChannels: [
        {
          channelName: "OneVoucher",
          settings: null,
        },
      ],

      // ======================================================
      // PayM8 specifically told us this must NOT be the
      // merchant's 1Voucher account number.
      // ======================================================

      merchantClientProfile: "PMV-03",

      // Leave this null because the successful PayM8 trace
      // supplied by PayM8 also showed this as null.
      uniqueCustomerId: null,

      FirstName: firstName || "Gamer",

      Lastname: lastName || "Customer",
    };

    console.log("Transaction saved:", merchantReference);

    console.log("PAYM8 PAYMENT REQUEST");
    console.log("PayM8 endpoint: SubmitPaymentRequest");
    console.log("Merchant reference:", merchantReference);
    console.log("Amount cents:", amountCents);
    console.log(
      "MerchantClientProfile:",
      payload.merchantClientProfile
    );
    console.log(
      "UniqueCustomerId:",
      userId
    );
    console.log("Callback URL:", callbackUrl);

    // ========================================================
    // SAVE TRANSACTION BEFORE CALLING PAYM8
    // ========================================================

    await db
      .ref(`paymentTransactions/${merchantReference}`)
      .set({
        merchantReference,
        userId,
        amountCents,

        status: "PAYMENT_SESSION_CREATED",

        walletCredited: false,

        callbackReceived: false,

        reconciled: false,

        createdAt: new Date().toISOString(),

        clientIp,
      });

    // ========================================================
    // SEND PAYM8 REQUEST
    // ========================================================

    console.log("Sending PayM8 payload...");

    const paym8Response = await fetch(
      PAYM8_SUBMIT_URL,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization: PAYM8_AUTH_HEADER,
        },

        body: JSON.stringify(payload),
      }
    );

    const paym8Text = await paym8Response.text();

    let paym8Data;

    try {
      paym8Data = JSON.parse(paym8Text);
    } catch {
      paym8Data = {
        raw: paym8Text,
      };
    }

    console.log(
      "PayM8 HTTP status:",
      paym8Response.status
    );

    console.log(
      "PayM8 raw response:",
      JSON.stringify(paym8Data, null, 2)
    );

    // ========================================================
    // HANDLE PAYM8 REQUEST FAILURE
    // ========================================================

    if (!paym8Response.ok) {
      await db
        .ref(`paymentTransactions/${merchantReference}`)
        .update({
          status: "PAYM8_REQUEST_FAILED",

          paym8HttpStatus:
            paym8Response.status,

          paym8Response: paym8Data,

          failedAt:
            new Date().toISOString(),
        });

      return res.status(400).json({
        success: false,

        merchantReference,

        paym8HttpStatus:
          paym8Response.status,

        paym8Response: paym8Data,
      });
    }

    const paymentData =
      paym8Data?.data || {};

    const token =
      normalizeToken(paymentData.token);

    const redirectUri =
      paymentData.redirectUri || null;

    const submitWasSuccessful =
      paymentData.submitWasSuccessful === true;

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

    // ========================================================
    // SAVE PAYM8 RESPONSE
    // ========================================================

    await db
      .ref(`paymentTransactions/${merchantReference}`)
      .update({
        token: token || null,

        paym8HttpStatus:
          paym8Response.status,

        paym8SubmitResponse:
          paym8Data,

        submitWasSuccessful,

        redirectUri,

        status:
          submitWasSuccessful
            ? "PAYMENT_SESSION_CREATED"
            : "PAYMENT_SESSION_FAILED",

        updatedAt:
          new Date().toISOString(),
      });

    // ========================================================
    // CHECK IF CALLBACK ARRIVED VERY QUICKLY
    // ========================================================

    if (token) {
      const callbackSnapshot = await db
        .ref(`paym8Callbacks/${token}`)
        .once("value");

      if (callbackSnapshot.exists()) {
        console.log(
          "A callback was already saved for the original token."
        );

        await db
          .ref(`paymentTransactions/${merchantReference}`)
          .update({
            callbackReceived: true,

            callbackForOriginalToken: true,

            callbackMatchedAt:
              new Date().toISOString(),
          });
      }
    }

    // ========================================================
    // RETURN REDIRECT TO FRONTEND
    // ========================================================

    return res.json({
      success: true,

      merchantReference,

      token: token || null,

      redirectUri,

      message:
        "PayM8 payment session created. Redirect the user to PayM8.",
    });

  } catch (error) {
    console.error(
      "1Voucher deposit error:",
      error
    );

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================
// PAYM8 CALLBACK HANDLER
// ============================================================

async function handlePayM8Callback(req, res) {
  console.log("==============================================");
  console.log("PAYM8 CALLBACK RECEIVED");
  console.log("==============================================");

  try {
    const {
      token,
      merchantReference,
      query,
      body,
    } = extractCallbackValues(req);

    console.log(
      "Callback token:",
      token || "NONE"
    );

    console.log(
      "Merchant reference received:",
      merchantReference
        ? "YES"
        : "NO"
    );

    console.log(
      "FULL CALLBACK QUERY:",
      JSON.stringify(query, null, 2)
    );

    console.log(
      "FULL CALLBACK BODY:",
      JSON.stringify(body, null, 2)
    );

    // ========================================================
    // SAVE THE RAW CALLBACK
    // ========================================================

    if (!db) {
      return res.status(500).send("Firebase unavailable.");
    }

    const callbackKey =
      token ||
      `callback-${Date.now()}`;

    await db
      .ref(`paym8Callbacks/${callbackKey}`)
      .set({
        receivedAt:
          new Date().toISOString(),

        token: token || null,

        merchantReference:
          merchantReference || null,

        query,

        body,
      });

    console.log(
      "PayM8 callback saved."
    );

    // ========================================================
    // TRY MATCHING BY MERCHANT REFERENCE FIRST
    // ========================================================

    let transaction = null;

    if (merchantReference) {
      transaction =
        await findTransactionByMerchantReference(
          merchantReference
        );

      if (transaction) {
        console.log(
          "CALLBACK MATCHED BY MERCHANT REFERENCE:",
          merchantReference
        );
      }
    }

    // ========================================================
    // TRY MATCHING BY TOKEN
    // ========================================================

    if (!transaction && token) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        transaction =
          await findTransactionByToken(token);

        console.log(
          `Callback transaction token lookup attempt ${attempt}/5:`,
          transaction
            ? "MATCH FOUND"
            : "no match yet"
        );

        if (transaction) {
          break;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, 1000)
        );
      }
    }

    // ========================================================
    // CALLBACK COULD NOT BE CORRELATED
    // ========================================================

    if (!transaction) {
      console.log(
        "Callback did not match a stored transaction."
      );

      console.log(
        "The callback has still been saved under paym8Callbacks."
      );

      return res.status(200).send("OK");
    }

    // ========================================================
    // UPDATE MATCHED TRANSACTION
    // ========================================================

    await db
      .ref(
        `paymentTransactions/${transaction.merchantReference}`
      )
      .update({
        callbackReceived: true,

        callbackToken:
          token || null,

        callbackMerchantReference:
          merchantReference || null,

        callbackMatchedAt:
          new Date().toISOString(),

        callbackMatchMethod:
          merchantReference
            ? "MERCHANT_REFERENCE"
            : "TOKEN",

        status:
          "CALLBACK_RECEIVED",
      });

    console.log(
      "Callback successfully linked to transaction:",
      transaction.merchantReference
    );

    return res.status(200).send("OK");

  } catch (error) {
    console.error(
      "PayM8 callback error:",
      error
    );

    return res.status(500).send("Callback error");
  }
}

// ============================================================
// CALLBACK ROUTES
// ============================================================

app.get(
  "/api/1voucher/callback",
  handlePayM8Callback
);

app.post(
  "/api/1voucher/callback",
  handlePayM8Callback
);

// ============================================================
// PAYMENT STATUS
// ============================================================

app.get("/payment-status", async (req, res) => {
  try {
    const token =
      normalizeToken(req.query.token);

    const merchantReference =
      normalizeToken(
        req.query.merchantReference
      );

    console.log("==============================================");
    console.log("PAYMENT STATUS REQUEST");
    console.log("==============================================");

    console.log(
      "Token:",
      token || "NONE"
    );

    console.log(
      "Merchant reference:",
      merchantReference || "NONE"
    );

    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Firebase unavailable.",
      });
    }

    // ========================================================
    // FIND TRANSACTION
    // ========================================================

    let transaction = null;

    if (merchantReference) {
      transaction =
        await findTransactionByMerchantReference(
          merchantReference
        );
    }

    if (!transaction && token) {
      transaction =
        await findTransactionByToken(token);
    }

    if (!transaction) {
      return res.status(404).json({
        success: false,
        status: "NOT_FOUND",
        walletCredited: false,
      });
    }

    // ========================================================
    // DETERMINE WHICH TOKEN TO USE FOR OUTCOME
    // ========================================================

    const outcomeToken =
      transaction.token ||
      token;

    console.log(
      "Transaction found:",
      transaction.merchantReference
    );

    console.log(
      "Original PayM8 token:",
      transaction.token || "NONE"
    );

    console.log(
      "Outcome token being queried:",
      outcomeToken || "NONE"
    );

    // ========================================================
    // GET PAYMENT OUTCOME FROM PAYM8
    // ========================================================

    let outcome = null;

    if (outcomeToken && PAYM8_AUTH_HEADER) {
      const outcomeUrl =
        `${PAYM8_OUTCOME_URL_BASE}/${encodeURIComponent(
          outcomeToken
        )}`;

      console.log(
        "Calling PayM8 GetPaymentOutcome..."
      );

      console.log(
        "Outcome URL:",
        outcomeUrl
      );

      const outcomeResponse =
        await fetch(outcomeUrl, {
          method: "GET",

          headers: {
            Authorization:
              PAYM8_AUTH_HEADER,

            Accept:
              "application/json",
          },
        });

      const outcomeText =
        await outcomeResponse.text();

      try {
        outcome =
          JSON.parse(outcomeText);
      } catch {
        outcome = {
          raw: outcomeText,
        };
      }

      console.log(
        "PayM8 outcome HTTP status:",
        outcomeResponse.status
      );

      console.log(
        "PayM8 outcome response:",
        JSON.stringify(
          outcome,
          null,
          2
        )
      );

      // ======================================================
      // PRINT THE IMPORTANT PAYM8 FIELDS
      // ======================================================

      const outcomeData =
        outcome?.data || {};

      console.log(
        "----------------------------------------------"
      );

      console.log(
        "PAYM8 ACTUAL PAYMENT OUTCOME"
      );

      console.log(
        "Outcome code:",
        outcomeData.outcomeCode ?? "NULL"
      );

      console.log(
        "Outcome description:",
        outcomeData.outcomeDescription ?? ""
      );

      console.log(
        "Last completed step:",
        outcomeData.lastCompletedStep ?? "NULL"
      );

      console.log(
        "Merchant reference from outcome:",
        outcomeData.merchantReference ?? "NULL"
      );

      console.log(
        "----------------------------------------------"
      );

      // ======================================================
      // SAVE OUTCOME
      // ======================================================

      await db
        .ref(
          `paymentTransactions/${transaction.merchantReference}`
        )
        .update({
          latestPaym8Outcome:
            outcome,

          latestOutcomeCheckedAt:
            new Date().toISOString(),

          latestOutcomeCode:
            outcomeData.outcomeCode ?? null,

          latestOutcomeDescription:
            outcomeData.outcomeDescription ?? null,

          latestLastCompletedStep:
            outcomeData.lastCompletedStep ?? null,

          latestOutcomeMerchantReference:
            outcomeData.merchantReference ?? null,
        });
    }

    // ========================================================
    // IMPORTANT:
    // WALLET CREDITING REMAINS DISABLED.
    // ========================================================

    return res.json({
      success: true,

      status: "PENDING",

      walletCredited: false,

      merchantReference:
        transaction.merchantReference,

      transactionToken:
        transaction.token || null,

      callbackReceived:
        transaction.callbackReceived === true,

      paym8Outcome:
        outcome || null,

      message:
        "Payment outcome checked. Wallet crediting is currently disabled.",
    });

  } catch (error) {
    console.error(
      "Payment status error:",
      error
    );

    return res.status(500).json({
      success: false,
      error: error.message,

      walletCredited: false,
    });
  }
});

// ============================================================
// WALLET SUCCESS / WAITING PAGE
// ============================================================

app.get("/wallet-success", (req, res) => {
  const token =
    normalizeToken(req.query.token);

  console.log("==============================================");
  console.log("PAYM8 RESULT REDIRECT RECEIVED");
  console.log("==============================================");

  console.log(
    "Token received:",
    token ? "YES" : "NO"
  );

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>Checking Payment</title>

<style>
body {
  margin: 0;
  background: #071426;
  color: white;
  font-family: Arial, sans-serif;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  text-align: center;
}

.container {
  max-width: 500px;
  padding: 30px;
}

h1 {
  font-size: 28px;
  margin-bottom: 15px;
}

p {
  color: #cbd5e1;
  line-height: 1.6;
}

.button {
  display: inline-block;
  margin-top: 25px;
  padding: 13px 25px;
  background: #ffffff;
  color: #071426;
  text-decoration: none;
  border-radius: 8px;
  font-weight: bold;
}
</style>

</head>

<body>

<div class="container">

<h1>We are checking your payment...</h1>

<p>
Please wait while we verify your 1Voucher payment.
</p>

<p>
Do not submit the voucher again.
</p>

<a
  class="button"
  href="/"
>
RETURN
</a>

</div>

</body>
</html>
`);
});

// ============================================================
// DEBUG PAYMENT OUTCOME
// ============================================================

app.get("/debug/payment-outcome", async (req, res) => {
  try {
    const token =
      normalizeToken(req.query.token);

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Missing token.",
      });
    }

    if (!PAYM8_AUTH_HEADER) {
      return res.status(500).json({
        success: false,
        error: "PAYM8_AUTH_HEADER is not configured.",
      });
    }

    const outcomeUrl =
      `${PAYM8_OUTCOME_URL_BASE}/${encodeURIComponent(
        token
      )}`;

    console.log(
      "DEBUG OUTCOME REQUEST:",
      outcomeUrl
    );

    const response =
      await fetch(outcomeUrl, {
        method: "GET",

        headers: {
          Authorization:
            PAYM8_AUTH_HEADER,

          Accept:
            "application/json",
        },
      });

    const text =
      await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = {
        raw: text,
      };
    }

    console.log(
      "DEBUG OUTCOME RESPONSE:",
      JSON.stringify(
        data,
        null,
        2
      )
    );

    res.status(
      response.ok ? 200 : response.status
    ).json({
      success: response.ok,

      httpStatus:
        response.status,

      outcome: data,
    });

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
});

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Muustandi Backend",
    status: "online",
  });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server listening on port ${PORT}`
    );
  }
);
