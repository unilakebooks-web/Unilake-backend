import { sendEmail } from "../lib/email.js";

async function main() { 
  const result = await sendEmail({
    to: "khiwatari12@gmail.com", // replace with your own inbox
    subject: "Unilake — email smoke test",
    html: `
      <p>Hi,</p>
      <p>If you're reading this, <strong>Layer 2 works</strong>. 🎉</p>
      <p>Sent via Resend from the Unilake backend.</p>
    `,
  });
  console.log("Sent:", result);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});