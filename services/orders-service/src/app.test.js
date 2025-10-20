// CONTEÚDO ATUALIZADO DE: services/orders-service/src/app.test.js
import supertest from 'supertest';
import app from './app.js';
import { prisma } from './db.js';

const request = supertest(app);

// Mock Prisma (igual)
jest.mock('./db.js', () => ({
  prisma: {
    order: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

// Mock AMQP (igual)
jest.mock('./amqp.js', () => ({
  createChannel: jest.fn().mockResolvedValue({
    conn: { close: jest.fn() },
    ch: {
      assertExchange: jest.fn(), assertQueue: jest.fn(), bindQueue: jest.fn(),
      consume: jest.fn(), publish: jest.fn(),
    }
  })
}));

// Mock Opossum (igual)
jest.mock('opossum', () => {
  const mockBreaker = {
    fire: jest.fn(), on: jest.fn(), fallback: jest.fn(),
  };
  return jest.fn(() => mockBreaker);
});
const opossum = (await import('opossum')).default;
const mockBreaker = opossum();

describe('Orders Service API', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    mockBreaker.fire.mockResolvedValue({ ok: true }); 
  });

  // Teste GET /health (igual)
  it('GET /health should return ok', async () => {
    const res = await request.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'orders' });
  });

  // ### ATUALIZADO (Passo 3) ###
  it('GET / should return orders from prisma with items parsed', async () => {
    // Simula o retorno do DB com 'items' como string JSON
    const mockOrdersDb = [{ id: 'o_123', total: 100, items: '[{"sku":"A"}]' }]; 
    prisma.order.findMany.mockResolvedValue(mockOrdersDb);

    const res = await request.get('/');
    expect(res.status).toBe(200);
    // Verifica se a resposta tem 'items' como array
    expect(res.body).toEqual([{ id: 'o_123', total: 100, items: [{sku: 'A'}] }]); 
    expect(prisma.order.findMany).toHaveBeenCalled();
  });

  // ### ATUALIZADO (Passo 3) ###
  it('POST / should create an order if user validation passes, stringifying items', async () => {
    const orderInput = { userId: 'u_123', items: [{ sku: 'a', qty: 1 }], total: 150 };
    // O objeto retornado pelo mock do create deve ter 'items' como string
    const createdOrderDb = { ...orderInput, id: 'o_xyz', status: 'created', items: JSON.stringify(orderInput.items) }; 

    mockBreaker.fire.mockResolvedValue({ ok: true });
    prisma.order.create.mockResolvedValue(createdOrderDb);

    const res = await request
      .post('/')
      .send(orderInput);
    
    expect(res.status).toBe(201);
    // A resposta final deve ter 'items' como array
    expect(res.body).toEqual({ ...createdOrderDb, items: orderInput.items }); 
    expect(mockBreaker.fire).toHaveBeenCalledWith('u_123');
    // Verifica se o prisma.create foi chamado com 'items' como string
    expect(prisma.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ items: JSON.stringify(orderInput.items) })
    });
  });

  // Testes de falha do POST / (iguais)
  it('POST / should fail if breaker fails and user not in cache', async () => {
    const orderInput = { userId: 'u_404', items: [{ sku: 'a' }], total: 150 };
    mockBreaker.fire.mockRejectedValue(new Error('Fetch failed'));

    const res = await request.post('/').send(orderInput);
    
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'users-service indisponível e usuário não encontrado no cache' });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
  
  it('POST / should fail if circuit is open and user not in cache', async () => {
     const orderInput = { userId: 'u_404', items: [{ sku: 'a' }], total: 150 };
     mockBreaker.fire.mockRejectedValue(new Error('CIRCUIT_OPEN'));

     const res = await request.post('/').send(orderInput);
    
     expect(res.status).toBe(503);
     expect(res.body).toEqual({ error: 'users-service indisponível e usuário não encontrado no cache' });
  });

  // ### ADICIONADO TESTE PARA CANCELAMENTO (Passo 3) ###
   it('POST /orders/:id/cancel should cancel an order and return parsed items', async () => {
     const orderId = 'o_abc';
     // Simula o retorno do DB com 'items' como string
     const updatedOrderDb = { id: orderId, status: 'cancelled', items: '[{"sku":"B"}]', userId: 'u_789', total: 50 };
     prisma.order.update.mockResolvedValue(updatedOrderDb);

     const res = await request.post(`/orders/${orderId}/cancel`);

     expect(res.status).toBe(200);
     // Verifica se a resposta tem 'items' como array
     expect(res.body).toEqual({ ...updatedOrderDb, items: [{sku: 'B'}] });
     expect(prisma.order.update).toHaveBeenCalledWith({
       where: { id: orderId },
       data: expect.objectContaining({ status: 'cancelled' })
     });
   });

});