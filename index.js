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

    if (!userId || userId === "GUEST") {
      return res.status(400).json({ success: false, error: "You must be logged in to make a deposit." });
    }

    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || "102.165.0.1").split(',')[0].trim();
    const shortRef = `DEP${Date.now().toString().slice(-10)}`;
    const authHeader = "Basic " + Buffer.from("IamLizo:1Aml!zo#123").toString("base64");

    const payload = {
      merchantBranchProductNumber: "JQVSND",
      merchantClientProfile: "PMV00003",
      totalCostInCents: parseInt(amountInCents, 10),
      transactionDescription: "1Voucher Deposit",
      merchantReferenceNumber: shortRef,
      userHostAddress: clientIp,
      resultCallbackUrl: "https://muustandibackend.onrender.com/wallet-success",
      callbackUrl: "https://muustandibackend.onrender.com/api/1voucher/callback",
      paymentChannels: [
        {
          channelName: "1Voucher"
        }
      ],
      firstName: firstName || "Gamer",
      lastName: lastName || "Customer"
    };

    console.log("Sending Payload to PAYM8:", JSON.stringify(payload));

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
