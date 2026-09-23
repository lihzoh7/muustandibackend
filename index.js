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
FIREBASE_PRIVATE_KEY.replace(/\n/g, "\n");

```
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

console.log(
  "Firebase Admin initialized successfully."
);

console.log(
  "Firebase Realtime Database connected."
);
```

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
HELPER: NORMALIZE PAYM8 TOKEN
========================================================= */

function normalizeToken(value) {
if (!value) {
return null;
}

return String(value)
.trim()
.replace(/^["']|["']$/g, "");
}

/* =========================================================
HELPER: FIND TRANSACTION BY TOKEN
========================================================= */

async function findTransactionByToken(token) {
if (
!token ||
!firebaseReady ||
!db
) {
return null;
}

const normalizedToken =
normalizeToken(token);

if (!normalizedToken) {
return null;
}

const snapshot =
await db
.ref("paymentTransactions")
.orderByChild("token")
.equalTo(normalizedToken)
.once("value");

if (!snapshot.exists()) {
return null;
}

const transactions =
snapshot.val();

const keys =
Object.keys(transactions);

if (!keys.length) {
return null;
}

const key =
keys[0];

return {
key: key,
data: transactions[key]
};
}

/* =========================================================
HELPER: FIND TRANSACTION BY MERCHANT REFERENCE
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

const snapshot =
await db
.ref("paymentTransactions")
.child(merchantReference)
.once("value");

if (!snapshot.exists()) {
return null;
}

return {
key: merchantReference,
data: snapshot.val()
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
paym8Configured: !!PAYM8_AUTH_HEADER
});
});

/* =========================================================
TEMPORARY FIREBASE TEST
========================================================= */

app.get("/test-firebase", async (req, res) => {
try {
if (
!firebaseReady ||
!db
) {
return res.status(500).json({
success: false,
error:
"Firebase is not configured."
});
}

```
const testId =
  `TEST-${Date.now()}`;

await db
  .ref(
    `paymentTransactions/${testId}`
  )
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
```

} catch (err) {
console.error(
"Firebase test error:",
err
);

```
return res.status(500).json({
  success: false,
  error: err.message
});
```

}
});

/* =========================================================

1. CREATE 1VOUCHER PAYMENT
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

```
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
      error:
        "Minimum deposit amount is R5 (500 cents)."
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
      error:
        "You must be logged in to make a deposit."
    });
  }

  /* -----------------------------------------------------
     Check Firebase
  ----------------------------------------------------- */

  if (
    !firebaseReady ||
    !db
  ) {
    return res.status(500).json({
      success: false,
      error:
        "Firebase is not configured on the server."
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
  ----------------------------------------------------- */

  const merchantReference =
    `DEP-${Date.now().toString().slice(-8)}`;

  /* -----------------------------------------------------
     CORRECTION #1 FROM PAUL

     Do NOT put userId into the callback URL.

     PayM8 must receive only the token placeholder.
  ----------------------------------------------------- */

  const callbackUrl =
    "https://muustandibackend.onrender.com/api/1voucher/callback" +
    "?token={0}";

  /* -----------------------------------------------------
     RESULT REDIRECT

     PayM8 returns the customer here after the
     payment flow.
  ----------------------------------------------------- */

  const resultRedirectUrl =
    "https://muustandibackend.onrender.com/wallet-success?token={0}";

  /* -----------------------------------------------------
     CORRECTION #2 FROM PAUL

     MerchantClientProfile must be a unique value
     representing the end customer.

     We use the Firebase authenticated user's UID.

     This is NOT the 1Voucher account number.
  ----------------------------------------------------- */

  const merchantClientProfile =
    String(userId);

  /* -----------------------------------------------------
     CREATE FIREBASE TRANSACTION FIRST
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

    merchantClientProfile:
      merchantClientProfile,

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
    "MerchantClientProfile:",
    merchantClientProfile
  );

  console.log(
    "Transaction saved:",
    merchantReference
  );

  /* =====================================================
     PAYM8 PAYMENT REQUEST
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

    /* -------------------------------------------------
       CORRECTED MERCHANT CLIENT PROFILE
    ------------------------------------------------- */

    merchantClientProfile:
      merchantClientProfile,

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
    merchantClientProfile
  );

  console.log(
    "Callback URL:",
    callbackUrl
  );

  console.log(
    "Sending PayM8 payload..."
  );

  /* -----------------------------------------------------
     CALL PAYM8
  ----------------------------------------------------- */

  const response =
    await fetch(
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
     READ PAYM8 RESPONSE
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

    /* ---------------------------------------------------
       CHECK WHETHER A VERY FAST CALLBACK WAS ALREADY
       STORED FOR THIS TOKEN.
    --------------------------------------------------- */

    if (token) {
      try {
        const pendingCallbackSnapshot =
          await db
            .ref(
              `paym8Callbacks/${token}`
            )
            .once("value");

        if (
          pendingCallbackSnapshot.exists()
        ) {
          console.log(
            "A pending PayM8 callback was already received."
          );

          await db
            .ref(
              `paymentTransactions/${merchantReference}`
            )
            .update({
              callbackReceived:
                true,

              callbackReceivedAt:
                new Date().toISOString(),

              callbackReconciled:
                true,

              updatedAt:
                new Date().toISOString()
            });

          await db
            .ref(
              `paym8Callbacks/${token}`
            )
            .update({
              reconciled:
                true,

              reconciledMerchantReference:
                merchantReference,

              reconciledAt:
                new Date().toISOString()
            });
        }
      } catch (
        callbackCheckError
      ) {
        console.error(
          "Pending callback check error:",
          callbackCheckError
        );
      }
    }

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

      walletCredited:
        false,

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
```

}
);

/* =========================================================
2. PAYM8 CALLBACK
========================================================= */

async function handlePayM8Callback(
req,
res
) {
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

const userId =
req.query.userId ||
(
req.body &&
req.body.userId
) ||
null;

const merchantReference =
req.query.merchantReference ||
(
req.body &&
(
req.body.merchantReference ||
req.body.merchantReferenceNumber
)
) ||
null;

console.log(
"Token received:",
token ? "YES" : "NO"
);

console.log(
"User ID received:",
userId ? "YES" : "NO"
);

console.log(
"Merchant reference received:",
merchantReference
? "YES"
: "NO"
);

if (token) {
console.log(
"Callback token:",
token
);
}

/* -----------------------------------------------------
Always record the callback first.

```
 This protects us if PayM8's callback arrives before
 our transaction token update has completed.
```

----------------------------------------------------- */

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

```
      userId:
        userId || null,

      merchantReference:
        merchantReference || null,

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
} catch (
  callbackSaveError
) {
  console.error(
    "Could not save PayM8 callback:",
    callbackSaveError
  );
}
```

}

/* -----------------------------------------------------
Try to find the transaction by token first.
----------------------------------------------------- */

let matchedTransaction =
null;

const maxLookupAttempts =
5;

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

```
  if (
    matchedTransaction
  ) {
    console.log(
      "Callback matched transaction on attempt:",
      attempt
    );

    break;
  }

  console.log(
    `Callback transaction lookup attempt ${attempt}/${maxLookupAttempts}: no match yet.`
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
    "Callback transaction lookup error:",
    lookupError
  );
}
```

}

/* -----------------------------------------------------
If PayM8 supplies a merchant reference, use it as
a second way of finding the transaction.
----------------------------------------------------- */

if (
!matchedTransaction &&
merchantReference
) {
try {
matchedTransaction =
await findTransactionByMerchantReference(
merchantReference
);

```
  if (
    matchedTransaction
  ) {
    console.log(
      "Callback matched transaction using merchant reference."
    );
  }
} catch (
  merchantReferenceError
) {
  console.error(
    "Merchant reference lookup error:",
    merchantReferenceError
  );
}
```

}

/* -----------------------------------------------------
UPDATE MATCHED TRANSACTION
----------------------------------------------------- */

if (
matchedTransaction &&
firebaseReady &&
db
) {
try {
await db
.ref(
`paymentTransactions/${matchedTransaction.key}`
)
.update({
callbackReceived:
true,

```
      callbackReceivedAt:
        new Date().toISOString(),

      callbackReconciled:
        true,

      status:
        "CALLBACK_RECEIVED",

      updatedAt:
        new Date().toISOString()
    });

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
```

} else {
console.log(
"Callback did not match a stored transaction after all lookup attempts."
);

```
console.log(
  "The callback has still been saved under paym8Callbacks."
);
```

}

/* -----------------------------------------------------
IMPORTANT:
NEVER credit wallet from callback alone.
----------------------------------------------------- */

return res.status(200).json({
received:
true,

```
matched:
  !!matchedTransaction,

walletCredited:
  false
```

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

app.get(
"/payment-status",
async (req, res) => {
try {
const rawToken =
req.query.token;

```
  const token =
    normalizeToken(rawToken);

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

  let transaction =
    null;

  let transactionKey =
    null;

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

  /* -----------------------------------------------------
     Check whether callback was recorded.
  ----------------------------------------------------- */

  let callbackRecord =
    null;

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

  let outcomeData =
    {};

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

  if (callbackRecord) {
    console.log(
      "Callback record found: YES"
    );
  } else {
    console.log(
      "Callback record found: NO"
    );
  }

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

     WALLET CREDITING IS STILL DISABLED.

     We will enable this only after we have confirmed
     the exact PayM8 FINAL SUCCESS response.
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

    callbackReceived:
      !!callbackRecord,

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
```

}
);

/* =========================================================
4. WALLET SUCCESS / PAYMENT RETURN PAGE
========================================================= */

app.get(
"/wallet-success",
(req, res) => {
const token =
req.query.token || "";

```
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

const safeToken =
  encodeURIComponent(
    normalizeToken(token) || ""
  );

res.status(200).send(`
```

<!DOCTYPE html>

<html>
<head>
  <meta charset="UTF-8">
  <title>Payment Verification</title>
</head>
<body>
  <h2>We are checking your payment.</h2>
  <p>Please wait...</p>

  <p>
    Payment token received:
    ${safeToken ? "YES" : "NO"}
  </p>

  <p>
    You may return to your wallet after verification.
  </p>
</body>
</html>
`);
  }
);

/* =========================================================
5. TEMPORARY PAYMENT OUTCOME DEBUG
========================================================= */

app.get(
"/debug/payment-outcome",
async (req, res) => {
try {
const rawToken =
req.query.token;

```
  const token =
    normalizeToken(rawToken);

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
    success:
      false,

    error:
      err.message
  });
}
```

}
);

/* =========================================================
6. ROOT
========================================================= */

app.get(
"/",
(req, res) => {
res.json({
success:
true,

```
  message:
    "Muustandi backend is online.",

  firebaseConfigured:
    firebaseReady,

  paym8Configured:
    !!PAYM8_AUTH_HEADER
});
```

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
