const cors_proxy = require('cors-anywhere');

// ให้ระบบคลาวด์เลือก Port ให้เองอัตโนมัติ
const port = process.env.PORT || 8080;

cors_proxy.createServer({
    originWhitelist: [], 
    requireHeader: [],
    removeHeaders: ['cookie', 'cookie2']
}).listen(port, '0.0.0.0', () => { 
    console.log('✅ CORS Proxy running on port ' + port);
});