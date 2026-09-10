const express = require('express');
const cors_proxy = require('cors-anywhere');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 8080;

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);

if (process.env.GMAIL_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
}

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

function getEmailBody(payload) {
  let body = '';
  if (payload.body && payload.body.data) {
    body += Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      body += getEmailBody(part);
    }
  }
  return body;
}

app.get('/api/kbank-expenses', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (!process.env.GMAIL_REFRESH_TOKEN) {
      return res.json({ success: false, error: 'กรุณาใส่ GMAIL Key ใน Render Environment' });
  }

  try {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:kasikornbank.com newer_than:30d',
      maxResults: 20
    });

    const messages = response.data.messages || [];
    const transactions = [];

    for (const msg of messages) {
      const mail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const payload = mail.data.payload;
      
      const rawBody = getEmailBody(payload);
      const text = rawBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

      const headers = payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const dateStr = headers.find(h => h.name === 'Date')?.value || '';

      // 1. ดึงยอดเงิน (Amount) - ปรับ Regex ครอบคลุมรูปแบบ KBank ไทย/อังกฤษ ทุกเวอร์ชัน
      const amountMatch = text.match(/(?:จำนวนเงิน|จำนวน|Amount)\s*(?:\(บาท\)|\(THB\))?\s*[:]?\s*([\d,]+\.\d{2})/i) ||
                          text.match(/([\d,]+\.\d{2})\s*(?:บาท|THB)/i) ||
                          text.match(/(?:THB|บาท)\s*([\d,]+\.\d{2})/i);
      
      const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 0;

      // 2. แยกประเภท รายรับ / รายจ่าย
      const isIncome = text.includes('เงินเข้า') || 
                       text.includes('รับเงิน') || 
                       text.toLowerCase().includes('received');

      // 3. ดึงชื่อผู้รับ / รายการ
      let payee = "KBank Transaction";
      const payeeMatch = text.match(/(?:ไปยังบัญชี|ไปยัง|ให้กับ|ชื่อผู้รับ|จาก|To|From|Merchant)\s*[:]?\s*(.+?)(?:\s{2,}|จำนวน|Amount|Date|วันที่|รหัสอ้างอิง|$)/i);
      if (payeeMatch) {
        payee = payeeMatch[1].trim();
      }

      // 4. จัดหมวดหมู่อัตโนมัติ (Smart Categorization)
      let category = 'other';
      const p = payee.toLowerCase();
      if (p.includes('7-eleven') || p.includes('cp all') || p.includes('grab') || p.includes('food') || p.includes('shopee')) {
        category = 'shopping';
      } else if (p.includes('bts') || p.includes('mrt') || p.includes('ptt') || p.includes('bolt')) {
        category = 'transport';
      } else if (p.includes('true') || p.includes('ais') || p.includes('dtac') || p.includes('urban music')) {
        category = 'entertainment';
      }

      transactions.push({
        id: msg.id,
        date: new Date(dateStr).getTime() || Date.now(),
        amount: amount,
        type: isIncome ? 'income' : 'expense',
        payee: payee,
        category: category,
        rawSubject: subject
      });
    }

    res.json({ success: true, count: transactions.length, data: transactions });

  } catch (error) {
    console.error('Gmail API Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const proxyServer = cors_proxy.createServer({
    originWhitelist: [], 
    requireHeader: [],
    removeHeaders: ['cookie', 'cookie2']
});

app.use((req, res) => {
    proxyServer.emit('request', req, res);
});

app.listen(port, '0.0.0.0', () => { 
    console.log(`✅ MM+ Server running on port ${port}`);
});