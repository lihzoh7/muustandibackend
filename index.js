const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

const PORT = process.env.PORT || 8080;

app.post('/deposit/1voucher', async (req, res) => {
  try {
    const { amountInCents, userId, firstName, lastName } = req.body;

    if (!amountInCents || amountInCents < 500) {
      return res.status(400).json({ success: false, error: "Minimum deposit amount is R5 (500 cents)" });
    }

    // Generate a reference number guaranteed to be under 15 characters
    // Example: DEP + last 10 digits of timestamp
    const shortRef = `DEP-${Date.now().toString().slice(-10)}`;

    const authHeader = "Basic " + Buffer.from("IamLizo:1Aml!zo#123").toString("base64");

    const payload = {
      merchantBranchProductNumber: "JQVSND",
      totalCostInCents: parseInt(amountInCents, 10),
      transactionDescription: `1Voucher Deposit - ${userId || 'GUEST'}`,
      merchantReferenceNumber: shortRef,
      userHostAddress: "127.0.0.1",
      resultRedirectUrl: "https://muustandibackend.onrender.com/wallet-success",
      callbackUrl: "https://muustandibackend.onrender.com/api/1voucher/callback",
      paymentChannels: [
        {
          channelName: "OneVoucher",
          settings: null
        }
      ],
      merchantClientProfile: "PMV00003",
      FirstName: firstName || "Gamer",
      Lastname: lastName || "Customer"
    };

    const response = await fetch("https://paym8online.com/PaymentsService/api/V1/ecommerce/SubmitPaymentRequest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": authHeader,
        "MerchantClientProfile": "PMV00003",
        "MerchantBranchProductNumber": "JQVSND"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    console.log("PAYM8 Status Code:", response.status);
    console.log("PAYM8 Raw Response:", responseText);

    let data = {};
    if (responseText && responseText.trim().length > 0) {
      try {
        data = JSON.parse(responseText);
      } catch (parseErr) {
        console.error("Non-JSON response from gateway:", responseText);
      }
    }

    if (response.ok && data.data && data.data.submitWasSuccessful && data.data.redirectUri) {
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

    return res.status(400).json({
      success: false,
      error: gatewayError
    });

  } catch (err) {
    console.error("Voucher submission error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
