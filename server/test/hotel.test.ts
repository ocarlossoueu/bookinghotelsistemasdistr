import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { io as ioc } from 'socket.io-client';

// Nunca usa DATABASE_URL de produção: o teste apaga o schema.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/hotel_test';
process.env.HOLD_SECONDS = '2';

const { startServer } = await import('../src/index.js');
const { pool } = await import('../src/db.js');

let base = '';
let server: Awaited<ReturnType<typeof startServer>>;

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function login(name: string, role = 'GUEST', pin?: string) {
  const r = await call('POST', '/api/session', undefined, { name, role, pin });
  assert.equal(r.status, 201);
  return r.body.token as string;
}

function futureDate(days: number) {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  server = await startServer(0);
  base = `http://localhost:${server.port}`;
});

after(async () => {
  await server.close();
  await pool.end();
});

describe('reservas concorrentes', () => {
  test('20 celulares disputando o mesmo apartamento: só 1 vence', async () => {
    const tokens = await Promise.all(Array.from({ length: 20 }, (_, i) => login(`Hóspede ${i}`)));
    const body = { roomId: 101, checkIn: futureDate(10), checkOut: futureDate(12), guests: 2, bedLayout: 'CASAL' };
    const results = await Promise.all(
      tokens.map((t) => call('POST', '/api/holds', t, body, { 'idempotency-key': randomUUID() })),
    );
    const ok = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    assert.equal(ok.length, 1);
    assert.equal(conflicts.length, 19);
    const { rows } = await pool.query("SELECT count(*)::int n FROM bookings WHERE room_id = 101 AND status IN ('HOLD','CONFIRMED')");
    assert.equal(rows[0].n, 1);
  });

  test('períodos que não se sobrepõem no mesmo apartamento são aceitos', async () => {
    const t = await login('Carla');
    const a = await call('POST', '/api/holds', t, { roomId: 102, checkIn: futureDate(1), checkOut: futureDate(3), guests: 1, bedLayout: 'SOLTEIRO' }, { 'idempotency-key': randomUUID() });
    const b = await call('POST', '/api/holds', t, { roomId: 102, checkIn: futureDate(3), checkOut: futureDate(5), guests: 1, bedLayout: 'SOLTEIRO' }, { 'idempotency-key': randomUUID() });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
  });

  test('constraint do banco bloqueia sobreposição mesmo sem a trava', async () => {
    const { rows } = await pool.query("SELECT * FROM bookings WHERE room_id = 101 AND status = 'HOLD' LIMIT 1");
    await assert.rejects(
      pool.query(
        `INSERT INTO bookings (room_id,user_id,check_in,check_out,guests,bed_layout,total_price,status,idempotency_key,request_hash,lamport,instance_id)
         VALUES (101,$1,$2,$3,1,'CASAL',1,'CONFIRMED',$4,'x',1,'t')`,
        [rows[0].user_id, rows[0].check_in, rows[0].check_out, randomUUID()],
      ),
      (err: any) => err.code === '23P01',
    );
  });
});

describe('idempotência (resposta perdida)', () => {
  test('repetir com a mesma chave devolve o resultado original; com outro conteúdo é rejeitado', async () => {
    const t = await login('Ana');
    const key = randomUUID();
    const body = { roomId: 201, checkIn: futureDate(5), checkOut: futureDate(7), guests: 3, bedLayout: 'CASAL_SOLTEIRO' };
    const first = await call('POST', '/api/holds', t, body, { 'idempotency-key': key });
    const retry = await call('POST', '/api/holds', t, body, { 'idempotency-key': key });
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.replayed, true);
    assert.equal(retry.body.booking.id, first.body.booking.id);
    const reuse = await call('POST', '/api/holds', t, { ...body, guests: 2, bedLayout: 'CASAL' }, { 'idempotency-key': key });
    assert.equal(reuse.status, 422);
    assert.equal(reuse.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  test('mesma chave enviada em paralelo gera uma única reserva', async () => {
    const t = await login('Bruno');
    const key = randomUUID();
    const body = { roomId: 202, checkIn: futureDate(5), checkOut: futureDate(6), guests: 1, bedLayout: 'SOLTEIRO' };
    const rs = await Promise.all([1, 2, 3].map(() => call('POST', '/api/holds', t, body, { 'idempotency-key': key })));
    const ids = new Set(rs.map((r) => r.body.booking.id));
    assert.equal(ids.size, 1);
  });
});

describe('preço e regras de camas', () => {
  test('3º andar: 110% × pessoas × diárias; configuração fixa', async () => {
    const t = await login('Diego');
    const ok = await call('POST', '/api/holds', t, { roomId: 301, checkIn: futureDate(20), checkOut: futureDate(22), guests: 4, bedLayout: 'CASAL_DOIS_SOLTEIROS' }, { 'idempotency-key': randomUUID() });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.booking.totalPrice, 110 * 4 * 2);
    const bad = await call('POST', '/api/holds', t, { roomId: 302, checkIn: futureDate(20), checkOut: futureDate(22), guests: 2, bedLayout: 'DOIS_CASAIS' }, { 'idempotency-key': randomUUID() });
    assert.equal(bad.status, 422);
  });

  test('1º andar: 90% da base; camas precisam comportar os hóspedes', async () => {
    const t = await login('Eva');
    const ok = await call('POST', '/api/holds', t, { roomId: 103, checkIn: futureDate(2), checkOut: futureDate(3), guests: 2, bedLayout: 'DOIS_SOLTEIROS' }, { 'idempotency-key': randomUUID() });
    assert.equal(ok.body.booking.totalPrice, 180);
    const bad = await call('POST', '/api/holds', t, { roomId: 104, checkIn: futureDate(2), checkOut: futureDate(3), guests: 3, bedLayout: 'CASAL' }, { 'idempotency-key': randomUUID() });
    assert.equal(bad.status, 422);
  });
});

describe('confirmação, expiração e autorização', () => {
  test('confirmar gera comprovante; outro hóspede não lê a reserva; recepção lê', async () => {
    const ana = await login('Ana');
    const bruno = await login('Bruno');
    const recep = await login('Recepção', 'RECEPTION', '1234');
    const h = await call('POST', '/api/holds', ana, { roomId: 203, checkIn: futureDate(8), checkOut: futureDate(9), guests: 2, bedLayout: 'CASAL' }, { 'idempotency-key': randomUUID() });
    const id = h.body.booking.id;
    const steal = await call('POST', `/api/bookings/${id}/confirm`, bruno);
    assert.equal(steal.status, 403);
    const c = await call('POST', `/api/bookings/${id}/confirm`, ana);
    assert.equal(c.status, 200);
    assert.match(c.body.booking.receiptCode, /^HTL-/);
    const again = await call('POST', `/api/bookings/${id}/confirm`, ana);
    assert.equal(again.body.replayed, true);
    assert.equal((await call('GET', `/api/bookings/${id}`, bruno)).status, 403);
    assert.equal((await call('GET', `/api/bookings/${id}`, recep)).status, 200);
    const audit = await pool.query("SELECT 1 FROM audit_log WHERE action = 'READ_BOOKING' AND result = 'DENIED'");
    assert.ok(audit.rowCount! >= 1);
  });

  test('pré-reserva expira e libera o apartamento', async () => {
    const a = await login('Fábio');
    const b = await login('Gabi');
    const body = { roomId: 204, checkIn: futureDate(15), checkOut: futureDate(16), guests: 1, bedLayout: 'CASAL' };
    const h = await call('POST', '/api/holds', a, body, { 'idempotency-key': randomUUID() });
    assert.equal(h.status, 201);
    await new Promise((r) => setTimeout(r, 2300));
    const late = await call('POST', `/api/bookings/${h.body.booking.id}/confirm`, a);
    assert.ok([409, 410].includes(late.status));
    const other = await call('POST', '/api/holds', b, body, { 'idempotency-key': randomUUID() });
    assert.equal(other.status, 201);
  });

  test('credencial expirada é recusada', async () => {
    const t = await login('Helena');
    await call('POST', '/api/session/expire', t);
    const r = await call('GET', '/api/me', t);
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'TOKEN_EXPIRED');
  });

  test('recepção exige PIN', async () => {
    const r = await call('POST', '/api/session', undefined, { name: 'Intruso', role: 'RECEPTION', pin: '0000' });
    assert.equal(r.status, 401);
  });
});

describe('relógio de Lamport e tempo real', () => {
  test('servidor avança o relógio para além do valor do cliente', async () => {
    const t = await login('Igor');
    const r = await call('POST', '/api/holds', t, { roomId: 302, checkIn: futureDate(3), checkOut: futureDate(4), guests: 2, bedLayout: 'CASAL_DOIS_SOLTEIROS' }, { 'idempotency-key': randomUUID(), 'x-lamport': '100000' });
    assert.ok(r.body.lamport > 100000);
  });

  test('evento chega via WebSocket a outro celular, com seq crescente', async () => {
    const watcher = await login('Observador');
    const actor = await login('Ator');
    const socket = ioc(base, { auth: { token: watcher }, transports: ['websocket'] });
    const received: any[] = [];
    await new Promise<void>((r) => socket.on('hello', () => r()));
    socket.on('event', (e) => received.push(e));
    await call('POST', '/api/holds', actor, { roomId: 303, checkIn: futureDate(3), checkOut: futureDate(4), guests: 1, bedLayout: 'CASAL_DOIS_SOLTEIROS' }, { 'idempotency-key': randomUUID() });
    for (let i = 0; i < 40 && !received.some((e) => e.type === 'booking.held' && e.payload.booking.roomId === 303); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    socket.close();
    const e = received.find((x) => x.type === 'booking.held' && x.payload.booking.roomId === 303);
    assert.ok(e, 'evento não recebido');
    for (let i = 1; i < received.length; i++) assert.ok(received[i].seq > received[i - 1].seq);
  });
});

describe('laboratório de corrida', () => {
  test('modo SAFE tem exatamente 1 vencedor; modo NAIVE pode ter vários', async () => {
    const recep = await login('Recepção', 'RECEPTION', '1234');
    const players = await Promise.all(Array.from({ length: 8 }, (_, i) => login(`Jogador ${i}`)));
    for (const mode of ['SAFE', 'NAIVE'] as const) {
      const r = await call('POST', '/api/lab/rounds', recep, { mode });
      const wait = new Date(r.body.round.fireAt).getTime() - Date.now();
      await new Promise((res) => setTimeout(res, Math.max(0, wait)));
      const rs = await Promise.all(players.map((t) => call('POST', `/api/lab/rounds/${r.body.round.id}/attempt`, t)));
      const winners = rs.filter((x) => x.body.attempt?.success).length;
      if (mode === 'SAFE') assert.equal(winners, 1);
      else assert.ok(winners > 1, `modo ingênuo deveria produzir mais de um vencedor (obteve ${winners})`);
    }
  });
});
