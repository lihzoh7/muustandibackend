const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

// PayM8 Authorization header must be stored in Render Environment Variables.
const PAYM8_AUTH_HEADER = process.env.PAYM8_AUTH_HEADER;


/* =========================================================
   1. 1VOUCHER DEPOSIT
   ========================================================= */

app.post('/deposit/1voucher', async (req, res) => {
  try {
    const {
      amountInCents,
      userId,
      firstName,
      lastName
    } = req.body;

    // --------------------------------------------------
    // Validate amount
    // --------------------------------------------------
    if (!amountInCents || amountInCents < 500) {
      return res.status(400).json({
        success: false,
        error: 'Minimum deposit amount is R5 (500 cents)'
      });
    }

    // --------------------------------------------------
    // Validate logged-in user
    // --------------------------------------------------
    if (!userId || userId === 'GUEST') {
      return res.status(400).json({
        success: false,
        error: 'You must be logged in to make a deposit.'
      });
    }

    // --------------------------------------------------
    // Make sure PayM8 authentication exists
    // --------------------------------------------------
    if (!PAYM8_AUTH_HEADER) {
      console.error(
        'PAYM8_AUTH_HEADER is not configured.'
      );

      return res.status(500).json({
        success: false,
        error:
          'PayM8 authentication is not configured on the server.'
      });
    }

    // --------------------------------------------------
    // Get client IP address
    // --------------------------------------------------
    const clientIp = (
      req.headers['x-forwarded-for'] ||
      req.socket.remoteAddress ||
      '127.0.0.1'
    )
      .split(',')[0]
      .trim();

    // --------------------------------------------------
    // PayM8 merchant reference
    // MAX 15 characters
    // --------------------------------------------------
    const shortRef =
      `DEP-${Date.now().toString().slice(-8)}`;

    // --------------------------------------------------
    // PayM8 callback URL
    // --------------------------------------------------
    const callbackUrl =
      `https://muustandibackend.onrender.com/api/1voucher/callback` +
      `?userId=${encodeURIComponent(userId)}` +
      `&token={0}`;

    // --------------------------------------------------
    // PayM8 payment request
    // --------------------------------------------------
    const payload = {
      merchantBranchProductNumber: 'JQVSND',

      merchantClientProfile: 'PMV00003',

      totalCostInCents:
        parseInt(amountInCents, 10),

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
          channelName: 'OneVoucher',
          settings: null
        }
      ],

      FirstName:
        firstName || 'Gamer',

      Lastname:
        lastName || 'Customer'
    };

    console.log(
      'Sending Payload to PAYM8:',
      JSON.stringify(payload)
    );

    // --------------------------------------------------
    // Send request to PayM8
    // --------------------------------------------------
    const response = await fetch(
      'https://paym8online.com/PaymentsService/api/V1/ecommerce/SubmitPaymentRequest',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': PAYM8_AUTH_HEADER
        },

        body: JSON.stringify(payload)
      }
    );

    // --------------------------------------------------
    // Read PayM8 response
    // --------------------------------------------------
    const responseText =
      await response.text();

    console.log(
      'PAYM8 Status Code:',
      response.status
    );

    console.log(
      'PAYM8 Raw Response:',
      responseText
    );

    let data = {};

    if (
      responseText &&
      responseText.trim().length > 0
    ) {
      try {
        data = JSON.parse(responseText);
      } catch (parseErr) {
        console.error(
          'Non-JSON response from gateway:',
          responseText
        );
      }
    }

    // --------------------------------------------------
    // Successful PayM8 payment request
    // --------------------------------------------------
    if (
      response.ok &&
      data.data &&
      data.data.submitWasSuccessful &&
      data.data.redirectUri
    ) {
      console.log(
        'PAYM8 payment request successful.'
      );

      console.log(
        'PAYM8 redirectUri:',
        data.data.redirectUri
      );

      return res.json({
        success: true,
        redirectUri:
          data.data.redirectUri,
        token:
          data.data.token
      });
    }

    // --------------------------------------------------
    // PayM8 returned an error
    // --------------------------------------------------
    const gatewayError =
      (data.data &&
        data.data.failureReason) ||
      data.description ||
      data.errorMessage ||
      `Gateway error (HTTP ${response.status})`;

    console.error(
      'PAYM8 payment request failed:',
      gatewayError
    );

    return res.status(400).json({
      success: false,
      error: gatewayError
    });

  } catch (err) {

    console.error(
      'Voucher submission error:',
      err
    );

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});


/* =========================================================
   2. PAYM8 CALLBACK
   ========================================================= */

function handlePayM8Callback(req, res) {

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
    'Callback HTTP Method:',
    req.method
  );

  console.log(
    'Callback Query:',
    JSON.stringify({
      userId: req.query.userId || null,
      tokenReceived:
        !!req.query.token
    })
  );

  console.log(
    'Callback Body:',
    JSON.stringify(req.body || {})
  );

  console.log(
    '=============================================='
  );
  console.log('');

  // --------------------------------------------------
  // IMPORTANT:
  // Do NOT credit wallet yet.
  // --------------------------------------------------

  return res.status(200).json({
    received: true
  });
}


// PayM8 may use POST
app.post(
  '/api/1voucher/callback',
  handlePayM8Callback
);


// Also accept GET for diagnostic purposes
app.get(
  '/api/1voucher/callback',
  handlePayM8Callback
);


/* =========================================================
   3. PAYM8 RESULT REDIRECT
   ========================================================= */

app.get('/wallet-success', (req, res) => {

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

  console.log(
    '=============================================='
  );
  console.log('');

  // --------------------------------------------------
  // DO NOT CREDIT WALLET HERE.
  // --------------------------------------------------

  res.status(200).send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
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
          box-shadow: 0 0 20px rgba(0,0,0,0.5);
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
      </style>
    </head>

    <body>

      <div class="box">

        <h1>PAYMENT RECEIVED</h1>

        <p>
          Your payment process has returned to
          the Muustandi payment server.
        </p>

        <p>
          We are verifying the transaction.
        </p>

        <button onclick="history.back()">
          RETURN
        </button>

      </div>

    </body>
    </html>
  `);
});


/* =========================================================
   4. TEMPORARY PAYM8 PAYMENT OUTCOME TEST
   =========================================================
   
   This route is ONLY for diagnosing the current
   PayM8 transaction.

   It uses PAYM8_AUTH_HEADER from Render.
   
   DO NOT enter your PayM8 username/password in
   the browser.

   REMOVE THIS ROUTE AFTER WE FINISH TESTING.
   ========================================================= */

app.get('/debug/payment-outcome', async (req, res) => {

  try {

    const token =
      req.query.token;

    // --------------------------------------------------
    // Check token
    // --------------------------------------------------
    if (!token) {

      return res.status(400).json({
        success: false,
        error: 'Missing transaction token.'
      });

    }

    // --------------------------------------------------
    // Check PayM8 authentication
    // --------------------------------------------------
    if (!PAYM8_AUTH_HEADER) {

      console.error(
        'PAYM8_AUTH_HEADER is not configured.'
      );

      return res.status(500).json({
        success: false,
        error:
          'PayM8 authentication is not configured on the server.'
      });

    }

    console.log('');
    console.log(
      '=============================================='
    );
    console.log(
      'PAYM8 GET PAYMENT OUTCOME TEST'
    );
    console.log(
      '=============================================='
    );

    console.log(
      'Transaction token received:',
      token
    );

    // --------------------------------------------------
    // Call PayM8
    // --------------------------------------------------
    const outcomeResponse = await fetch(
      `https://paym8online.com/PaymentsService/api/V1/ecommerce/GetPaymentOutcome/${encodeURIComponent(token)}`,
      {
        method: 'GET',

        headers: {
          'Accept': 'application/json',
          'Authorization': PAYM8_AUTH_HEADER
        }
      }
    );

    const outcomeText =
      await outcomeResponse.text();

    console.log(
      'PayM8 Outcome HTTP Status:',
      outcomeResponse.status
    );

    console.log(
      'PayM8 Outcome Response:',
      outcomeText
    );

    console.log(
      '=============================================='
    );
    console.log('');

    // --------------------------------------------------
    // Try to return JSON if PayM8 sent JSON
    // --------------------------------------------------
    let outcomeData;

    try {

      outcomeData =
        JSON.parse(outcomeText);

    } catch (parseErr) {

      outcomeData = {
        rawResponse:
          outcomeText
      };
    }

    return res.status(
      outcomeResponse.ok ? 200 : outcomeResponse.status
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
      'Get Payment Outcome error:',
      err
    );

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }

});


/* =========================================================
   5. SERVER START
   ========================================================= */

app.listen(PORT, () => {

  console.log(
    `Server listening on port ${PORT}`
  );

});
