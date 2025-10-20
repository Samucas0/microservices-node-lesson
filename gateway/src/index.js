// CONTEÚDO ATUALIZADO DE: gateway/src/index.js
import express from 'express';
import morgan from 'morgan';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();
// app.use(express.json());
app.use(morgan('dev'));


const PORT = process.env.PORT || 3000;
const USERS_URL = process.env.USERS_URL || 'http://localhost:3001';
const ORDERS_URL = process.env.ORDERS_URL || 'http://localhost:3002';

// Health
app.get('/health', (req, res) => res.json({ ok: true, service: 'gateway' }));

// Roteamento de APIs

// --- USERS ---
// Rota específica para a UI do Swagger (DEVE VIR ANTES de /users)
app.use('/users/api-docs', createProxyMiddleware({
  target: USERS_URL,
  changeOrigin: true,
  pathRewrite: {'^/users/api-docs': '/api-docs'} // Remove /users
}));

app.use('/users', createProxyMiddleware({
  target: USERS_URL,
  changeOrigin: true,
  pathRewrite: {'^/users': ''}
}));

// --- ORDERS (EXERCÍCIO 6) ---
app.use('/orders/api-docs', createProxyMiddleware({
  target: ORDERS_URL,
  changeOrigin: true,
  pathRewrite: {'^/orders/api-docs': '/api-docs'} // Remove /orders
}));

app.use('/orders', createProxyMiddleware({
  target: ORDERS_URL,
  changeOrigin: true,
  pathRewrite: {'^/orders': ''}
}));

// Iniciar o Gateway
app.listen(PORT, () => {
  console.log(`[gateway] listening on http://localhost:${PORT}`);
});