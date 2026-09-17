const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

const PORT = process.env.PORT || 8080;

// PayM8 Authorization header must be stored in Render Environment Variables.
// Example value in Render:
// Basic <your-base64-credential>
const PAYM8_AUTH_HEADER = process.env.PAYM8_AUTH_HEADER;

app.post('/deposit/1voucher', async (req, res) => {
  try {
    const {
      amountInCents,
      userId,
      firstName,
      lastName
    } = req.body;

    // --------------------------------------------------
    // 1. Validate amount
    // --------------------------------------------------
    if (!amountInCents || amountInCents < 500) {
      return res.status(400).json({
        success: false,
        error: 'Minimum deposit amount is R5 (500 cents)'
      });
    }

    // --------------------------------------------------
    // 2. Validate logged-in user
    // --------------------------------------------------
    if (!userId || userId === 'GUEST') {
      return res.status(400).json({
        success: false,
        error: 'You must be logged in to make a deposit.'
      });
    }

    // --------------------------------------------------
    // 3. Make sure PayM8 authentication exists
    // --------------------------------------------------
    if (!PAYM8_AUTH_HEADER) {
      console.error('PAYM8_AUTH_HEADER is not configured.');

      return res.status(500).json({
        success: false,
        error: 'PayM8 authentication is not configured on the server.'
      });
    }

    // --------------------------------------------------
    // 4. Get the client IP address
    // --------------------------------------------------
    const clientIp = (
      req.headers['x-forwarded-for'] ||
      req.socket.remoteAddress ||
      '127.0.0.1'
    )
      .split(',')[0]
      .trim();

    // --------------------------------------------------
    // 5. PayM8 merchant reference
    //
    // PayM8 confirmed this must be MAX 15 characters.
    // This creates a reference such as:
    // DEP-58040567
    // --------------------------------------------------
    const shortRef = `DEP-${Date.now().toString().slice(-8)}`;

    // --------------------------------------------------
    // 6. PayM8 callback URL
    //
    // {0} is supplied by PayM8 with the transaction token.
    // --------------------------------------------------
    const callbackUrl =
      `https://muustandibackend.onrender.com/api/1voucher/callback` +
      `?userId=${encodeURIComponent(userId)}&token={0}`;

    // --------------------------------------------------
    // 7. PayM8 payment request
    // --------------------------------------------------
    const payload = {
      merchantBranchProductNumber: 'JQVSND',

      merchantClientProfile: 'PMV00003',

      totalCostInCents: parseInt(amountInCents, 10),

      transactionDescription: '1Voucher Wallet Deposit',

      merchantReferenceNumber: shortRef,

      userHostAddress: clientIp,

      // IMPORTANT:
      // PayM8 confirmed this field is resultRedirectUrl,
      // not resultCallbackUrl.
      resultRedirectUrl:
        'https://muustandibackend.onrender.com/wallet-success?token={0}',

      callbackUrl: callbackUrl,

      // PayM8's corrected example uses OneVoucher
      // with settings set to null.
      paymentChannels: [
        {
          channelName: 'OneVoucher',
          settings: null
        }
      ],

      // PayM8's corrected field names.
      FirstName: firstName || 'Gamer',

      Lastname: lastName || 'Customer'
    };

    console.log(
      'Sending Payload to PAYM8:',
      JSON.stringify(payload)
    );

    // --------------------------------------------------
    // 8. Send request to PayM8
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
    // 9. Read PayM8 response safely
    // --------------------------------------------------
    const responseText = await response.text();

    console.log('PAYM8 Status Code:', response.status);

    console.log(
      'PAYM8 Raw Response:',
      responseText
    );

    let data = {};

    if (responseText && responseText.trim().length > 0) {
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
    // 10. Successful PayM8 payment request
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
        redirectUri: data.data.redirectUri,
        token: data.data.token
      });
    }

    // --------------------------------------------------
    // 11. PayM8 returned an error
    // --------------------------------------------------
    const gatewayError =
      (data.data && data.data.failureReason) ||
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

// --------------------------------------------------
// Start server
// --------------------------------------------------
app.listen(PORT, () => {
  console.log(
    `Server listening on port ${PORT}`
  );
});
