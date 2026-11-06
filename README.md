# 🏨 Hotel Distribuído

Aplicação web (mobile-first) de reservas para um hotel de 12 apartamentos, feita para o
**Mini-Ideathon de Aplicações Distribuídas** (Sistemas Distribuídos — DISC.1764).
Vários celulares usam o app ao mesmo tempo e disputam os mesmos quartos em tempo real.

**Stack:** TypeScript · Node.js (Express + Socket.IO) · React + Vite · Tailwind CSS · PostgreSQL (Neon) · Render

## O hotel

| Andar | Aptos | Camas | Diária por pessoa |
|---|---|---|---|
| 3º | 301–304 | fixo: 1 casal + 2 solteiros | R$ 110,00 (110%) |
| 2º | 201–204 | adaptável (casal/solteiro) | R$ 100,00 (100%) |
| 1º | 101–104 | adaptável (casal/solteiro) | R$ 90,00 (90%) |
| Térreo | — | recepção | — |

Total = diária por pessoa × hóspedes (1 a 4) × número de diárias.

## Os três problemas distribuídos, na prática

### 1. Sincronização de processos / exclusão mútua
* **Pré-reserva (HOLD) com prazo** (padrão 2 min): o apto fica segurado enquanto o hóspede confirma; expira sozinho.
* **Trava por apartamento** (`pg_advisory_xact_lock`) — seção crítica compartilhada por todas as instâncias do servidor.
* **Rede de segurança no banco:** constraint `EXCLUDE USING gist` impede dois períodos ativos sobrepostos no mesmo apto.
* **Idempotência:** cada operação envia `Idempotency-Key`; a chave é gravada atomicamente com a reserva. Repetir após
  timeout devolve o comprovante original (opção *“Simular perda da resposta”* no app).
* **Relógio lógico de Lamport:** cada requisição/evento carrega `L`; o servidor aplica `L = max(L, L_cliente) + 1`.
* **Aba ⚡ Corrida:** a recepção inicia uma rodada; todos os celulares disparam **no mesmo instante** (relógio
  sincronizado pelo algoritmo de Cristian). Modo *com trava* → 1 vencedor. Modo *sem trava* → overbooking.

### 2. Comunicação distribuída
* **WebSocket (Socket.IO)** do servidor para os celulares: cada mudança vira um evento.
* **Entre instâncias do servidor:** `LISTEN/NOTIFY` do PostgreSQL (com polling de segurança). Rode dois nós e veja
  um celular no nó A receber em tempo real a reserva feita no nó B.
* **Heartbeat** das instâncias (tabela `instances`) e contagem de celulares online.
* **Outbox transacional:** o evento é gravado na mesma transação da mudança de estado.

### 3. Integração e consistência de dados
* O **PostgreSQL é a autoridade** (consistência forte nas escritas).
* Cada celular mantém uma **réplica local** (consistência eventual): snapshot inicial + eventos ordenados por `seq`.
* **Detecção de lacunas:** se chegar o `seq` N+2 sem o N+1, o celular busca o que falta em `/api/events?after=N`.
* **Versão por reserva:** atualizações antigas são descartadas; as réplicas convergem.
* **Aba 📡 Rede:** *Simular queda* → outra pessoa reserva → *Reconectar*: o celular recupera os eventos perdidos.

### Segurança (Unidade 3, cap. 4)
Sessão com token (hash SHA-256 no banco, expiração), perfil Recepção com PIN, **autorização por objeto**
(só o dono ou a recepção leem uma reserva), limite de requisições, máx. 2 pré-reservas abertas por hóspede,
**log de auditoria** com identificador de correlação, botão *Expirar minha credencial* para demonstração.

## Rodando localmente

Pré-requisitos: Node 20+ e um PostgreSQL (local ou Neon).

```bash
npm install
cp .env.example .env   # ajuste DATABASE_URL
npm run build
npm start              # http://localhost:3000
```

Desenvolvimento com recarga: `npm run dev:server` e, em outro terminal, `npm run dev:client` (http://localhost:5173).

**Simulando dois nós** (mesmo banco):

```bash
PORT=3000 INSTANCE_ID=no-A node server/dist/index.js &
PORT=3001 INSTANCE_ID=no-B node server/dist/index.js &
```

**Testes** (usam um banco separado e APAGAM o schema dele):

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/hotel_test npm test
```

Cobrem: 20 reservas simultâneas no mesmo apto (1 vence), constraint do banco, idempotência (sequencial e paralela),
preços por andar, regras de camas, expiração da pré-reserva, autorização, credencial expirada, Lamport,
entrega via WebSocket e corrida com/sem trava.

## Deploy (Render + Neon)

1. **Neon** → crie o projeto → *Connect* → desative *Connection pooling* → copie a connection string
   (`postgresql://...neon.tech/neondb?sslmode=require`).
2. **Render** → *New* → *Blueprint* → selecione este repositório (usa o `render.yaml`).
3. Preencha `DATABASE_URL` (do Neon) e `RECEPTION_PIN` (ex.: 4 dígitos) → *Apply*.
4. Ao terminar o build, abra a URL `https://hotel-distribuido-xxxx.onrender.com`.

> O plano gratuito do Render hiberna após ~15 min sem acesso; abra o link ~1 min antes da apresentação.

## Roteiro de demonstração (5 min)

1. Todos entram pelo QR code com o próprio nome; a recepção entra com o PIN.
2. **Quartos:** todos escolhem as mesmas datas e tocam no **201** → só um consegue a pré-reserva; os outros veem o
   apto ficar amarelo com contagem regressiva, em tempo real.
3. **Corrida sem trava** → overbooking. **Corrida com trava** → 1 vencedor.
4. **Rede:** um celular simula queda, outro reserva, o primeiro reconecta e recupera os eventos.
5. **Idempotência:** marque *Simular perda da resposta* e reserve → mesma reserva, sem duplicata.
6. **Recepção → Auditoria:** acessos negados, conflitos e correlação.
