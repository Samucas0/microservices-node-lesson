import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import opossum from 'opossum';
import { nanoid } from 'nanoid';
import { createChannel } from './amqp.js';
import { ROUTING_KEYS } from '../common/events.js';

const app = express();
app.use(express.json());
app.use(morgan('dev'));



const PORT = process.env.PORT || 3002;
const USERS_BASE_URL = process.env.USERS_BASE_URL || 'http://localhost:3001';
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 2000);
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const EXCHANGE = process.env.EXCHANGE || 'app.topic';
const QUEUE = process.env.QUEUE || 'orders.q';
const ROUTING_KEY_USER_CREATED = process.env.ROUTING_KEY_USER_CREATED || ROUTING_KEYS.USER_CREATED;

// In-memory "DB"
const orders = new Map();
// In-memory cache de usuários (preenchido por eventos)
const userCache = new Map();

let amqp = null;
// substitui o bloco async por este que inclui o bind para o novo evento
(async () => {
  try {
    amqp = await createChannel(RABBITMQ_URL, EXCHANGE);
    console.log('[orders] AMQP connected');

    // Define a nova routing key
    const ROUTING_KEY_USER_UPDATED = process.env.ROUTING_KEY_USER_UPDATED || ROUTING_KEYS.USER_UPDATED;

    // Bind de fila para consumir eventos
    await amqp.ch.assertQueue(QUEUE, { durable: true });
    await amqp.ch.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY_USER_CREATED);
    await amqp.ch.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY_USER_UPDATED); // <-- ADICIONADO BIND

    amqp.ch.consume(QUEUE, msg => {
      if (!msg) return;
      try {
        const user = JSON.parse(msg.content.toString());
        const eventType = msg.fields.routingKey; // <-- Pega o evento que chegou

        // idempotência simples: atualiza/define para ambos eventos
        if (eventType === ROUTING_KEY_USER_CREATED || eventType === ROUTING_KEY_USER_UPDATED) {
          userCache.set(user.id, user);
          console.log(`[orders] consumed event ${eventType} -> cached`, user.id);
        }
        
        amqp.ch.ack(msg);
      } catch (err) {
        console.error('[orders] consume error:', err.message);
        amqp.ch.nack(msg, false, false); // descarta em caso de erro de parsing (aula: discutir DLQ)
      }
    });
  } catch (err) {
    console.error('[orders] AMQP connection failed:', err.message);
  }
})();

app.get('/health', (req, res) => res.json({ ok: true, service: 'orders' }));

app.get('/', (req, res) => {
  res.json(Array.from(orders.values()));
});

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function fetchWithRetry(url, timeout, retries = 3, delay = 300) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchWithTimeout(url, timeout);
      if (res.ok) return res; // Sucesso
      
      console.warn(`[orders] fetch failed (${res.status}). Retrying (${i + 1}/${retries})...`);
    } catch (err) {
      // Ignora erro (ex: timeout) e tenta de novo
      console.warn(`[orders] fetch error: ${err.message}. Retrying (${i + 1}/${retries})...`);
    }
    // Espera antes da próxima tentativa
    await new Promise(resolve => setTimeout(resolve, delay)); 
  }
  // Se todas as tentativas falharem, lança um erro
  throw new Error(`Failed to fetch ${url} after ${retries} retries.`);
}

// Ação que o circuit breaker vai executar
async function fetchUserAction(userId) {
  // Usar a função fetchWithTimeout que já existe
  const resp = await fetchWithTimeout(`${USERS_BASE_URL}/${userId}`, HTTP_TIMEOUT_MS);
  if (!resp.ok) {
    // Se a resposta não for OK (404, 500), considera falha
    throw new Error(`User service returned ${resp.status}`);
  }
  return resp; // Sucesso
}

// Configuração do Circuit Breaker
const circuitBreakerOptions = {
  timeout: HTTP_TIMEOUT_MS, // Tempo limite da chamada
  errorThresholdPercentage: 50, // Abre se 50% das chamadas falharem
  resetTimeout: 10000 // Tenta fechar o circuito após 10 segundos
};

const breaker = opossum(fetchUserAction, circuitBreakerOptions);

// Eventos para log
breaker.on('open', () => console.error('[orders] Circuit breaker opened for users-service'));
breaker.on('close', () => console.log('[orders] Circuit breaker closed for users-service'));
breaker.on('fallback', () => console.warn('[orders] Circuit breaker fallback: users-service indisponível.'));

// O fallback será usar o cache (tratado na rota)
// Aqui, apenas relançamos um erro específico se o circuito abrir
breaker.fallback(() => {
  throw new Error('CIRCUIT_OPEN');
});

// Alteracão: endpoint para cancelar pedido
app.post('/orders/:id/cancel', async (req, res) => {
  const orderId = req.params.id;
  // Correção: Usar .get() pois é um Map
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  order.status = 'cancelled';
  orders.set(orderId, order); // Atualiza o pedido no Map

  // Publique evento order.cancelled
  try {
    if (amqp?.ch) {
      const payload = Buffer.from(JSON.stringify({ orderId, status: 'cancelled' }));
      amqp.ch.publish(EXCHANGE, ROUTING_KEYS.ORDER_CANCELLED, payload, { persistent: true });
      console.log('[orders] published event:', ROUTING_KEYS.ORDER_CANCELLED, { orderId });
    }
  } catch (err) {
    console.error('[orders] publish error:', err.message);
  }

  res.json(order); // Retorna o pedido atualizado
});

// (substitua a rota app.post('/', ...) original por esta)
app.post('/', async (req, res) => {
  const { userId, items, total } = req.body || {};
  if (!userId || !Array.isArray(items) || typeof total !== 'number') {
    return res.status(400).json({ error: 'userId, items[], total<number> são obrigatórios' });
  }

  // 1) Validação síncrona (HTTP) via Circuit Breaker
  try {
    // Em vez de fetch, usamos o breaker.fire
    await breaker.fire(userId); 
    // Se chegou aqui, a chamada foi OK
    
  } catch (err) {
    console.warn(`[orders] users-service call failed: ${err.message}`);
    
    // Se o circuito está aberto ou houve falha/timeout, tentar o cache
    if (!userCache.has(userId)) {
      // Define o status 503 (Service Unavailable) se o circuito estiver aberto
      const status = err.message === 'CIRCUIT_OPEN' ? 503 : 503; // 503 em ambos os casos
      return res.status(status).json({ error: 'users-service indisponível e usuário não encontrado no cache' });
    }
    console.log('[orders] Usando cache como fallback (circuit half-open/open ou falha).');
  }

  const id = `o_${nanoid(6)}`;
  const order = { id, userId, items, total, status: 'created', createdAt: new Date().toISOString() };
  orders.set(id, order);

  // (Opcional) publicar evento order.created
  try {
    if (amqp?.ch) {
      amqp.ch.publish(EXCHANGE, ROUTING_KEYS.ORDER_CREATED, Buffer.from(JSON.stringify(order)), { persistent: true });
      console.log('[orders] published event:', ROUTING_KEYS.ORDER_CREATED, order.id);
    }
  } catch (err) {
    console.error('[orders] publish error:', err.message);
  }

  res.status(201).json(order);
});