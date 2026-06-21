// ─── CareGuide Backend ───────────────────────────────────────────────────────
// Minimal server that keeps email credentials off the extension. The only
// route the extension currently calls is POST /send-email.

const express = require("express");
const nodemailer = require("nodemailer");

const PORT = process.env.PORT || 3000;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

const app = express();
app.use(express.json());

const transporter = (EMAIL_USER && EMAIL_PASS)
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    })
  : null;

app.post("/send-email", async (req, res) => {
  const { to, message } = req.body || {};

  if (!to || !message) {
    return res.status(400).json({ success: false, error: "Missing 'to' or 'message'." });
  }

  if (!transporter) {
    console.error("Email is not configured. Set EMAIL_USER and EMAIL_PASS (a Gmail app password).");
    return res.status(500).json({ success: false, error: "Email sending is not configured on the server." });
  }

  try {
    await transporter.sendMail({
      from: EMAIL_USER,
      to,
      subject: "Your patient's portal summary from CareGuide",
      text: message,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Email send error:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to send email." });
  }
});

app.listen(PORT, () => {
  console.log(`CareGuide backend listening on port ${PORT}`);
});
