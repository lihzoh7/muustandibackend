const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

const PORT = process.env.PORT || 8080;

app.post('/deposit/1voucher', async (req, res) => {
  try {
    const { amountInCents, userId, voucherPin } = req.body;

    if (!amountInCents || amountInCents < 500) {
      return res.status(400).json({ success: false, error: "Minimum amount is R5 (500 cents)" });
    }

    if (!voucherPin) {
      return res.status(400).json({ success: false, error: "Voucher PIN is required" });
    }

    // Basic Auth credentials confirmed by Paul Strydom
    const authHeader = "Basic " + Buffer.from("IamLizo:1Aml!zo#123").toString("base64");

    const payload = {
      merchantBranchProductNumber: "JQVSND",
      totalCostInCents: parseInt(amountInCents, 10), // Dynamically uses the exact voucher value
      transactionDescription: `1Voucher Wallet Deposit - ${userId}`,
      merchantReferenceNumber: `DEP-${Date.now()}`,
      userHostAddress: "127.0.0.1",
      resultRedirectUrl: "https://backend-475447495901.europe-west1.run.app/wallet-success",
      callbackUrl: "https://backend-475447495901.europe-west1.run.app/api/1voucher/callback",
      cartItems: null,
      paymentChannels: [
        {
          channelName: "OneVoucher",
          settings: {
            pin: voucherPin // Passes PIN if PAYM8 supports direct channel PIN processing
          }
        }
      ],
      merchantClientProfile: "PMV00003"
    };

    const response = await fetch("https://paym8online.com/PaymentsService/api/V1/ecommerce/SubmitPaymentRequest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": authHeader
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log("PAYM8 Response:", data);

    if (response.ok && data.redirectUrl) {
      return res.json({ success: true, redirectUri: data.redirectUrl });
    } else {
      return res.status(400).json({ 
        success: false, 
        error: data.errorMessage || data.message || "Voucher rejected by gateway." 
      });
    }

  } catch (err) {
    console.error("Voucher submission error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
