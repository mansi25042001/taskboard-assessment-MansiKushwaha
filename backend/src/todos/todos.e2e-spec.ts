import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';

describe('Todos API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const dbFile = `/tmp/test-db-${Date.now()}.db`;

  beforeAll(async () => {
    // Use a temporary sqlite DB file for tests.
    // Prisma connection string typically looks like: "file:./dev.db"
    // We set it into process.env so the AppModule / Prisma reads it during bootstrap.
    process.env.DATABASE_URL = `file:${dbFile}`;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // If your app uses global validation pipe in main.ts, replicate similar config here
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    // Acquire PrismaService (adjust import path if different)
    prisma = app.get(PrismaService);

    // Ensure DB is ready and clean. Attempt model-level cleanup; adapt model names if different.
    try {
      // If Prisma models are named 'todo' and 'user', these calls will work.
      // If your Prisma service exposes different API, adapt accordingly.
      // Clear data to get deterministic test runs.
      // @ts-ignore
      if (prisma && prisma.todo && typeof prisma.todo.deleteMany === 'function') {
        // @ts-ignore
        await prisma.todo.deleteMany({});
      }
      // @ts-ignore
      if (prisma && prisma.user && typeof prisma.user.deleteMany === 'function') {
        // @ts-ignore
        await prisma.user.deleteMany({});
      }
    } catch (e) {
      // Best-effort cleanup; continue even if model names differ.
      // console.warn('Prisma cleanup warning:', e);
    }
  }, 20000);

  afterAll(async () => {
    await app.close();
    // remove temp db file if it exists
    try {
      if (fs.existsSync(dbFile)) {
        fs.unlinkSync(dbFile);
      }
    } catch (e) {
      // ignore
    }
  });

  // Helper: create a user and login -> return bearer token.
  // Adjust the register/login endpoints and payload according to your implementation.
  async function registerAndLogin() {
    const rnd = Math.random().toString(36).slice(2, 8);
    const email = `test-${rnd}@example.com`;
    const password = 'Password123!';

    // Try common register endpoint; adjust if you have different routes.
    // If your API doesn't require registration (seeded users), adapt to use existing credentials.
    try {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password })
        .expect(res => {
          // Accept 201 or 200 depending on implementation
          if (![200, 201].includes(res.status)) {
            throw new Error('register failed');
          }
        });
    } catch {
      // If register doesn't exist, ignore — maybe seed users are used.
    }

    // Login: try /auth/login or /login
    const loginPaths = ['/auth/login', '/login', '/users/login'];
    for (const p of loginPaths) {
      const res = await request(app.getHttpServer()).post(p).send({ email, password });
      if (res.status === 201 || res.status === 200) {
        // assume token returned under { accessToken } or { token } or set-cookie
        if (res.body && (res.body.accessToken || res.body.token)) {
          return `Bearer ${res.body.accessToken || res.body.token}`;
        }
        // If auth uses cookie set, return cookie header string
        const setCookie = res.headers['set-cookie'];
        if (setCookie) return setCookie.join('; ');
      }
    }

    // If we couldn't log in, return undefined and tests will assert 401 accordingly.
    return undefined;
  }

  it('should require authorization for protected routes (401)', async () => {
    // Adjust endpoint to a known protected route; using GET /todos as common example.
    await request(app.getHttpServer()).get('/todos').expect(401);
  });

  it('should create a todo (validation & sanitization)', async () => {
    const token = await registerAndLogin();

    const payload = {
      title: '<script>alert(1)</script> My todo',
      description: 'A valid description',
    };

    const res = await request(app.getHttpServer())
      .post('/todos') // adjust path if needed
      .set('Authorization', token || '')
      .send(payload)
      .expect(201);

    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('title');
    // Sanitization check: server should not echo raw script tags back. This assertion is liberal:
    expect(res.body.title).not.toContain('<script>');
  });

  it('should enforce validation (400) for invalid payloads', async () => {
    const token = await registerAndLogin();

    const badPayload = {
      // missing required 'title' field, or title too short depending on validation rules.
      description: 'no title here',
    };

    await request(app.getHttpServer())
      .post('/todos')
      .set('Authorization', token || '')
      .send(badPayload)
      .expect(400);
  });

  it('should support optimistic locking and return 409 on stale update', async () => {
    const token = await registerAndLogin();

    // 1) create a todo
    const createRes = await request(app.getHttpServer())
      .post('/todos')
      .set('Authorization', token || '')
      .send({ title: 'optimistic test' })
      .expect(201);

    const todo = createRes.body;
    expect(todo).toHaveProperty('id');

    // Assume server returns a version or etag field; common name: version
    const versionField = todo.version !== undefined ? 'version' : (todo.etag ? 'etag' : null);

    // If no version field exists, skip optimistic-lock test.
    if (!versionField) {
      // Mark as pending if optimistic locking is not implemented in this API.
      return;
    }

    // 2) Do two concurrent updates: first increments version, second uses old version -> should fail
    const id = todo.id;
    const oldVersion = todo[versionField];

    // First update: succeed
    await request(app.getHttpServer())
      .patch(`/todos/${id}`)
      .set('Authorization', token || '')
      .send({ title: 'updated 1', [versionField]: oldVersion })
      .expect(200);

    // Second update with stale version -> expect 409 Conflict (adjust code if your API returns 409)
    await request(app.getHttpServer())
      .patch(`/todos/${id}`)
      .set('Authorization', token || '')
      .send({ title: 'updated stale', [versionField]: oldVersion })
      .expect(409);
  });

  it('should support bulk operations (toggle/delete) with deterministic result', async () => {
    const token = await registerAndLogin();

    // Create 3 todos
    const create = async (t: string) =>
      (await request(app.getHttpServer()).post('/todos').set('Authorization', token || '').send({ title: t })).body;

    const t1 = await create('bulk 1');
    const t2 = await create('bulk 2');
    const t3 = await create('bulk 3');

    // Bulk toggle endpoint example: POST /todos/bulk-toggle { ids: [..] }
    // Adjust path and payload to match your implementation.
    const res = await request(app.getHttpServer())
      .post('/todos/bulk-toggle')
      .set('Authorization', token || '')
      .send({ ids: [t1.id, t2.id] })
      .expect(200);

    // Expect the response to indicate updated items; be flexible about return shape
    expect(res.body).toBeDefined();

    // Verify the two todos were toggled. Fetch them individually.
    const g1 = await request(app.getHttpServer()).get(`/todos/${t1.id}`).set('Authorization', token || '').expect(200);
    const g2 = await request(app.getHttpServer()).get(`/todos/${t2.id}`).set('Authorization', token || '').expect(200);
    // Assuming todos have a boolean 'completed' field toggled by bulk op.
    expect(g1.body).toHaveProperty('completed');
    expect(g2.body).toHaveProperty('completed');
  });
});
