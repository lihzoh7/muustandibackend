const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;
const PAYM8_AUTH_HEADER = process.env.PAYM8_AUTH_HEADER;

/* =========================================================
   FIREBASE ADMIN INITIALIZATION
   ========================================================= */
if (
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      }),
      databaseURL: "https://tose-ccf8f-default-rtdb.europe-west1.firebasedatabase.app"
    });
    console.log('Firebase Admin initialized successfully.');
  } catch (fbErr) {
    console.error('Firebase Admin initialization error:', fbErr.message);
  }
} else {
  console.warn('Firebase environment variables missing. Wallet crediting will fail.');
}

const db = admin.apps.length ? admin.database() : null;

// Helper: Pause execution for delayed polling
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* =========================================================
   1. 1VOUCHER DEPOSIT INITIATION
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
      console.error('PAYM8_AUTH_HEADER is not configured.');
      return res.status(500).json({
        success: false,
        error: 'PayM8 authentication is not configured on the server.'
      });
    }

    const clientIp = (
      req.headers['x-forwarded-for'] ||
      req.socket.remoteAddress ||
      '127.0.0.1'
    ).split(',')[0].trim();

    const shortRef = `DEP-${Date.now().toString().slice(-8)}`;

    const callbackUrl =
      `https://muustandibackend.onrender.com/api/1voucher/callback` +
      `?userId=${encodeURIComponent(userId)}` +
      `&token={0}`;

    const payload = {
      merchantBranchProductNumber: 'JQVSND',
      merchantClientProfile: 'PMV00003',
      totalCostInCents: parseInt(amountInCents, 10),
      transactionDescription: '1Voucher Wallet Deposit',
      merchantReferenceNumber: shortRef,
      userHostAddress: clientIp,
      resultRedirectUrl: 'https://muustandibackend.onrender.com/wallet-success?userId=' + encodeURIComponent(userId) + '&token={0}',
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

    console.log('Sending Payload to PAYM8:', JSON.stringify(payload));

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
    console.log('PAYM8 Status Code:', response.status);
    console.log('PAYM8 Raw Response:', responseText);

    let data = {};
    if (responseText && responseText.trim().length > 0) {
      try {
        data = JSON.parse(responseText);
      } catch (parseErr) {
        console.error('Non-JSON response from gateway:', responseText);
      }
    }

    if (
      response.ok &&
      data.data &&
      data.data.submitWasSuccessful &&
      data.data.redirectUri
    ) {
      console.log('PAYM8 payment request successful.');

      if (db && data.data.token) {
        await db.ref(`transactions/${data.data.token}`).set({
          userId,
          amountInCents: parseInt(amountInCents, 10),
          merchantReference: shortRef,
          status: 'PENDING',
          createdAt: Date.now()
        });
      }

      return res.json({
        success: true,
        redirectUri: data.data.redirectUri,
        token: data.data.token
      });
    }

    const gatewayError =
      (data.data && data.data.failureReason) ||
      data.description ||
      data.errorMessage ||
      `Gateway error (HTTP ${response.status})`;

    return res.status(400).json({ success: false, error: gatewayError });

  } catch (err) {
    console.error('Voucher submission error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


/* =========================================================
   2. PAYM8 CALLBACK & AUTOMATIC SETTLEMENT (WITH POLLING)
   ========================================================= */

async function processSettlement(userId, token) {
  if (!db) {
    console.error('Cannot process settlement: Firebase DB not initialized.');
    return;
  }

  // Idempotency check
  const processedRef = db.ref(`processed_deposits/${token}`);
  const processedSnap = await processedRef.get();

  if (processedSnap.exists()) {
    console.log(`[SETTLEMENT] Token ${token} already processed. Skipping duplicate credit.`);
    return;
  }

  let outcomeData = {};
  let data = {};
  let attempts = 0;
  const maxAttempts = 4;

  // Poll PayM8 up to 4 times (with 2.5 second delays) if outcome is still pending
  while (attempts < maxAttempts) {
    attempts++;
    console.log(`[SETTLEMENT] Querying PayM8 outcome for token ${token} (Attempt ${attempts}/${maxAttempts})...`);

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

    const outcomeText = await outcomeResponse.text();
    console.log(`[SETTLEMENT] PayM8 GetPaymentOutcome (${token}):`, outcomeText);

    try {
      outcomeData = JSON.parse(outcomeText);
      data = outcomeData.data || {};
    } catch (e) {
      console.error('[SETTLEMENT] Failed to parse PayM8 response');
      return;
    }

    // Check if process completed
    if (data.lastCompletedStep >= 2 || data.outcomeCode === 'Faulted' || data.outcomeCode === '00' || data.outcomeCode === 0) {
      break;
    }

    if (attempts < maxAttempts) {
      console.log(`[SETTLEMENT] Transaction step incomplete (step ${data.lastCompletedStep}). Waiting 2.5s before re-checking...`);
      await sleep(2500);
    }
  }

  // Reject explicit failures/faults
  if (data.outcomeCode === 'Faulted' || (typeof data.outcomeCode === 'string' && data.outcomeCode.toLowerCase().includes('fault'))) {
    console.warn(`[SETTLEMENT FAILED] Transaction faulted for token ${token}: ${data.outcomeDescription}`);
    return;
  }

  // Verify successful completion
  const isSuccess = 
    outcomeData.result === 0 &&
    (data.outcomeCode === '00' || data.outcomeCode === 0 || data.outcomeCode === 'Success') &&
    data.lastCompletedStep >= 2;

  if (!isSuccess) {
    console.warn(`[SETTLEMENT SKIPPED] Outcome not verified as successful for token ${token}. Outcome code: ${data.outcomeCode}`);
    return;
  }

  const targetUserId = userId;
  if (!targetUserId) {
    console.error(`[SETTLEMENT ERROR] No userId provided in callback for token ${token}`);
    return;
  }

  let amountInCents = 0;

  if (data.merchantReference) {
    const txByRefSnap = await db.ref('transactions')
      .orderByChild('merchantReference')
      .equalTo(data.merchantReference)
      .once('value');

    if (txByRefSnap.exists()) {
      const txMap = txByRefSnap.val();
      const firstKey = Object.keys(txMap)[0];
      amountInCents = txMap[firstKey].amountInCents || 0;
    }
  }

  if (!amountInCents && data.totalCostInCents) {
    amountInCents = parseInt(data.totalCostInCents, 10);
  }

  if (!amountInCents || amountInCents <= 0) {
    console.error(`[SETTLEMENT ERROR] Could not determine valid deposit amount for token ${token}. Aborting credit.`);
    return;
  }

  const amountInRands = amountInCents / 100;

  // Lock processed token before crediting
  await processedRef.set({
    userId: targetUserId,
    amountInRands,
    merchantReference: data.merchantReference || 'UNKNOWN',
    processedAt: Date.now()
  });

  // Credit user wallet
  const walletRef = db.ref(`wallet/${targetUserId}/cashBalance`);
  await walletRef.transaction((currentBalance) => {
    return (currentBalance || 0) + amountInRands;
  });

  console.log(`[SETTLEMENT SUCCESS] Credited R${amountInRands.toFixed(2)} to wallet/${targetUserId}`);
}

async function handlePayM8Callback(req, res) {
  const userId = req.query.userId || null;
  const token = req.query.token || null;

  console.log('PAYM8 CALLBACK RECEIVED:', { userId, token, method: req.method });

  res.status(200).json({ received: true });

  if (token) {
    try {
      await processSettlement(userId, token);
    } catch (err) {
      console.error('[SETTLEMENT ERROR]', err.message);
    }
  }
}

app.post('/api/1voucher/callback', handlePayM8Callback);
app.get('/api/1voucher/callback', handlePayM8Callback);


/* =========================================================
   3. RESULT REDIRECT
   ========================================================= */

app.get('/wallet-success', async (req, res) => {
  const token = req.query.token || null;
  const userId = req.query.userId || null;

  if (token && db) {
    try {
      await processSettlement(userId, token);
    } catch (e) {
      console.error('Redirect settlement check failed:', e.message);
    }
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
        <p>Your payment has been processed and verified.</p>
        <p>Return to your wallet to view your updated balance.</p>
        <button onclick="window.close(); history.back();">RETURN TO WALLET</button>
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
