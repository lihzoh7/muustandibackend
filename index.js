const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;


/* =========================================================
   ENVIRONMENT VARIABLES
   ========================================================= */

const PAYM8_AUTH_HEADER =
  process.env.PAYM8_AUTH_HEADER;

const FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID;

const FIREBASE_CLIENT_EMAIL =
  process.env.FIREBASE_CLIENT_EMAIL;

const FIREBASE_PRIVATE_KEY =
  process.env.FIREBASE_PRIVATE_KEY;


/* =========================================================
   FIREBASE ADMIN INITIALIZATION
   ========================================================= */

let firebaseReady = false;

try {

  if (
    FIREBASE_PROJECT_ID &&
    FIREBASE_CLIENT_EMAIL &&
    FIREBASE_PRIVATE_KEY
  ) {

    const privateKey =
      FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey
      })
    });

    firebaseReady = true;

    console.log(
      'Firebase Admin initialized successfully.'
    );

  } else {

    console.error(
      'Firebase environment variables are missing.'
    );

  }

} catch (err) {

  console.error(
    'Firebase Admin initialization failed:',
    err
  );

}


const db = firebaseReady
  ? admin.database()
  : null;


/* =========================================================
   CONSTANTS
   ========================================================= */

const PAYM8_SUBMIT_URL =
  'https://paym8online.com/PaymentsService/api/V1/ecommerce/SubmitPaymentRequest';

const PAYM8_OUTCOME_URL =
  'https://paym8online.com/PaymentsService/api/V1/ecommerce/GetPaymentOutcome';


/* =========================================================
   HELPER: CHECK REQUIRED SERVICES
   ========================================================= */

function servicesReady() {

  return (
    firebaseReady &&
    !!PAYM8_AUTH_HEADER
  );

}


/* =========================================================
   HELPER: CALL PAYM8 GET PAYMENT OUTCOME
   ========================================================= */

async function getPaym8Outcome(token) {

  if (!token) {

    throw new Error(
      'Missing PayM8 transaction token.'
    );

  }

  if (!PAYM8_AUTH_HEADER) {

    throw new Error(
      'PAYM8_AUTH_HEADER is not configured.'
    );

  }

  const url =
    `${PAYM8_OUTCOME_URL}/${encodeURIComponent(token)}`;

  console.log('');
  console.log(
    '----------------------------------------------'
  );
  console.log(
    'GETTING PAYM8 PAYMENT OUTCOME'
  );
  console.log(
    'Token:',
    token
  );
  console.log(
    '----------------------------------------------'
  );

  const response = await fetch(
    url,
    {
      method: 'GET',

      headers: {
        'Accept': 'application/json',
        'Authorization': PAYM8_AUTH_HEADER
      }
    }
  );

  const responseText =
    await response.text();

  console.log(
    'PayM8 Outcome HTTP Status:',
    response.status
  );

  console.log(
    'PayM8 Outcome Raw Response:',
    responseText
  );

  let data = {};

  if (
    responseText &&
    responseText.trim().length > 0
  ) {

    try {

      data = JSON.parse(responseText);

    } catch (err) {

      data = {
        rawResponse: responseText
      };

    }

  }

  return {
    httpStatus: response.status,
    httpOk: response.ok,
    data: data
  };

}


/* =========================================================
   HELPER: INTERPRET PAYM8 OUTCOME
   ========================================================= */

function interpretPaym8Outcome(outcomeResponse) {

  const root =
    outcomeResponse.data || {};

  const data =
    root.data || {};

  const lastCompletedStep =
    data.lastCompletedStep ?? null;

  const outcomeCode =
    data.outcomeCode ?? null;

  const outcomeDescription =
    data.outcomeDescription ?? '';

  const errorSourceSystem =
    data.errorSourceSystem ?? null;

  const errorCodes =
    data.errorCodes ?? [];

  /*
   * IMPORTANT:
   *
   * We deliberately do NOT treat:
   *
   * result: 0
   *
   * as payment success.
   *
   * We also do NOT treat:
   *
   * lastCompletedStep: 1
   *
   * as payment success.
   *
   * The current problem we are investigating is
   * exactly that PayM8 can return HTTP 200 / result 0
   * while outcomeCode is still null.
   */

  if (
    outcomeCode !== null &&
    outcomeCode !== undefined &&
    String(outcomeCode).trim() !== ''
  ) {

    return {
      status: 'OUTCOME_RECEIVED',
      safeToCredit: false,
      lastCompletedStep,
      outcomeCode,
      outcomeDescription,
      errorSourceSystem,
      errorCodes
    };

  }

  return {
    status: 'PENDING',
    safeToCredit: false,
    lastCompletedStep,
    outcomeCode,
    outcomeDescription,
    errorSourceSystem,
    errorCodes
  };

}


/* =========================================================
   HELPER: SAVE TRANSACTION
   ========================================================= */

async function saveTransaction(
  merchantReference,
  transactionData
) {

  if (!db) {

    throw new Error(
      'Firebase is not initialized.'
    );

  }

  const ref =
    db.ref(
      `paymentTransactions/${merchantReference}`
    );

  await ref.set({
    ...transactionData,

    merchantReference,

    createdAt:
      transactionData.createdAt ||
      new Date().toISOString(),

    updatedAt:
      new Date().toISOString(),

    walletCredited: false,

    status:
      transactionData.status ||
      'CREATED'
  });

}


/* =========================================================
   HELPER: FIND TRANSACTION BY TOKEN
   ========================================================= */

async function findTransactionByToken(token) {

  if (!db) {

    throw new Error(
      'Firebase is not initialized.'
    );

  }

  const snapshot =
    await db
      .ref('paymentTransactions')
      .orderByChild('token')
      .equalTo(token)
      .once('value');

  if (!snapshot.exists()) {

    return null;

  }

  let result = null;

  snapshot.forEach(child => {

    if (!result) {

      result = {
        key: child.key,
        ...child.val()
      };

    }

  });

  return result;

}


/* =========================================================
   HELPER: UPDATE TRANSACTION
   ========================================================= */

async function updateTransaction(
  merchantReference,
  updates
) {

  if (!db) {

    throw new Error(
      'Firebase is not initialized.'
    );

  }

  await db
    .ref(
      `paymentTransactions/${merchantReference}`
    )
    .update({
      ...updates,
      updatedAt:
        new Date().toISOString()
    });

}


/* =========================================================
   1. HEALTH CHECK
   ========================================================= */

app.get('/health', (req, res) => {

  res.status(200).json({

    success: true,

    server: 'online',

    firebaseConfigured:
      firebaseReady,

    paym8Configured:
      !!PAYM8_AUTH_HEADER,

    timestamp:
      new Date().toISOString()

  });

});


/* =========================================================
   2. 1VOUCHER DEPOSIT
   ========================================================= */

app.post('/deposit/1voucher', async (req, res) => {

  try {

    const {
      amountInCents,
      userId,
      firstName,
      lastName
    } = req.body;


    /* -----------------------------------------------------
       VALIDATION
       ----------------------------------------------------- */

    if (
      !amountInCents ||
      Number(amountInCents) < 500
    ) {

      return res.status(400).json({

        success: false,

        error:
          'Minimum deposit amount is R5 (500 cents).'

      });

    }


    if (
      !userId ||
      userId === 'GUEST'
    ) {

      return res.status(400).json({

        success: false,

        error:
          'You must be logged in to make a deposit.'

      });

    }


    if (!firebaseReady) {

      return res.status(500).json({

        success: false,

        error:
          'Firebase is not configured on the backend.'

      });

    }


    if (!PAYM8_AUTH_HEADER) {

      return res.status(500).json({

        success: false,

        error:
          'PayM8 authentication is not configured.'

      });

    }


    /* -----------------------------------------------------
       NORMALIZE AMOUNT
       ----------------------------------------------------- */

    const depositCents =
      parseInt(amountInCents, 10);


    if (
      !Number.isInteger(depositCents) ||
      depositCents < 500
    ) {

      return res.status(400).json({

        success: false,

        error:
          'Invalid deposit amount.'

      });

    }


    /* -----------------------------------------------------
       GET CLIENT IP
       ----------------------------------------------------- */

    const clientIp = (

      req.headers['x-forwarded-for'] ||

      req.socket.remoteAddress ||

      '127.0.0.1'

    )
      .split(',')[0]
      .trim();


    /* -----------------------------------------------------
       MERCHANT REFERENCE
       MAX 15 CHARACTERS
       ----------------------------------------------------- */

    const shortRef =
      `DEP-${Date.now().toString().slice(-8)}`;


    /* -----------------------------------------------------
       CALLBACK URL
       ----------------------------------------------------- */

    const callbackUrl =
      `https://muustandibackend.onrender.com/api/1voucher/callback` +
      `?userId=${encodeURIComponent(userId)}` +
      `&token={0}`;


    /* -----------------------------------------------------
       CREATE TRANSACTION RECORD BEFORE PAYM8
       ----------------------------------------------------- */

    await saveTransaction(

      shortRef,

      {

        userId,

        amountInCents:
          depositCents,

        amountRand:
          depositCents / 100,

        firstName:
          firstName || 'Gamer',

        lastName:
          lastName || 'Customer',

        status:
          'CREATED',

        token:
          null,

        walletCredited:
          false

      }

    );


    console.log('');
    console.log(
      '=============================================='
    );
    console.log(
      'NEW 1VOUCHER TRANSACTION'
    );
    console.log(
      'Merchant Reference:',
      shortRef
    );
    console.log(
      'User ID:',
      userId
    );
    console.log(
      'Amount:',
      `R${(depositCents / 100).toFixed(2)}`
    );
    console.log(
      '=============================================='
    );


    /* -----------------------------------------------------
       PAYM8 PAYMENT REQUEST
       ----------------------------------------------------- */

    const payload = {

      merchantBranchProductNumber:
        'JQVSND',

      merchantClientProfile:
        'PMV00003',

      totalCostInCents:
        depositCents,

      transactionDescription:
        '1Voucher Wallet Deposit',

      merchantReferenceNumber:
        shortRef,

      userHostAddress:
        clientIp,

      resultRedirectUrl:
        'https://muustandibackend.onrender.com/wallet-success?token={0}',

      callbackUrl:
        callbackUrl,

      paymentChannels: [

        {

          channelName:
            'OneVoucher',

          settings:
            null

        }

      ],

      FirstName:
        firstName || 'Gamer',

      Lastname:
        lastName || 'Customer'

    };


    console.log(
      'Sending Payload to PAYM8:'
    );

    console.log(
      JSON.stringify(payload)
    );


    /* -----------------------------------------------------
       SEND TO PAYM8
       ----------------------------------------------------- */

    const response =
      await fetch(
        PAYM8_SUBMIT_URL,
        {

          method: 'POST',

          headers: {

            'Content-Type':
              'application/json',

            'Accept':
              'application/json',

            'Authorization':
              PAYM8_AUTH_HEADER

          },

          body:
            JSON.stringify(payload)

        }
      );


    const responseText =
      await response.text();


    console.log(
      'PAYM8 Submit HTTP Status:',
      response.status
    );

    console.log(
      'PAYM8 Submit Raw Response:',
      responseText
    );


    let data = {};


    if (
      responseText &&
      responseText.trim().length > 0
    ) {

      try {

        data =
          JSON.parse(responseText);

      } catch (err) {

        console.error(
          'Could not parse PayM8 response as JSON.'
        );

      }

    }


    /* -----------------------------------------------------
       PAYM8 REQUEST FAILED
       ----------------------------------------------------- */

    if (
      !response.ok ||
      !data.data ||
      !data.data.submitWasSuccessful ||
      !data.data.redirectUri
    ) {

      const gatewayError =

        (
          data.data &&
          data.data.failureReason
        ) ||

        data.description ||

        data.errorMessage ||

        `Gateway error (HTTP ${response.status})`;


      await updateTransaction(

        shortRef,

        {

          status:
            'SUBMIT_FAILED',

          submitHttpStatus:
            response.status,

          submitResponse:
            data,

          error:
            gatewayError

        }

      );


      console.error(
        'PAYM8 payment request failed:',
        gatewayError
      );


      return res.status(400).json({

        success: false,

        error:
          gatewayError

      });

    }


    /* -----------------------------------------------------
       SAVE PAYM8 TOKEN
       ----------------------------------------------------- */

    const token =
      data.data.token || null;


    await updateTransaction(

      shortRef,

      {

        status:
          'REDIRECTED_TO_PAYM8',

        token:

          token ||

          null,

        paym8SubmitResponse:
          data

      }

    );


    console.log(
      'PAYM8 payment request accepted.'
    );

    console.log(
      'PAYM8 Redirect:',
      data.data.redirectUri
    );

    console.log(
      'PAYM8 Token:',
      token || 'NOT RETURNED'
    );


    return res.json({

      success: true,

      redirectUri:
        data.data.redirectUri,

      token:
        token

    });


  } catch (err) {

    console.error(
      'Voucher submission error:',
      err
    );


    return res.status(500).json({

      success: false,

      error:
        err.message

    });

  }

});


/* =========================================================
   3. PAYM8 CALLBACK
   ========================================================= */

async function handlePayM8Callback(req, res) {

  console.log('');
  console.log(
    '=============================================='
  );
  console.log(
    'PAYM8 CALLBACK RECEIVED'
  );
  console.log(
    '=============================================='
  );

  console.log(
    'HTTP Method:',
    req.method
  );

  const token =
    req.query.token ||
    (req.body && req.body.token) ||
    null;

  const userId =
    req.query.userId ||
    (req.body && req.body.userId) ||
    null;


  console.log(
    'Token received:',
    token ? 'YES' : 'NO'
  );

  console.log(
    'User ID supplied:',
    userId ? 'YES' : 'NO'
  );

  console.log(
    'Callback body:',
    JSON.stringify(req.body || {})
  );


  if (!token) {

    console.error(
      'PAYM8 callback did not contain a token.'
    );

    return res.status(200).json({

      received: true,

      status:
        'NO_TOKEN'

    });

  }


  try {

    const transaction =
      await findTransactionByToken(token);


    if (!transaction) {

      console.error(
        'No local transaction found for PayM8 token:',
        token
      );

      /*
       * We still return HTTP 200 so PayM8 knows
       * the callback endpoint is alive.
       */

      return res.status(200).json({

        received: true,

        status:
          'TRANSACTION_NOT_FOUND'

      });

    }


    console.log(
      'Local transaction found:',
      transaction.merchantReference
    );


    /* -----------------------------------------------------
       GET CURRENT PAYM8 OUTCOME
       ----------------------------------------------------- */

    const outcome =
      await getPaym8Outcome(token);


    const interpretation =
      interpretPaym8Outcome(outcome);


    console.log(
      'PAYM8 interpretation:',
      JSON.stringify(
        interpretation
      )
    );


    await updateTransaction(

      transaction.merchantReference,

      {

        status:
          interpretation.status,

        lastCompletedStep:
          interpretation.lastCompletedStep,

        outcomeCode:
          interpretation.outcomeCode,

        outcomeDescription:
          interpretation.outcomeDescription,

        errorSourceSystem:
          interpretation.errorSourceSystem,

        errorCodes:
          interpretation.errorCodes,

        lastPaym8Response:
          outcome.data,

        callbackReceivedAt:
          new Date().toISOString()

      }

    );


  } catch (err) {

    console.error(
      'Callback processing error:',
      err
    );

  }


  /*
   * Always acknowledge the callback.
   *
   * IMPORTANT:
   * No wallet credit occurs here in Stage 1.
   */

  return res.status(200).json({

    received: true

  });

}


app.post(
  '/api/1voucher/callback',
  handlePayM8Callback
);


app.get(
  '/api/1voucher/callback',
  handlePayM8Callback
);


/* =========================================================
   4. PAYMENT STATUS
   ========================================================= */

app.get(
  '/payment-status',
  async (req, res) => {

    try {

      const token =
        req.query.token;


      if (!token) {

        return res.status(400).json({

          success: false,

          error:
            'Missing transaction token.'

        });

      }


      const transaction =
        await findTransactionByToken(token);


      if (!transaction) {

        return res.status(404).json({

          success: false,

          status:
            'NOT_FOUND',

          error:
            'Transaction was not found.'

        });

      }


      /*
       * Ask PayM8 for the latest outcome every time
       * the customer checks the payment status.
       */

      const outcome =
        await getPaym8Outcome(token);


      const interpretation =
        interpretPaym8Outcome(outcome);


      await updateTransaction(

        transaction.merchantReference,

        {

          status:
            interpretation.status,

          lastCompletedStep:
            interpretation.lastCompletedStep,

          outcomeCode:
            interpretation.outcomeCode,

          outcomeDescription:
            interpretation.outcomeDescription,

          errorSourceSystem:
            interpretation.errorSourceSystem,

          errorCodes:
            interpretation.errorCodes,

          lastPaym8Response:
            outcome.data

        }

      );


      return res.json({

        success: true,

        status:
          interpretation.status,

        safeToCredit:
          false,

        merchantReference:
          transaction.merchantReference,

        amountInCents:
          transaction.amountInCents,

        amountRand:
          transaction.amountRand,

        walletCredited:
          transaction.walletCredited || false,

        lastCompletedStep:
          interpretation.lastCompletedStep,

        outcomeCode:
          interpretation.outcomeCode,

        outcomeDescription:
          interpretation.outcomeDescription,

        errorSourceSystem:
          interpretation.errorSourceSystem,

        errorCodes:
          interpretation.errorCodes

      });


    } catch (err) {

      console.error(
        'Payment status error:',
        err
      );


      return res.status(500).json({

        success: false,

        error:
          err.message

      });

    }

  }
);


/* =========================================================
   5. PAYM8 RESULT REDIRECT
   ========================================================= */

app.get(
  '/wallet-success',
  async (req, res) => {

    const token =
      req.query.token || null;


    console.log('');
    console.log(
      '=============================================='
    );
    console.log(
      'PAYM8 RESULT REDIRECT RECEIVED'
    );
    console.log(
      '=============================================='
    );

    console.log(
      'Token received:',
      token ? 'YES' : 'NO'
    );


    if (!token) {

      return res.status(400).send(`

        <!DOCTYPE html>

        <html>

        <head>

          <meta charset="UTF-8">

          <title>Payment Error</title>

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
              color: #ff5555;
            }

          </style>

        </head>

        <body>

          <div class="box">

            <h1>PAYMENT ERROR</h1>

            <p>
              No PayM8 transaction token was received.
            </p>

          </div>

        </body>

        </html>

      `);

    }


    /*
     * The browser will use JavaScript to repeatedly
     * ask our backend for the latest PayM8 status.
     */

    const statusUrl =
      `/payment-status?token=${encodeURIComponent(token)}`;


    res.status(200).send(`

      <!DOCTYPE html>

      <html>

      <head>

        <meta charset="UTF-8">

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0"
        >

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


          #status {

            line-height: 1.7;

            margin-top: 20px;

          }


          button {

            padding: 12px 20px;

            border: none;

            border-radius: 6px;

            background: #00f0ff;

            color: #001f3f;

            font-weight: bold;

            cursor: pointer;

            margin-top: 20px;

          }

        </style>

      </head>


      <body>

        <div class="box">

          <h1 id="heading">
            VERIFYING PAYMENT
          </h1>

          <p id="status">
            We are checking your payment with PayM8.
          </p>

          <button
            onclick="history.back()"
          >
            RETURN
          </button>

        </div>


        <script>

          const statusUrl =
            ${JSON.stringify(statusUrl)};

          let attempts = 0;

          const maxAttempts = 10;


          async function checkPayment() {

            attempts++;


            try {

              const response =
                await fetch(statusUrl, {
                  cache: 'no-store'
                });


              const data =
                await response.json();


              console.log(
                'Payment status:',
                data
              );


              if (
                data.status ===
                'PENDING'
              ) {

                document.getElementById(
                  'heading'
                ).textContent =
                  'PAYMENT PENDING';


                document.getElementById(
                  'status'
                ).textContent =
                  'PayM8 has not yet returned a final payment outcome. We will not credit your wallet until the transaction is confirmed.';


              } else if (
                data.status ===
                'OUTCOME_RECEIVED'
              ) {

                document.getElementById(
                  'heading'
                ).textContent =
                  'PAYMENT OUTCOME RECEIVED';


                document.getElementById(
                  'status'
                ).textContent =
                  'PayM8 has returned an outcome. The transaction is being held for final verification before wallet crediting.';


                return;


              } else {

                document.getElementById(
                  'status'
                ).textContent =
                  'Current payment status: ' +
                  data.status;

              }


            } catch (error) {

              console.error(
                'Payment status check failed:',
                error
              );


              document.getElementById(
                'status'
              ).textContent =
                'We are still trying to check the payment status.';

            }


            if (
              attempts < maxAttempts
            ) {

              setTimeout(
                checkPayment,
                3000
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
   6. TEMPORARY DEBUG PAYMENT OUTCOME
   ========================================================= */

app.get(
  '/debug/payment-outcome',
  async (req, res) => {

    try {

      const token =
        req.query.token;


      if (!token) {

        return res.status(400).json({

          success: false,

          error:
            'Missing transaction token.'

        });

      }


      const outcome =
        await getPaym8Outcome(token);


      return res.status(
        outcome.httpOk
          ? 200
          : outcome.httpStatus
      ).json({

        success:
          outcome.httpOk,

        paym8HttpStatus:
          outcome.httpStatus,

        outcome:
          outcome.data

      });


    } catch (err) {

      console.error(
        'Debug payment outcome error:',
        err
      );


      return res.status(500).json({

        success: false,

        error:
          err.message

      });

    }

  }
);


/* =========================================================
   7. SERVER START
   ========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `Server listening on port ${PORT}`
    );

    console.log(
      'Firebase configured:',
      firebaseReady
    );

    console.log(
      'PayM8 configured:',
      !!PAYM8_AUTH_HEADER
    );

  }
);
