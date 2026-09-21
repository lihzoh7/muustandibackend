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

const FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID;

const FIREBASE_CLIENT_EMAIL =
  process.env.FIREBASE_CLIENT_EMAIL;

const FIREBASE_PRIVATE_KEY =
  process.env.FIREBASE_PRIVATE_KEY;

const PAYM8_AUTH_HEADER =
  process.env.PAYM8_AUTH_HEADER;


/* =========================================================
   FIREBASE DATABASE
   ========================================================= */

const FIREBASE_DATABASE_URL =
  "https://tose-ccf8f-default-rtdb.europe-west1.firebasedatabase.app";

let db = null;
let firebaseReady = false;

try {

  if (
    FIREBASE_PROJECT_ID &&
    FIREBASE_CLIENT_EMAIL &&
    FIREBASE_PRIVATE_KEY
  ) {

    const privateKey =
      FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

    const firebaseApp =
      admin.initializeApp({
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

  } else {

    console.error(
      "Firebase environment variables are missing."
    );

  }

} catch (err) {

  console.error(
    "Firebase initialization error:",
    err
  );

}


/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get("/health", (req, res) => {

  return res.json({
    success: true,
    server: "online",
    firebaseConfigured: firebaseReady,
    paym8Configured: !!PAYM8_AUTH_HEADER
  });

});


/* =========================================================
   TEMPORARY FIREBASE TEST
   =========================================================
   We will remove this later.
   ========================================================= */

app.get("/test-firebase", async (req, res) => {

  try {

    if (!firebaseReady || !db) {

      return res.status(500).json({
        success: false,
        error: "Firebase is not configured."
      });

    }

    const testId =
      `TEST-${Date.now()}`;

    await db
      .ref(`paymentTransactions/${testId}`)
      .set({
        test: true,
        message: "Muustandi Firebase connection test",
        createdAt: new Date().toISOString()
      });

    console.log(
      "Firebase test transaction written:",
      testId
    );

    return res.json({
      success: true,
      message: "Firebase write successful.",
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
   1. CREATE 1VOUCHER PAYMENT
   ========================================================= */

app.post("/deposit/1voucher", async (req, res) => {

  try {

    console.log("");
    console.log("==============================================");
    console.log("1VOUCHER DEPOSIT REQUEST");
    console.log("==============================================");

    const {
      amountInCents,
      userId,
      firstName,
      lastName
    } = req.body;


    /* -----------------------------------------------------
       Validate amount
       ----------------------------------------------------- */

    const amount =
      parseInt(amountInCents, 10);

    if (
      !Number.isFinite(amount) ||
      amount < 500
    ) {

      return res.status(400).json({
        success: false,
        error: "Minimum deposit amount is R5 (500 cents)."
      });

    }


    /* -----------------------------------------------------
       Validate user
       ----------------------------------------------------- */

    if (
      !userId ||
      userId === "GUEST"
    ) {

      return res.status(400).json({
        success: false,
        error: "You must be logged in to make a deposit."
      });

    }


    /* -----------------------------------------------------
       Check Firebase
       ----------------------------------------------------- */

    if (!firebaseReady || !db) {

      return res.status(500).json({
        success: false,
        error: "Firebase is not configured on the server."
      });

    }


    /* -----------------------------------------------------
       Check PayM8 authentication
       ----------------------------------------------------- */

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


    /* -----------------------------------------------------
       Get client IP
       ----------------------------------------------------- */

    const clientIp = (
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "127.0.0.1"
    )
      .split(",")[0]
      .trim();


    /* -----------------------------------------------------
       PayM8 merchant reference
       
       Maximum 15 characters.
       Example:
       DEP-12345678
       ----------------------------------------------------- */

    const merchantReference =
      `DEP-${Date.now().toString().slice(-8)}`;


    /* -----------------------------------------------------
       Callback URL
       ----------------------------------------------------- */

    const callbackUrl =
      "https://muustandibackend.onrender.com/api/1voucher/callback" +
      `?userId=${encodeURIComponent(userId)}` +
      "&token={0}";


    /* -----------------------------------------------------
       Result redirect
       ----------------------------------------------------- */

    const resultRedirectUrl =
      "https://muustandibackend.onrender.com/wallet-success?token={0}";


    /* -----------------------------------------------------
       CREATE FIREBASE TRANSACTION FIRST
       
       This is important.
       We record the transaction before calling PayM8.
       ----------------------------------------------------- */

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

      paym8Outcome:
        null,

      createdAt:
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString()

    };


    await db
      .ref(`paymentTransactions/${merchantReference}`)
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


    /* =====================================================
       PAYM8 PAYMENT REQUEST
       =====================================================

       IMPORTANT:
       PayM8's documented endpoint is:

       /api/v1/ecommerce/SubmitPaymentRequest

       NOT:

       /api/v1/ecommerce/Payment
       ===================================================== */

    const payload = {

      merchantBranchProductNumber:
        "JQVSND",

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

      merchantClientProfile:
        "PMV00003",

      FirstName:
        firstName || "Gamer",

      Lastname:
        lastName || "Customer"

    };


    console.log("");
    console.log("PAYM8 PAYMENT REQUEST");
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
      "Sending PayM8 payload..."
    );


    /* -----------------------------------------------------
       CALL PAYM8
       ----------------------------------------------------- */

    const response = await fetch(
      "https://paym8online.com/PaymentsService/api/v1/ecommerce/SubmitPaymentRequest",
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


    /* -----------------------------------------------------
       Read PayM8 response
       ----------------------------------------------------- */

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


    /* -----------------------------------------------------
       SUCCESSFUL PAYMENT REQUEST
       ----------------------------------------------------- */

    if (
      response.ok &&
      data.data &&
      data.data.submitWasSuccessful &&
      data.data.redirectUri
    ) {

      const token =
        data.data.token || null;


      /* ---------------------------------------------------
         Update Firebase transaction
         --------------------------------------------------- */

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

        success:
          true,

        redirectUri:
          data.data.redirectUri,

        token:
          token,

        merchantReference:
          merchantReference

      });

    }


    /* -----------------------------------------------------
       PAYM8 REJECTED PAYMENT REQUEST
       ----------------------------------------------------- */

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

      success:
        false,

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

      success:
        false,

      error:
        err.message

    });

  }

});


/* =========================================================
   2. PAYM8 CALLBACK
   ========================================================= */

async function handlePayM8Callback(req, res) {

  console.log("");
  console.log("==============================================");
  console.log("PAYM8 CALLBACK RECEIVED");
  console.log("==============================================");

  const token =
    req.query.token ||
    (
      req.body &&
      req.body.token
    ) ||
    null;

  const userId =
    req.query.userId ||
    null;


  console.log(
    "Token received:",
    token ? "YES" : "NO"
  );

  console.log(
    "User ID received:",
    userId ? "YES" : "NO"
  );


  /* -----------------------------------------------------
     Do NOT credit wallet here.
     ----------------------------------------------------- */

  if (token && firebaseReady && db) {

    try {

      const snapshot =
        await db
          .ref("paymentTransactions")
          .orderByChild("token")
          .equalTo(token)
          .once("value");


      if (snapshot.exists()) {

        const transactions =
          snapshot.val();

        const keys =
          Object.keys(transactions);


        for (const key of keys) {

          await db
            .ref(
              `paymentTransactions/${key}`
            )
            .update({

              callbackReceived:
                true,

              callbackReceivedAt:
                new Date().toISOString(),

              status:
                "CALLBACK_RECEIVED",

              updatedAt:
                new Date().toISOString()

            });

        }

        console.log(
          "Callback matched transaction."
        );

      } else {

        console.log(
          "Callback token did not match a stored transaction yet."
        );

      }

    } catch (err) {

      console.error(
        "Callback Firebase lookup error:",
        err
      );

    }

  }


  return res.status(200).json({

    received:
      true

  });

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
   3. PAYMENT STATUS
   ========================================================= */

app.get("/payment-status", async (req, res) => {

  try {

    const token =
      req.query.token;


    if (!token) {

      return res.status(400).json({

        success:
          false,

        error:
          "Missing payment token."

      });

    }


    if (!PAYM8_AUTH_HEADER) {

      return res.status(500).json({

        success:
          false,

        error:
          "PayM8 authentication is not configured."

      });

    }


    /* -----------------------------------------------------
       Find our Firebase transaction
       ----------------------------------------------------- */

    let transaction = null;
    let transactionKey = null;

    if (firebaseReady && db) {

      const snapshot =
        await db
          .ref("paymentTransactions")
          .orderByChild("token")
          .equalTo(token)
          .once("value");


      if (snapshot.exists()) {

        const transactions =
          snapshot.val();

        transactionKey =
          Object.keys(transactions)[0];

        transaction =
          transactions[transactionKey];

      }

    }


    /* -----------------------------------------------------
       Ask PayM8 for current outcome
       ----------------------------------------------------- */

    const outcomeResponse =
      await fetch(

        `https://paym8online.com/PaymentsService/api/v1/ecommerce/GetPaymentOutcome/${encodeURIComponent(token)}`,

        {

          method:
            "GET",

          headers: {

            "Accept":
              "application/json",

            "Authorization":
              PAYM8_AUTH_HEADER

          }

        }

      );


    const outcomeText =
      await outcomeResponse.text();


    let outcomeData = {};

    try {

      outcomeData =
        JSON.parse(outcomeText);

    } catch (err) {

      outcomeData = {

        rawResponse:
          outcomeText

      };

    }


    console.log("");
    console.log("==============================================");
    console.log("PAYM8 PAYMENT OUTCOME");
    console.log("==============================================");

    console.log(
      "HTTP status:",
      outcomeResponse.status
    );

    console.log(
      "Outcome:",
      outcomeText
    );


    /* -----------------------------------------------------
       Save latest PayM8 outcome
       ----------------------------------------------------- */

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

          updatedAt:
            new Date().toISOString()

        });

    }


    /* -----------------------------------------------------
       IMPORTANT:
       We are NOT crediting the wallet yet.
       ----------------------------------------------------- */

    return res.json({

      success:
        outcomeResponse.ok,

      status:
        "PENDING",

      walletCredited:
        false,

      transaction:
        transactionKey
          ? transactionKey
          : null,

      paym8HttpStatus:
        outcomeResponse.status,

      outcome:
        outcomeData

    });


  } catch (err) {

    console.error(
      "Payment status error:",
      err
    );


    return res.status(500).json({

      success:
        false,

      error:
        err.message

    });

  }

});


/* =========================================================
   4. WALLET SUCCESS / PAYMENT RETURN PAGE
   ========================================================= */

app.get("/wallet-success", (req, res) => {

  const token =
    req.query.token || "";


  console.log("");
  console.log("==============================================");
  console.log("PAYM8 RESULT REDIRECT RECEIVED");
  console.log("==============================================");

  console.log(
    "Token received:",
    token ? "YES" : "NO"
  );


  const safeToken =
    encodeURIComponent(token);


  res.status(200).send(`

<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1.0">

<title>Payment Verification</title>

<style>

body {

  margin: 0;

  min-height: 100vh;

  display: flex;

  justify-content: center;

  align-items: center;

  background: #001f3f;

  color: white;

  font-family: Arial, sans-serif;

  text-align: center;

}

.box {

  width: 90%;

  max-width: 450px;

  padding: 30px;

  background: #001428;

  border-radius: 12px;

  box-shadow:
    0 0 20px rgba(0,0,0,0.5);

}

h1 {

  color: #00f0ff;

}

p {

  line-height: 1.6;

}

button {

  padding: 12px 20px;

  border: none;

  border-radius: 6px;

  background: #00f0ff;

  color: #001f3f;

  font-weight: bold;

  cursor: pointer;

  margin-top: 15px;

}

#status {

  margin-top: 20px;

}

</style>

</head>

<body>

<div class="box">

<h1>PAYMENT VERIFICATION</h1>

<p id="message">

We are checking your payment.

</p>

<p id="status">

Please wait...

</p>

<button
  onclick="window.location.href='https://muustandigaming.github.io/muustandi-gaming/wallet.html'">

RETURN TO WALLET

</button>

</div>


<script>

const token =
  "${safeToken}";

let attempts = 0;

const maxAttempts = 10;


async function checkPayment() {

  attempts++;


  if (!token) {

    document.getElementById("message").textContent =
      "No payment token was returned.";

    document.getElementById("status").textContent =
      "Please return to your wallet.";

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
      data.outcome &&
      data.outcome.data
    ) {

      const outcome =
        data.outcome.data;


      if (
        outcome.outcomeCode
      ) {

        document.getElementById("message").textContent =
          "Paym8 has returned a transaction outcome.";

        document.getElementById("status").textContent =
          "The transaction is being reviewed before wallet credit.";

        return;

      }


      if (
        outcome.lastCompletedStep >= 1
      ) {

        document.getElementById("message").textContent =
          "Paym8 is still processing the transaction.";

        document.getElementById("status").textContent =
          "Please wait while the payment status is checked.";

      }

    }


    if (
      attempts < maxAttempts
    ) {

      setTimeout(
        checkPayment,
        3000
      );

    } else {

      document.getElementById("message").textContent =
        "Payment verification is still pending.";

      document.getElementById("status").textContent =
        "Please return to your wallet. Your wallet has NOT been credited automatically.";

    }


  } catch (err) {

    console.error(err);


    if (
      attempts < maxAttempts
    ) {

      setTimeout(
        checkPayment,
        3000
      );

    } else {

      document.getElementById("message").textContent =
        "We could not complete payment verification.";

      document.getElementById("status").textContent =
        "Please return to your wallet.";

    }

  }

}


checkPayment();

</script>

</body>

</html>

`);

});


/* =========================================================
   5. TEMPORARY PAYMENT OUTCOME DEBUG
   ========================================================= */

app.get("/debug/payment-outcome", async (req, res) => {

  try {

    const token =
      req.query.token;


    if (!token) {

      return res.status(400).json({

        success:
          false,

        error:
          "Missing transaction token."

      });

    }


    if (!PAYM8_AUTH_HEADER) {

      return res.status(500).json({

        success:
          false,

        error:
          "PayM8 authentication is not configured."

      });

    }


    const outcomeResponse =
      await fetch(

        `https://paym8online.com/PaymentsService/api/v1/ecommerce/GetPaymentOutcome/${encodeURIComponent(token)}`,

        {

          method:
            "GET",

          headers: {

            "Accept":
              "application/json",

            "Authorization":
              PAYM8_AUTH_HEADER

          }

        }

      );


    const outcomeText =
      await outcomeResponse.text();


    let outcomeData;

    try {

      outcomeData =
        JSON.parse(outcomeText);

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

      success:
        false,

      error:
        err.message

    });

  }

});


/* =========================================================
   6. ROOT
   ========================================================= */

app.get("/", (req, res) => {

  res.json({

    success:
      true,

    message:
      "Muustandi backend is online.",

    firebaseConfigured:
      firebaseReady,

    paym8Configured:
      !!PAYM8_AUTH_HEADER

  });

});


/* =========================================================
   SERVER START
   ========================================================= */

app.listen(PORT, () => {

  console.log(
    `Server listening on port ${PORT}`
  );

});
