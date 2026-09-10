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
      const mail = await gmail.users.messages.get({ userId: 'me', id: msg.id });
      const payload = mail.data.payload;
      
      let bodyData = '';
      if (payload.parts) {
        const part = payload.parts.find(p => p.mimeType === 'text/plain' || p.mimeType === 'text/html');
        if (part && part.body && part.body.data) bodyData = part.body.data;
      } else if (payload.body && payload.body.data) {
        bodyData = payload.body.data;
      }
      if (!bodyData) continue;
      
      const text = Buffer.from(bodyData, 'base64').toString('utf-8');
      
      const headers = payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const dateStr = headers.find(h => h.name === 'Date')?.value || '';
      
      // 1. แกะยอดเงิน (รองรับทั้ง Amount, Amount/จำนวนเงิน, THB, บาท)
      const amountMatch = text.match(/(?:Amount|จำนวนเงิน|จำนวน)\s*[:]?\s*([\d,]+\.\d{2})/i) || 
                          text.match(/([\d,]+\.\d{2})\s*(?:THB|บาท)/i);
      const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 0;
      
      // 2. เช็คว่าเป็น รายรับ หรือ รายจ่าย
      const isIncome = text.toLowerCase().includes('received') || 
                       text.includes('รับเงิน') || 
                       subject.toLowerCase().includes('received');
      
      // 3. แกะชื่อผู้รับ/ผู้โอน (To/From/ไปยัง/จาก)
      let payee = "KBank Transfer";
      const payeeMatch = text.match(/(?:To|From|ไปยังบัญชี|ให้กับ|ชื่อผู้รับ|จาก)\s*[:]?\s*(.+?)(\r|\n|<)/i);
      if (payeeMatch) payee = payeeMatch[1].trim();

      // 4. หมวดหมู่อัตโนมัติ
      let category = 'other';
      const p = payee.toLowerCase();
      if (p.includes('7-eleven') || p.includes('cp all') || p.includes('grab') || p.includes('food')) category = 'food';
      else if (p.includes('bts') || p.includes('mrt') || p.includes('ptt') || p.includes('bolt')) category = 'transport';

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