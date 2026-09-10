const express = require('express');
const cors_proxy = require('cors-anywhere');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 8080;

// ==========================================
// 1. ตั้งค่า GMAIL API (ใช้ AI อ่านสลิป KBank)
// ==========================================
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);

// ป้องกันเว็บพังถ้าระบบยังไม่ใส่ Key ใน Render
if (process.env.GMAIL_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
}

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// ==========================================
// 2. สร้างเส้นทาง API ดึงข้อมูล KBank 
// ==========================================
app.get('/api/kbank-expenses', async (req, res) => {
  // อนุญาตให้หน้าเว็บ MM+ ดึงข้อมูลข้ามโดเมนได้
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (!process.env.GMAIL_REFRESH_TOKEN) {
      return res.json({ success: false, error: 'กรุณาใส่ GMAIL Key ใน Render Environment' });
  }

  try {
    // ค้นหาอีเมล KBank ย้อนหลัง 7 วัน
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:info@kasikornbank.com OR from:kbank_info@kasikornbank.com newer_than:7d (โอนเงิน OR ชำระเงิน OR เงินเข้า)',
      maxResults: 20
    });

    const messages = response.data.messages || [];
    const transactions = [];

    // วนลูปอ่านเนื้อหาทีละอีเมล
    for (const msg of messages) {
      const mail = await gmail.users.messages.get({ userId: 'me', id: msg.id });
      const payload = mail.data.payload;
      
      // ถอดรหัสเนื้อหาอีเมล
      let bodyData = '';
      if (payload.parts) {
        const part = payload.parts.find(p => p.mimeType === 'text/plain' || p.mimeType === 'text/html');
        if (part && part.body && part.body.data) bodyData = part.body.data;
      } else if (payload.body && payload.body.data) {
        bodyData = payload.body.data;
      }
      if (!bodyData) continue;
      
      const text = Buffer.from(bodyData, 'base64').toString('utf-8');
      
      // ดึงหัวข้อและเวลา
      const headers = payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const dateStr = headers.find(h => h.name === 'Date')?.value || '';
      
      // แกะตัวเลขยอดเงินบาท
      const amountMatch = text.match(/(?:จำนวนเงิน|จำนวน)\s*[:]?\s*([\d,]+\.\d{2})/);
      if (!amountMatch) continue;
      
      const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
      const isIncome = subject.includes('เงินเข้า') || text.includes('รับเงิน');
      
      // แกะชื่อผู้รับ/ร้านค้า
      let payee = "บุคคลธรรมดา / ไม่ระบุ";
      const payeeMatch = text.match(/(?:ไปยังบัญชี|ให้กับ|ชื่อผู้รับ)\s*(.+?)(\r|\n|<)/);
      if (payeeMatch) payee = payeeMatch[1].trim();

      // หมวดหมู่อัตโนมัติ (Smart Categorization)
      let category = 'other';
      const p = payee.toLowerCase();
      
      if (p.includes('7-eleven') || p.includes('cp all') || p.includes('grab') || p.includes('lineman') || p.includes('shopee') || p.includes('food')) {
        category = 'food';
      } else if (p.includes('bts') || p.includes('mrt') || p.includes('ปตท') || p.includes('ptt') || p.includes('shell') || p.includes('bolt')) {
        category = 'transport';
      } else if (p.includes('lazada') || p.includes('central') || p.includes('uniqlo')) {
        category = 'shopping';
      } else if (p.includes('การไฟฟ้า') || p.includes('การประปา') || p.includes('pea') || p.includes('mea') || p.includes('true') || p.includes('ais') || p.includes('dtac')) {
        category = 'rent';
      }

      transactions.push({
        id: msg.id,
        date: new Date(dateStr).getTime(),
        amount: amount,
        type: isIncome ? 'income' : 'expense',
        payee: payee,
        category: category,
        rawSubject: subject
      });
    }

    res.json({ success: true, data: transactions });

  } catch (error) {
    console.error('Gmail API Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 3. CORS Proxy ตัวเดิม (สำหรับ MEXC / Yahoo)
// ==========================================
const proxyServer = cors_proxy.createServer({
    originWhitelist: [], 
    requireHeader: [],
    removeHeaders: ['cookie', 'cookie2']
});

// Request ไหนที่ไม่ใช่ /api/... ให้ส่งไปหา Proxy ตัวเก่าให้หมด
app.use((req, res) => {
    proxyServer.emit('request', req, res);
});

// ==========================================
// 4. Start Server
// ==========================================
app.listen(port, '0.0.0.0', () => { 
    console.log(`✅ MM+ Server running on port ${port}`);
    console.log(`- KBank Email Parser API : Active`);
    console.log(`- CORS Proxy : Active`);
});