// CONTEÚDO DE services/users-service/src/app.js
import express from 'express';
import morgan from 'morgan';
import { PrismaClient } from '@prisma/client'; 
import { createChannel } from './amqp.js';
import { ROUTING_KEYS } from '../common/events.js';

const app = express();
app.use(express.json());
app.use(morgan('dev'));

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const EXCHANGE = process.env.EXCHANGE || 'app.topic';

const prisma = new PrismaClient(); 

let amqp = null;
(async () => {
  try {
    amqp = await createChannel(RABBITMQ_URL, EXCHANGE);
    console.log('[users] AMQP connected');
  } catch (err) {
    console.error('[users] AMQP connection failed:', err.message);
  }
})();

app.get('/health', (req, res) => res.json({ ok: true, service: 'users' }));

app.get('/', async (req, res) => { 
  const users = await prisma.user.findMany(); 
  res.json(users);
});

app.post('/', async (req, res) => { 
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  try {
    const user = await prisma.user.create({ 
      data: { name, email }
    });

    try {
      if (amqp?.ch) {
        const payload = Buffer.from(JSON.stringify(user));
        amqp.ch.publish(EXCHANGE, ROUTING_KEYS.USER_CREATED, payload, { persistent: true });
        console.log('[users] published event:', ROUTING_KEYS.USER_CREATED, user);
      }
    } catch (err) {
      console.error('[users] publish error:', err.message);
    }
    res.status(201).json(user);
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('[users] create user error:', e.message);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.get('/:id', async (req, res) => { 
  const user = await prisma.user.findUnique({ 
    where: { id: req.params.id }
  });
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json(user);
});

// (Aqui também iria sua rota app.put('/:id', ...) do Exercício 1)

export default app; // <-- ADICIONADO NO FINAL