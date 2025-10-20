// CONTEÚDO ATUALIZADO DE: services/users-service/src/app.js
import swaggerUi from 'swagger-ui-express'; 
import YAML from 'yamljs'; 
import path from 'path'; 
import { fileURLToPath } from 'url';
import express from 'express';
import morgan from 'morgan';
import { PrismaClient } from '@prisma/client'; 
import { createChannel } from './amqp.js';
import { ROUTING_KEYS } from '../common/events.js';

// Workaround para __dirname em ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(morgan('dev'));

try {
  // Carrega o YAML (path.join volta um nível de /src para /)
  const swaggerDocument = YAML.load(path.join(__dirname, '../openapi.yaml'));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  console.log('[users] Swagger UI running on /api-docs');
} catch (e) {
  console.error('Failed to load openapi.yaml:', e.message);
}

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const EXCHANGE = process.env.EXCHANGE || 'app.topic';

const prisma = new PrismaClient(); 

let amqp = null;
const connectAMQP = async (retries = 5, delay = 3000) => {
  try {
    amqp = await createChannel(RABBITMQ_URL, EXCHANGE);
    console.log('[users] AMQP connected');
    
    // (Qualquer lógica de consumidor iria aqui)
    
  } catch (err) {
    console.error(`[users] AMQP connection failed: ${err.message}`);
    if (retries > 0) {
      console.log(`[users] Retrying AMQP connection in ${delay / 1000}s... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      // Tenta novamente com backoff exponencial
      await connectAMQP(retries - 1, delay * 2); 
    } else {
      console.error('[users] AMQP connection failed. Max retries reached.');
    }
  }
};

(async () => {
  await connectAMQP(); // <-- Chama a nova função
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

// ### INÍCIO DA ATUALIZAÇÃO (EXERCÍCIO 1) ###
app.put('/:id', async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { name, email, updatedAt: new Date() } // Força a atualização do timestamp
    });

    // Publicar evento user.updated
    try {
      if (amqp?.ch) {
        const payload = Buffer.from(JSON.stringify(user));
        amqp.ch.publish(EXCHANGE, ROUTING_KEYS.USER_UPDATED, payload, { persistent: true });
        console.log('[users] published event:', ROUTING_KEYS.USER_UPDATED, user);
      }
    } catch (err) {
      console.error('[users] publish error:', err.message);
    }
    
    res.status(200).json(user);

  } catch (e) {
    if (e.code === 'P2025') { // Erro do Prisma para "Não encontrado" na atualização
      return res.status(404).json({ error: 'User not found' });
    }
    if (e.code === 'P2002') { // Email duplicado
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('[users] update user error:', e.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});
// ### FIM DA ATUALIZAÇÃO (EXERCÍCIO 1) ###

export default app;