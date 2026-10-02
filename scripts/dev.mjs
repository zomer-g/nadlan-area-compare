// Local development: the server with a fixed identity (honoured on localhost
// only) and the in-memory store. `npm run dev`, then http://localhost:5190
process.env.DEV_USER_EMAIL ??= 'zomerg@gmail.com';
process.env.ADMIN_EMAILS ??= 'zomerg@gmail.com,yogev.sharvit@gmail.com';
process.env.XHOST_HTTP_PORT ??= '5190';
await import('../server.js');
