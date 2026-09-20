const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

// PayM8 Authorization header stored in Environment Variables
const PAYM8_AUTH_HEADER = process.env.PAYM8_AUTH_HEADER;

/* =========================================================
   FIREBASE ADMIN INITIALIZATION
   ========================================================= */
if (process.env.FIREBASE_CONFIG_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://tose-ccf8f-default-rtdb.europe-west1.firebasedatabase.app"
    });
    console.log("Firebase Admin SDK initialized successfully.");
  } catch (err) {
    console.error("Failed to parse FIREBASE_CONFIG_JSON:", err.message);
  }
} else {
  console.warn("WARNING: FIREBASE_CONFIG_JSON is not set in environment variables.");
}

const db = admin.apps.length ? admin.database() : null;

/* =========================================================
   HELPER: SETTLE & CREDIT TRANSACTION (IDEMPOTENT)
   ========================================================= */
async function processTransactionOutcome(token) {
  if (!db) {
    return { success: false, error: 'Database instance unavailable' };
  }

  const txRef = db.ref(`transactions/${token}`);
  const txSnap = await txRef.get();

  if (!txSnap.exists()) {
    return { success: false, error: 'Transaction record not found' };
  }

  const txData = txSnap.val();

  // Guard against duplicate processing
  if (txData.processed) {
    console.log(`Transaction ${token} already processed. Skipping duplicate credit.`);
    return { success: true, alreadyProcessed: true, amount: txData.amountInRands };
  }

  // Query PayM8 API for final verification
  const outcomeUrl = `https://paym8online.com/PaymentsService/api/V1/ecommerce/GetPaymentOutcome/${encodeURIComponent(token)}`;
  const outcomeResponse = await fetch(outcomeUrl, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': PAYM8_AUTH_HEADER
    }
  });

  const outcomeText = await outcomeResponse.text();
  let outcomeData = {};

  try {
    outcomeData = JSON.parse(outcomeText);
  } catch (e) {
    console.error("Non-JSON PayM8 Outcome response:", outcomeText);
  }

  console.log(`GetPaymentOutcome for ${token}:`, JSON.stringify(outcomeData));

  // Determine if payment is confirmed
  // PayM8 returns result === 0 or resultToString === "Success"
  const isSuccess = outcomeData && (
    outcomeData.result === 0 || 
    outcomeData.resultToString === "Success" ||
    (outcomeData.data && outcomeData.data.lastCompletedStep >= 1)
  );

  if (isSuccess) {
    const userId = txData.userId;
    const amountInRands = txData.amountInRands;

    // Credit user cashBalance atomically
    const userWalletRef = db.ref(`wallet/${userId}`);
    await userWalletRef.transaction((currentData) => {
      if (!currentData) {
        currentData = { cashBalance: 0, gems: 0, lives: 0 };
      }
      currentData.cashBalance = parseFloat(((currentData.cashBalance || 0) + amountInRands).toFixed(2));
      return currentData;
    });

    // Mark transaction as completed to prevent duplicate credits
    await txRef.update({
      processed: true,
      status: 'SUCCESS',
      settledAt: new Date().toISOString(),
      rawOutcome: outcomeData
    });

    console.log(`SUCCESS: R${amountInRands} credited to user ${userId}`);
    return { success: true, credited: amountInRands };
  } else {
    await txRef.update({
      status: 'FAILED_OR_PENDING',
      rawOutcome: outcomeData
    });
    return { success: false, error: 'Payment outcome pending or failed' };
  }
}

/* =========================================================
   1. 1VOUCHER DEPOSIT
   ========================================================= */
app.post('/deposit/1voucher', async (req, res) => {
  try {
    const { amountInCents, userId, firstName, lastName } = req.body;

    if (!amountInCents || amountInCents < 500) {
      return res.status(400).json({
        success: false,
        error: 'Minimum deposit amount is R5 (500 cents)'
      });
    }

    if (!userId || userId === 'GUEST') {
      return res.status(400).json({
        success: false,
        error: 'You must be logged in to make a deposit.'
      });
    }

    if (!PAYM8_AUTH_HEADER) {
      return res.status(500).json({
        success: false,
        error: 'PayM8 authentication is not configured on the server.'
      });
    }

    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1')
      .split(',')[0]
      .trim();

    const shortRef = `DEP-${Date.now().toString().slice(-8)}`;
    const callbackUrl = `https://muustandibackend.onrender.com/api/1voucher/callback?userId=${encodeURIComponent(userId)}&token={0}`;

    const payload = {
      merchantBranchProductNumber: 'JQVSND',
      merchantClientProfile: 'PMV00003',
      totalCostInCents: parseInt(amountInCents, 10),
      transactionDescription: '1Voucher Wallet Deposit',
      merchantReferenceNumber: shortRef,
      userHostAddress: clientIp,
      resultRedirectUrl: 'https://muustandibackend.onrender.com/wallet-success?token={0}',
      callbackUrl: callbackUrl,
      paymentChannels: [
        {
          channelName: 'OneVoucher',
          settings: null
        }
      ],
      FirstName: firstName || 'Gamer',
      Lastname: lastName || 'Customer'
    };

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

    const responseText = await response.text();
    let data = {};

    if (responseText && responseText.trim().length > 0) {
      try {
        data = JSON.parse(responseText);
      } catch (parseErr) {
        console.error('Non-JSON response from gateway:', responseText);
      }
    }

    if (response.ok && data.data && data.data.submitWasSuccessful && data.data.redirectUri) {
      const transactionToken = data.data.token;
      const amountInRands = parseInt(amountInCents, 10) / 100;

      // Save initial pending transaction in database
      if (db && transactionToken) {
        await db.ref(`transactions/${transactionToken}`).set({
          userId: userId,
          amountInCents: parseInt(amountInCents, 10),
          amountInRands: amountInRands,
          merchantReference: shortRef,
          status: 'PENDING',
          processed: false,
          createdAt: new Date().toISOString()
        });
      }

      return res.json({
        success: true,
        redirectUri: data.data.redirectUri,
        token: transactionToken
      });
    }

    const gatewayError = (data.data && data.data.failureReason) || data.description || data.errorMessage || `Gateway error (HTTP ${response.status})`;
    return res.status(400).json({ success: false, error: gatewayError });

  } catch (err) {
    console.error('Voucher submission error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* =========================================================
   2. PAYM8 CALLBACK
   ========================================================= */
async function handlePayM8Callback(req, res) {
  const token = req.query.token || req.body.token || req.query.transactionToken;
  console.log('PAYM8 CALLBACK RECEIVED. Token:', token);

  if (token) {
    // Asynchronously resolve and credit in background
    processTransactionOutcome(token).catch(err => {
      console.error('Callback processing exception:', err.message);
    });
  }

  // Always acknowledge callback immediately
  return res.status(200).json({ received: true });
}

app.post('/api/1voucher/callback', handlePayM8Callback);
app.get('/api/1voucher/callback', handlePayM8Callback);

/* =========================================================
   3. PAYM8 RESULT REDIRECT
   ========================================================= */
app.get('/wallet-success', async (req, res) => {
  const token = req.query.token;

  if (token) {
    await processTransactionOutcome(token).catch(err => {
      console.error('Redirect verification exception:', err.message);
    });
  }

  res.status(200).send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Payment Verification</title>
      <style>
        body {
          margin: 0; min-height: 100vh; display: flex;
          justify-content: center; align-items: center;
          background: #001f3f; color: white; font-family: Arial, sans-serif;
          text-align: center;
        }
        .box {
          width: 90%; max-width: 450px; padding: 30px;
          background: #001428; border-radius: 12px;
          box-shadow: 0 0 20px rgba(0,0,0,0.5);
        }
        h1 { color: #00f0ff; }
        p { line-height: 1.6; }
        button {
          padding: 12px 20px; border: none; border-radius: 6px;
          background: #00f0ff; color: #001f3f; font-weight: bold;
          cursor: pointer; margin-top: 15px;
        }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>PAYMENT PROCESSED</h1>
        <p>Your payment status has been verified and updated.</p>
        <button onclick="window.location.href='/'">RETURN TO WALLET</button>
      </div>
    </body>
    </html>
  `);
});

/* =========================================================
   4. SERVER START
   ========================================================= */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
