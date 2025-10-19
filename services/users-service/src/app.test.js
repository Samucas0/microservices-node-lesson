// CONTEÚDO DE services/users-service/src/app.test.js
import supertest from 'supertest';
import app from './app.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const request = supertest(app);

// Mockar o módulo AMQP para não tentar conectar
jest.mock('./amqp.js', () => ({
  createChannel: jest.fn().mockResolvedValue({
    conn: { close: jest.fn() },
    ch: {
      assertExchange: jest.fn(),
      publish: jest.fn(),
    }
  })
}));

describe('Users Service API', () => {

  // Limpar o banco antes de cada teste
  beforeEach(async () => {
    await prisma.user.deleteMany({});
  });

  // Desconectar o Prisma no final
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('GET /health should return ok', async () => {
    const res = await request.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'users' });
  });

  it('POST / should create a user', async () => {
    const res = await request
      .post('/')
      .send({ name: 'Test User', email: 'test@example.com' });
    
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name', 'Test User');
  });

  it('POST / should fail if email is missing', async () => {
    const res = await request
      .post('/')
      .send({ name: 'Test User' });
    
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name and email are required' });
  });

  it('POST / should fail on duplicate email', async () => {
    // Cria o primeiro usuário
    await request
      .post('/')
      .send({ name: 'Test User 1', email: 'duplicate@example.com' });
    
    // Tenta criar o segundo com o mesmo email
    const res = await request
      .post('/')
      .send({ name: 'Test User 2', email: 'duplicate@example.com' });

    expect(res.status).toBe(409); // Conflict
    expect(res.body).toEqual({ error: 'Email already exists' });
  });
});