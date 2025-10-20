// CONTEÚDO ATUALIZADO DE: services/orders-service/src/app.js
import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import opossum from 'opossum';
import { nanoid } from 'nanoid';
import { createChannel } from './amqp.js';
import { ROUTING_KEYS } from '../common/events.js';
import { prisma } from './db.js'; 
import swaggerUi from 'swagger-ui-express'; 
import YAML from 'yamljs'; 
import path from 'path'; 
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(morgan('dev'));

try {
  const swaggerDocument = YAML.load(path.join(__dirname, '../openapi.yaml'));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  console.log('[orders] Swagger UI running on /api-docs');
} catch (e) {
  console.error('Failed to load openapi.yaml:', e.message);
}

const USERS_BASE_URL = process.env.USERS_BASE_URL || 'http://localhost:3001';
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 2000);
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const EXCHANGE = process.env.EXCHANGE || 'app.topic';
const QUEUE = process.env.QUEUE || 'orders.q';
const ROUTING_KEY_USER_CREATED = process.env.ROUTING_KEY_USER_CREATED || ROUTING_KEYS.USER_CREATED;

const userCache = new Map();

let amqp = null;
(async () => {
  // ... (código AMQP igual ao anterior) ...
  try {
    amqp = await createChannel(RABBITMQ_URL, EXCHANGE);
    console.log('[orders] AMQP connected');

    const ROUTING_KEY_USER_UPDATED = process.env.ROUTING_KEY_USER_UPDATED || ROUTING_KEYS.USER_UPDATED;

    await amqp.ch.assertQueue(QUEUE, { durable: true });
    await amqp.ch.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY_USER_CREATED);
    await amqp.ch.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY_USER_UPDATED); 

    amqp.ch.consume(QUEUE, msg => {
      if (!msg) return;
      try {
        const user = JSON.parse(msg.content.toString());
        const eventType = msg.fields.routingKey; 

        if (eventType === ROUTING_KEY_USER_CREATED || eventType === ROUTING_KEY_USER_UPDATED) {
          userCache.set(user.id, user);
          console.log(`[orders] consumed event ${eventType} -> cached`, user.id);
        }
        
        amqp.ch.ack(msg);
      } catch (err) {
        console.error('[orders] consume error:', err.message);
        amqp.ch.nack(msg, false, false); 
      }
    });
  } catch (err) {
    console.error('[orders] AMQP connection failed:', err.message);
  }
})();


app.get('/health', (req, res) => res.json({ ok: true, service: 'orders' }));

// ### ATUALIZADO (Passo 2) ###
app.get('/', async (req, res) => {
  try {
    const ordersFromDb = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' }
    });
    // Converte 'items' de string JSON para array para cada pedido
    const orders = ordersFromDb.map(order => ({
      ...order,
      items: JSON.parse(order.items) 
    }));
    res.json(orders);
  } catch (err) {
    console.error('[orders] list orders error:', err.message);
    res.status(500).json({ error: 'Failed to list orders' });
  }
});

// ... (fetchWithTimeout, fetchWithRetry, fetchUserAction, Circuit Breaker - iguais) ...
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
      console.warn(`[orders] fetch error: ${err.message}. Retrying (${i + 1}/${retries})...`);
    }
    await new Promise(resolve => setTimeout(resolve, delay)); 
  }
  throw new Error(`Failed to fetch ${url} after ${retries} retries.`);
}

async function fetchUserAction(userId) {
  const resp = await fetchWithTimeout(`${USERS_BASE_URL}/${userId}`, HTTP_TIMEOUT_MS);
  if (!resp.ok) {
    throw new Error(`User service returned ${resp.status}`);
  }
  return resp; 
}
const circuitBreakerOptions = {
  timeout: HTTP_TIMEOUT_MS, 
  errorThresholdPercentage: 50,
  resetTimeout: 10000 
};
const breaker = new opossum(fetchUserAction, circuitBreakerOptions);
breaker.on('open', () => console.error('[orders] Circuit breaker opened for users-service'));
breaker.on('close', () => console.log('[orders] Circuit breaker closed for users-service'));
breaker.on('fallback', () => console.warn('[orders] Circuit breaker fallback: users-service indisponível.'));
breaker.fallback(() => {
  throw new Error('CIRCUIT_OPEN');
});

// ### ATUALIZADO (Passo 2) ###
app.post('/orders/:id/cancel', async (req, res) => {
  const orderId = req.params.id;
  
  try {
    const updatedOrderDb = await prisma.order.update({
      where: { id: orderId },
      data: { status: 'cancelled', updatedAt: new Date() }
    });

    // Converte 'items' para array antes de publicar e retornar
    const updatedOrder = {
        ...updatedOrderDb,
        items: JSON.parse(updatedOrderDb.items)
    };

    // Publicar evento (envia o objeto com 'items' como array)
    try {
      if (amqp?.ch) {
        // O evento leva o ID e status, não precisa do objeto inteiro parseado
        const payload = Buffer.from(JSON.stringify({ orderId, status: 'cancelled' })); 
        amqp.ch.publish(EXCHANGE, ROUTING_KEYS.ORDER_CANCELLED, payload, { persistent: true });
        console.log('[orders] published event:', ROUTING_KEYS.ORDER_CANCELLED, { orderId });
      }
    } catch (err) {
      console.error('[orders] publish error:', err.message);
    }

    res.json(updatedOrder); // Retorna o pedido atualizado com 'items' como array

  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    console.error('[orders] cancel order error:', err.message);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

// ### ATUALIZADO (Passo 2) ###
app.post('/', async (req, res) => {
  const { userId, items, total } = req.body || {};
  if (!userId || !Array.isArray(items) || typeof total !== 'number') {
    return res.status(400).json({ error: 'userId, items[], total<number> são obrigatórios' });
  }

  // Validação via Circuit Breaker (igual)
  try {
    await breaker.fire(userId); 
  } catch (err) {
    console.warn(`[orders] users-service call failed: ${err.message}`);
    if (!userCache.has(userId)) {
      const status = err.message === 'CIRCUIT_OPEN' ? 503 : 503;
      return res.status(status).json({ error: 'users-service indisponível e usuário não encontrado no cache' });
    }
    console.log('[orders] Usando cache como fallback.');
  }

  // Salvar no banco
  const id = `o_${nanoid(6)}`;
  const orderData = { 
    id, 
    userId, 
    items: JSON.stringify(items), // <-- CONVERTE PARA STRING AQUI
    total, 
    status: 'created'
  };

  try {
    const orderFromDb = await prisma.order.create({ data: orderData });

    // Converte 'items' de volta para array para publicar e retornar
    const order = {
        ...orderFromDb,
        items: JSON.parse(orderFromDb.items)
    };

    // Publicar evento (envia o objeto com 'items' como array)
    try {
      if (amqp?.ch) {
        amqp.ch.publish(EXCHANGE, ROUTING_KEYS.ORDER_CREATED, Buffer.from(JSON.stringify(order)), { persistent: true });
        console.log('[orders] published event:', ROUTING_KEYS.ORDER_CREATED, order.id);
      }
    } catch (err) {
      console.error('[orders] publish error:', err.message);
    }

    res.status(201).json(order); // Retorna com 'items' como array

  } catch (err) {
     console.error('[orders] create order error:', err.message);
     res.status(500).json({ error: 'Failed to create order' });
  }
});

export default app;