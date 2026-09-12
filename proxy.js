const express = require('express');
const cors_proxy = require('cors-anywhere');
const { google } = require('googleapis');
const crypto = require('crypto');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const app = express();
app.use(express.json({ limit: '64kb' }));
const port = process.env.PORT || 8080;
const allowedOrigins = (process.env.APP_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const privateSyncToken = process.env.DIME_SYNC_TOKEN || '';
const kplusWebhookToken = process.env.KPLUS_WEBHOOK_TOKEN || '';

// เก็บรายการที่รับจากมือถือไว้ระหว่างที่เซิร์ฟเวอร์ทำงานอยู่
// ฝั่งหน้าเว็บจะบันทึกซ้ำลง localStorage ของผู้ใช้ จึงไม่ทำให้รายการเดิมถูกเพิ่มซ้ำ
const kplusWebhookTransactions = new Map();

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

function tokensMatch(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function setPrivateCors(res, origin) {
  if (origin && (allowedOrigins.includes(origin) || origin === 'null')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Dime-Sync-Token, X-KPlus-Webhook-Token, X-Webhook-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
}

function requirePrivateSync(req, res, next) {
  const origin = req.headers.origin || '';

  if (!privateSyncToken) {
    return res.status(500).json({ success: false, error: 'ยังไม่ได้ตั้งค่า DIME_SYNC_TOKEN' });
  }

  if (origin && origin !== 'null' && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ success: false, error: 'Origin ไม่ได้รับอนุญาต' });
  }

  setPrivateCors(res, origin);

  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  const suppliedToken = req.headers['x-dime-sync-token'] || bearer;

  if (!tokensMatch(suppliedToken, privateSyncToken)) {
    return res.status(401).json({ success: false, error: 'Sync Token ไม่ถูกต้อง' });
  }

  next();
}

function requireKPlusWebhook(req, res, next) {
  const origin = req.headers.origin || '';

  if (!kplusWebhookToken) {
    return res.status(500).json({ success: false, error: 'ยังไม่ได้ตั้งค่า KPLUS_WEBHOOK_TOKEN' });
  }

  // Tasker/AutoNotification ไม่ใช่เว็บเบราว์เซอร์ จึงมักไม่มี Origin
  // ถ้ามี Origin ให้ตรวจด้วยทุกครั้งเพื่อไม่เปิด endpoint ให้เว็บอื่นเรียก
  if (origin && origin !== 'null' && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ success: false, error: 'Origin ไม่ได้รับอนุญาต' });
  }

  setPrivateCors(res, origin);
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  const suppliedToken = req.headers['x-kplus-webhook-token']
    || req.headers['x-webhook-token']
    || bearer;

  if (!tokensMatch(suppliedToken, kplusWebhookToken)) {
    return res.status(401).json({ success: false, error: 'K+ Webhook Token ไม่ถูกต้อง' });
  }

  next();
}

function getBangkokDateKey(timestamp) {
  const date = new Date(timestamp);
  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(validDate).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function guessKPlusCategory(text) {
  const value = String(text || '').toLowerCase();
  if (/อาหาร|ข้าว|ร้าน|กาแฟ|คาเฟ่|coffee|food|restaurant|grabfood|lineman/.test(value)) return 'food';
  if (/bts|mrt|แท็กซี่|taxi|bolt|เดินทาง|เติมน้ำมัน|ปั๊ม|transport/.test(value)) return 'transport';
  if (/ซื้อ|ช้อป|shopping|shopee|lazada|ห้าง|ร้านค้า/.test(value)) return 'shopping';
  if (/โรงพยาบาล|คลินิก|ยา|health|medical/.test(value)) return 'health';
  if (/เกม|หนัง|เพลง|netflix|entertainment/.test(value)) return 'entertainment';
  return 'other';
}

function parseKPlusNotification(body) {
  const sourceText = [body.title, body.text, body.message, body.notification].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const explicitAmount = Number(String(body.amount ?? '').replace(/,/g, ''));
  const amountMatch = sourceText.match(/(?:฿\s*|จำนวนเงิน\s*[:]?\s*|ยอดเงิน\s*[:]?\s*)([\d,]+(?:\.\d{1,2})?)/i)
    || sourceText.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:บาท|thb)\b/i);
  const amount = Number.isFinite(explicitAmount) && explicitAmount > 0
    ? explicitAmount
    : amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : 0;

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('ไม่พบจำนวนเงินใน Notification');
  }

  const explicitType = String(body.type || '').toLowerCase();
  const directionText = sourceText.toLowerCase();
  const outgoingSignal = /โอน\s*เงิน\s*ออก|โอนออก|เงินออก|ชำระ|จ่าย|ถอน|payment|debit|outgoing|withdraw/.test(directionText);
  const incomingSignal = /โอน\s*เงิน\s*เข้า|รับโอน|ได้รับเงิน|ฝากเข้า|received|credit|incoming/.test(directionText);
  const isIncome = explicitType === 'income' || (incomingSignal && !outgoingSignal);
  const type = isIncome ? 'income' : 'expense';
  const timestamp = Number(body.timestamp || body.time || Date.now());
  const safeTimestamp = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
  const note = String(body.note || body.merchant || body.payee || sourceText || 'K+ Transaction').trim().slice(0, 240);
  const idSource = String(body.id || `${safeTimestamp}|${type}|${amount}|${sourceText}`);
  const id = `kplus_${crypto.createHash('sha256').update(idSource).digest('hex').slice(0, 24)}`;

  return {
    id,
    source: 'KPLUS_NOTIFICATION',
    dateKey: getBangkokDateKey(safeTimestamp),
    timestamp: safeTimestamp,
    amount: Math.round(amount * 100) / 100,
    type,
    cat: String(body.cat || body.category || guessKPlusCategory(note)).toLowerCase(),
    note,
    rawText: sourceText.slice(0, 500)
  };
}

function decodeBase64Url(value) {
  if (!value) return Buffer.alloc(0);
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function getHeaderValue(headers, name) {
  return headers?.find(header => header.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function collectAttachmentParts(payload, result = []) {
  if (!payload) return result;
  if (payload.filename && payload.body?.attachmentId) {
    result.push({
      filename: payload.filename,
      mimeType: payload.mimeType || '',
      attachmentId: payload.body.attachmentId,
      inlineData: payload.body.data || null
    });
  }
  for (const part of payload.parts || []) collectAttachmentParts(part, result);
  return result;
}

async function readGmailAttachment(messageId, attachment) {
  if (attachment.inlineData) return decodeBase64Url(attachment.inlineData);

  const response = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachment.attachmentId
  });
  return decodeBase64Url(response.data.data);
}

async function extractPdfText(buffer, password) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    password,
    disableWorker: true,
    useSystemFonts: true
  });

  const pdf = await loadingTask.promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ normalizeWhitespace: true });
    pages.push(content.items.map(item => item.str).join(' '));
  }

  return pages.join('\n');
}

function parseDimeOrderHistory(text, documentInfo) {
  const tableText = text.split(/Order History/i).pop() || text;
  const orderPattern = /\b(\d{5,20})\s+(\d{2}\/\d{2}\/\d{4})\s+(BUY|SEL|SELL)\b/gi;
  const matches = [...tableText.matchAll(orderPattern)];
  const orders = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : tableText.length;
    const chunk = tableText.slice(start, end).replace(/\s+/g, ' ').trim();
    const securityMatch = chunk.match(/\b([A-Z][A-Z0-9._-]{0,20})\s*\[([A-Z0-9._-]{2,20})\]/i);
    const currencyMatch = chunk.match(/\b([A-Z]{3})\b/);
    const numericValues = chunk.match(/\b\d+(?:,\d{3})*(?:\.\d+)?\b/g) || [];

    if (!securityMatch || !currencyMatch || numericValues.length < 10) {
      orders.push({
        parsed: false,
        error: 'อ่านคอลัมน์ Order History ได้ไม่ครบ',
        orderId: match[1],
        settlementDate: match[2],
        transactionType: match[3].toUpperCase() === 'SEL' ? 'SELL' : match[3].toUpperCase(),
        rawChunk: chunk,
        ...documentInfo
      });
      continue;
    }

    const values = numericValues.map(value => Number(value.replace(/,/g, '')));
    const [unit, unitPrice, grossAmount, grossAmountThb, fee, feeThb, withholdingTax, withholdingTaxThb, totalAmount, totalAmountThb] = values;
    const transactionType = match[3].toUpperCase() === 'SEL' ? 'SELL' : match[3].toUpperCase();
    const symbol = securityMatch[1].toUpperCase();
    const exchange = securityMatch[2].toUpperCase();

    orders.push({
      parsed: true,
      importKey: `${match[1]}|${match[2]}|${transactionType}|${symbol}|${unit}`,
      orderId: match[1],
      settlementDate: match[2],
      transactionType,
      symbol,
      exchange,
      unit,
      unitPrice,
      currency: currencyMatch[1].toUpperCase(),
      grossAmount,
      grossAmountThb,
      fee,
      feeThb,
      withholdingTax,
      withholdingTaxThb,
      totalAmount,
      totalAmountThb,
      ...documentInfo
    });
  }

  return orders;
}

async function listAllGmailMessages(query) {
  const messages = [];
  let pageToken;
  const maxMessages = Number(process.env.DIME_MAX_MESSAGES || 2000);

  do {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 100,
      pageToken
    });
    messages.push(...(response.data.messages || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken && messages.length < maxMessages);

  return messages.slice(0, maxMessages);
}

app.use('/api/dime-orders', requirePrivateSync);

app.get('/api/dime-orders', async (req, res) => {
  const pdfPassword = process.env.DIME_PDF_PASSWORD;
  if (!pdfPassword) {
    return res.status(500).json({ success: false, error: 'ยังไม่ได้ตั้งค่า DIME_PDF_PASSWORD' });
  }

  if (!process.env.GMAIL_REFRESH_TOKEN) {
    return res.status(500).json({ success: false, error: 'ยังไม่ได้ตั้งค่า GMAIL_REFRESH_TOKEN' });
  }

  try {
    const fullSync = req.query.full === '1';
    const afterMs = Number(req.query.after);
    const initialSyncDays = Math.max(1, Number(process.env.DIME_INITIAL_SYNC_DAYS || 30));
    const baseQuery = 'from:no-reply@dime.co.th has:attachment filename:pdf';
    let query = baseQuery;

    if (!fullSync) {
      if (Number.isFinite(afterMs) && afterMs > 0) {
        // Gmail search is date-based. Re-read the previous day to avoid missing
        // messages around the last-sync boundary; the client deduplicates them.
        const afterDate = new Date(Math.max(0, afterMs - 24 * 60 * 60 * 1000))
          .toISOString()
          .slice(0, 10)
          .replace(/-/g, '/');
        query += ` after:${afterDate}`;
      } else if (process.env.DIME_EMAIL_AFTER) {
        query += ` after:${process.env.DIME_EMAIL_AFTER}`;
      } else {
        query += ` newer_than:${initialSyncDays}d`;
      }
    }

    const messages = await listAllGmailMessages(query);
    const orders = [];
    const documents = [];
    const unparsed = [];

    for (const message of messages) {
      const mail = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'full'
      });
      const payload = mail.data.payload || {};
      const headers = payload.headers || [];
      const subject = getHeaderValue(headers, 'Subject');
      const receivedAt = getHeaderValue(headers, 'Date');

      if (!/confirmation note|ใบยืนยันการซื้อขาย/i.test(subject)) continue;

      const attachments = collectAttachmentParts(payload)
        .filter(file => file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.filename));

      for (const attachment of attachments) {
        const documentInfo = {
          source: 'DIME_EMAIL_PDF',
          sourceMessageId: message.id,
          subject,
          receivedAt,
          filename: attachment.filename
        };

        try {
          const pdfBuffer = await readGmailAttachment(message.id, attachment);
          const text = await extractPdfText(pdfBuffer, pdfPassword);
          const parsed = parseDimeOrderHistory(text, documentInfo);
          orders.push(...parsed.filter(order => order.parsed));
          unparsed.push(...parsed.filter(order => !order.parsed));
          documents.push({ ...documentInfo, orderCount: parsed.filter(order => order.parsed).length });
        } catch (error) {
          unparsed.push({
            ...documentInfo,
            parsed: false,
            error: error?.name === 'PasswordException'
              ? 'รหัสผ่าน PDF ไม่ถูกต้องหรือรูปแบบรหัสไม่ตรง'
              : error.message
          });
        }
      }
    }

    return res.json({
      success: true,
      count: orders.length,
      data: orders,
      documents,
      unparsed,
      syncedAt: Date.now(),
      fullSync
    });
  } catch (error) {
    console.error('Dime Gmail/PDF Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.use('/api/kbank-expenses', requirePrivateSync);
app.get('/api/kbank-expenses', async (req, res) => {
  if (!process.env.GMAIL_REFRESH_TOKEN) {
      return res.json({ success: false, error: 'กรุณาใส่ GMAIL Key ใน Render Environment' });
  }

  try {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: '{from:kasikornbank.com from:kbank.co.th from:kplus} newer_than:30d',
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

      // 2. แยกประเภทโดยให้น้ำหนักกับคำบอกทิศทางของธุรกรรมก่อน
      // ในอีเมล KBank มักมีคำว่า "เงินเข้า" อยู่ในส่วนคำอธิบายบัญชี
      // จึงห้ามตัดสินจากคำนี้คำเดียว ไม่อย่างนั้น "โอนเงินออก" จะกลายเป็นรายรับ
      const directionText = `${subject} ${text}`.replace(/\s+/g, ' ').toLowerCase();
      const outgoingSignal = /โอน\s*เงิน\s*ออก|รายการ\s*โอน\s*ออก|เงิน\s*ออก|ตัด\s*บัญชี|ชำระ|จ่าย|ถอน|โอนออก|payment|debit|outgoing|withdraw/.test(directionText);
      const incomingSignal = /โอน\s*เงิน\s*เข้า|รายการ\s*โอน\s*เข้า|เงิน\s*เข้า\s*บัญชี|รับ\s*โอน|ได้รับเงิน|ฝาก|received|credit|incoming/.test(directionText);
      const isIncome = incomingSignal && !outgoingSignal;
      const transactionType = isIncome ? 'income' : 'expense';

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
        type: transactionType,
        direction: transactionType,
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

// รับ Notification จาก Android/Tasker/AutoNotification แล้วเก็บไว้ให้หน้า Calendar ดึงไปใช้
app.use('/api/kplus-webhook', requireKPlusWebhook);
app.post('/api/kplus-webhook', (req, res) => {
  try {
    const transaction = parseKPlusNotification(req.body || {});
    const existed = kplusWebhookTransactions.has(transaction.id);
    kplusWebhookTransactions.set(transaction.id, transaction);
    return res.status(existed ? 200 : 201).json({
      success: true,
      duplicate: existed,
      data: transaction
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/kplus-webhook/transactions', (req, res) => {
  const since = Number(req.query.since || 0);
  const data = [...kplusWebhookTransactions.values()]
    .filter(item => !since || item.timestamp > since)
    .sort((a, b) => a.timestamp - b.timestamp);

  return res.json({
    success: true,
    count: data.length,
    data,
    syncedAt: Date.now()
  });
});

const proxyServer = cors_proxy.createServer({
    originWhitelist: [], 
    requireHeader: [],
    removeHeaders: ['cookie', 'cookie2']
});

app.use((req, res) => {
    const origin = req.headers.origin || '';
    if (origin && !allowedOrigins.includes(origin)) {
        return res.status(403).json({ success: false, error: 'Origin ไม่ได้รับอนุญาต' });
    }
    proxyServer.emit('request', req, res);
});

app.listen(port, '0.0.0.0', () => { 
    console.log(`✅ MM+ Server running on port ${port}`);
});
