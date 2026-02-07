import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: "support@axionikai.com",   // your email
    pass: "@Axionik9999999"        // Gmail App Password
  }
});

export async function sendOrderEmail({ to, subject, html }) {
  await transporter.sendMail({
    from: `"Axionik AI" <support@axionikai.com>`,
    to,
    subject,
    html
  });
}
