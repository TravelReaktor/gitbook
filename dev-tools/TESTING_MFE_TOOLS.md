# Testar as custom tools do mfe no assistente do GitBook (local)

Guia passo a passo, autossuficiente, para outro agente (ou humano) reproduzir o teste: registar as custom tools de IA definidas no mfe (`apps/icligo-ui-backoffice/src/components/GitBook/gitBookTools.js`, projeto em `/Users/tiagorocha/Desktop/MFE/mfe`) no assistente de IA deste projeto gitbook, a correr localmente, sem precisar de arrancar o mfe.

## Contexto (porque isto funciona)

- Este projeto (`gitbook`) é o motor de renderização open-source que serve sites GitBook publicados. Localmente, qualquer site publicado é acessível via proxy: `http://localhost:3000/url/<url-publicado>`.
- Qualquer página do site standalone expõe um objeto global **`window.GitBook`** no browser, com o método **`registerTool(tool)`** — API pública definida em [packages/gitbook/src/components/Integrations/LoadIntegrations.tsx](../packages/gitbook/src/components/Integrations/LoadIntegrations.tsx) (linha ~68) e tipada em [packages/browser-types/src/index.ts](../packages/browser-types/src/index.ts) (`GitBookIntegrationTool`).
- O formato `GitBookIntegrationTool` (`{name, description, inputSchema, confirmation?, execute}`) é **idêntico** ao formato usado pelas tools do mfe em `gitBookTools.js` — dá para copiar a definição quase sem alterações.
- Registar uma tool via `window.GitBook.registerTool(...)` não requer nenhuma alteração de código neste repositório nem no mfe — é só JavaScript corrido na consola do browser depois da página carregar.
- O espaço de destino (`icligo-1.gitbook.io/icligo-help-center`) tem **Visitor Authentication (VA)** ativa, por isso é preciso um `?jwt_token=` válido na URL para o ver localmente (ver secção 2).

## Pré-requisitos

- Bun `1.3.7` exato instalado (`bun --version`).
- Repositório `/Users/tiagorocha/Desktop/gitbook icligo/gitbook` com dependências instaladas (`bun install`).
- `.env.local` na raiz do repo (opcional — só evita rate-limiting, não é necessário para este teste):
  ```
  GITBOOK_API_TOKEN=<token pessoal, opcional>
  ```
- Um `jwt_token` válido para o espaço `icligo-help-center` (ver passo 2) — sem ele a página mostra `Authentication missing to access this content`.

## Passo 1 — Arrancar o servidor de dev

```bash
cd "/Users/tiagorocha/Desktop/gitbook icligo/gitbook"
bun dev
```

Espera até aparecer `✓ Ready` / a compilação da rota terminar (a primeira visita a uma rota compila on-demand, pode demorar 10-30s).

## Passo 2 — Obter um `jwt_token` de visitante

O espaço `icligo-help-center` tem Visitor Authentication ativa. O token é emitido pelo backend do mfe (não pelo GitBook diretamente):

1. No repositório mfe (`/Users/tiagorocha/Desktop/MFE/mfe`), corre a app backoffice numa porta diferente de 3000 (o gitbook já a ocupa):
   ```bash
   cd /Users/tiagorocha/Desktop/MFE/mfe/apps/icligo-ui-backoffice
   yarn dev -p 4000
   ```
2. Abre `http://localhost:4000`, faz login com uma conta válida.
3. Abre qualquer página do backoffice (o widget flutuante "?" no canto inferior direito já dispara o pedido do token).
4. DevTools → separador **Network** → procura o pedido `GET /gitbook/visitor-token` → copia o valor de `token` da resposta JSON.
5. O token expira ao fim de cerca de 2 horas (`exp` no payload JWT) — repete este passo se expirar.

Alternativa mais rápida se já tiveres um token válido de uma sessão anterior: reutiliza-o diretamente (é um JWT `eyJhbGci...`, sem quebras de linha).

## Passo 3 — Abrir o site local com o token

Navega (no browser, ou via ferramenta de automação) para:
```
http://localhost:3000/url/icligo-1.gitbook.io/icligo-help-center?jwt_token=<TOKEN_DO_PASSO_2>
```

Confirma que a página carrega o conteúdo do "iCliGo Help Center" (não o erro `Authentication missing to access this content`).

Se estiveres a controlar o browser via ferramentas Claude Preview (`mcp__Claude_Preview__*`):
```
mcp__Claude_Preview__preview_start  (name da config em .claude/launch.json, ex: "🚀 Dev server")
mcp__Claude_Preview__preview_eval   com expression:
  window.location.href = 'http://localhost:3000/url/icligo-1.gitbook.io/icligo-help-center?jwt_token=<TOKEN>';
mcp__Claude_Preview__preview_screenshot   (para confirmar visualmente)
```

## Passo 4 — Confirmar que `window.GitBook` está disponível

Corre na consola do browser (ou via `preview_eval`):
```js
typeof window.GitBook !== 'undefined' ? Object.keys(window.GitBook) : 'window.GitBook is undefined'
```
Resultado esperado:
```
["addEventListener","removeEventListener","registerTool","registerAssistant","registerCookieBanner","isCookiesTrackingDisabled","isGlobalPrivacyControlEnabled"]
```
Se devolver `undefined`, a página ainda não terminou de montar `LoadIntegrations` (ver `packages/gitbook/src/components/SiteLayout/SiteLayout.tsx`) — espera mais um pouco ou recarrega.

## Passo 5 — Registar as tools do mfe

Cola o script completo abaixo na consola do browser (ou corre-o via `preview_eval`, como uma única expressão IIFE). É uma cópia adaptada de [gitBookTools.js](../../MFE/mfe/apps/icligo-ui-backoffice/src/components/GitBook/gitBookTools.js) do mfe — mesmos `name`/`description`/`inputSchema`/`confirmation`, mas com `execute()` a devolver **dados mock** (o backend real de reservas só existe no mfe; substitui por `fetch(...)` real se precisares de dados verdadeiros).

O ficheiro já existe em [dev-tools/mfe-test-tools.js](mfe-test-tools.js) — podes copiar o conteúdo de lá em vez de reescrever:

```js
(function () {
    const BOOKING_STATES = [
        'CHECKIN',
        'PENDING_PAYMENT',
        'CANCELED_NOT_PAID',
        'COMPLETED',
        'ON_APPROVAL',
        'PENDING_INVOICE',
        'CANCELED',
    ];

    window.GitBook.registerTool({
        name: 'list_my_bookings',
        description:
            "List the current user's bookings. Use when the user asks about reservations or travel history. Optionally filter by status, start date, end date.",
        inputSchema: {
            type: 'object',
            properties: {
                state: {
                    type: 'string',
                    description: `Optional. Filter by booking state. Possible values: ${BOOKING_STATES.join(', ')}.`,
                },
                startDate: { type: 'string', description: 'Optional. From date (YYYY-MM-DD).' },
                endDate: { type: 'string', description: 'Optional. To date (YYYY-MM-DD).' },
            },
        },
        async execute(input) {
            const bookings = [
                {
                    id: 'BK-1001',
                    checkinDate: '2026-08-01',
                    checkoutDate: '2026-08-05',
                    state: 'CHECKIN',
                    destination: 'Lisboa',
                },
                {
                    id: 'BK-1002',
                    checkinDate: '2026-09-10',
                    checkoutDate: '2026-09-12',
                    state: 'PENDING_PAYMENT',
                    destination: 'Porto',
                },
            ].filter((b) => !input.state || b.state === input.state);
            return {
                output: { bookings, count: bookings.length },
                summary: { icon: 'calendar', text: `[MOCK] Found ${bookings.length} booking(s)` },
            };
        },
    });

    window.GitBook.registerTool({
        name: 'get_booking_details',
        description:
            'Get full details for a single booking by its id (dates, guests, price, status, ...). Use after "list_my_bookings".',
        inputSchema: {
            type: 'object',
            properties: {
                bookingId: {
                    type: 'string',
                    description: 'The booking id, e.g. one of the ids returned by list_my_bookings.',
                },
            },
            required: ['bookingId'],
        },
        async execute(input) {
            const booking = {
                id: input.bookingId,
                checkinDate: '2026-08-01',
                checkoutDate: '2026-08-05',
                guests: 2,
                price: '350€',
                state: 'CHECKIN',
            };
            return {
                output: { booking },
                summary: { icon: 'calendar', text: `[MOCK] Details for booking ${input.bookingId}` },
            };
        },
    });

    window.GitBook.registerTool({
        name: 'list_booking_support_options',
        description:
            'List the support ticket categories/types that can be opened for a specific booking. Use after list_my_bookings or get_booking_details.',
        inputSchema: {
            type: 'object',
            properties: { bookingId: { type: 'string', description: 'The booking id.' } },
            required: ['bookingId'],
        },
        async execute(input) {
            const categories = [
                {
                    label: 'Pagamento',
                    category: 'payment',
                    types: [{ label: 'Problema com pagamento', type: 'payment_issue' }],
                },
            ];
            return {
                output: { bookingId: input.bookingId, categories },
                summary: { icon: 'life-ring', text: `[MOCK] Found ${categories.length} support option(s)` },
            };
        },
    });

    window.GitBook.registerTool({
        name: 'open_booking_support_ticket',
        description:
            'Open the support ticket form for a booking, for a chosen category and type. Use only with a category/type pair returned by list_booking_support_options.',
        confirmation: { icon: 'life-ring', label: 'Open support form' },
        inputSchema: {
            type: 'object',
            properties: {
                bookingId: { type: 'string', description: 'The booking id.' },
                category: { type: 'string', description: 'The category value.' },
                type: { type: 'string', description: 'The type value.' },
            },
            required: ['bookingId', 'category', 'type'],
        },
        async execute(input) {
            console.log('[MOCK] would open support form for', input);
            return {
                output: { url: '(mock, not opened)' },
                summary: { icon: 'life-ring', text: `[MOCK] Opened support form for booking ${input.bookingId}` },
            };
        },
    });

    console.log('[dev-tools] registered 4 mock mfe tools on window.GitBook');
})();
```

Resultado esperado no console: `[dev-tools] registered 4 mock mfe tools on window.GitBook`.

## Passo 6 — Disparar uma pergunta que invoque uma tool

Na página inicial do espaço há uma caixa de input com placeholder `"How can we help?"` (visível sem abrir nenhum painel extra).

Via DOM (consola ou `preview_eval`):
```js
(function () {
    const input = document.querySelector(
        'input[placeholder="How can we help?"], textarea[placeholder="How can we help?"]'
    );
    input.value = 'Quais são as minhas reservas?';
    input.dispatchEvent(new Event('input', { bubbles: true })); // necessário para frameworks controlados (React)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})();
```

Nota: se estiveres a usar `mcp__Claude_Preview__preview_fill` (preenche o campo) seguido de `mcp__Claude_Preview__preview_click` num botão "Enviar", o seletor `button:has-text("Enviar")` pode falhar (múltiplos matches / atributo `aria-label`); nesse caso usa `preview_eval` para despachar o evento `Enter` diretamente no input, como acima — foi o que funcionou na sessão original.

## Passo 7 — Verificar o resultado

Tira um screenshot (`mcp__Claude_Preview__preview_screenshot`) ou inspeciona a DOM. O painel do assistente deve abrir à direita mostrando:
- A pergunta feita.
- Indicação **"Explorado com 1 ferramenta"** (ou mais, se mais que uma tool for chamada).
- A resposta em linguagem natural, refletindo os dados mock devolvidos por `list_my_bookings` (reservas `BK-1001` Lisboa e `BK-1002` Porto).

Se a tool não for invocada: confirma que o Passo 5 correu **antes** de a pergunta ser enviada, e que não houve reload da página entre os dois passos (as tools ficam registadas num store em memória — `integrationsAssistantTools`, ver [packages/gitbook/src/components/Integrations/LoadIntegrations.tsx](../packages/gitbook/src/components/Integrations/LoadIntegrations.tsx) — que é limpo em cada reload).

## Troubleshooting

| Sintoma | Causa provável | Resolução |
|---|---|---|
| `Authentication missing to access this content` | `jwt_token` ausente/expirado | Repetir Passo 2 |
| `window.GitBook is undefined` | Página ainda a montar / script corrido cedo demais | Esperar/recarregar, repetir Passo 4 |
| Assistente responde sem invocar a tool | Pergunta ambígua ou tools registadas depois da pergunta ter sido enviada | Reformular a pergunta para referir claramente "reservas"/"bookings"; garantir ordem Passo 5 → Passo 6 |
| `Module not found` ao arrancar `bun dev` | Instalação incompleta / versão errada do Bun | Ver [RUNNING_LOCALLY.md](../RUNNING_LOCALLY.md) secção 1-2 |
| Ícones em falta na UI | Limitação conhecida (Font Awesome Pro não incluído no open-source) | Cosmético, ignorar — ver [RUNNING_LOCALLY.md](../RUNNING_LOCALLY.md) secção 6 |

## Ficheiros relacionados

- [dev-tools/mfe-test-tools.js](mfe-test-tools.js) — o mesmo script do Passo 5, pronto a colar.
- [RUNNING_LOCALLY.md](../RUNNING_LOCALLY.md) — como correr o projeto gitbook e configurar tokens.
- [CONTEXT.md](../CONTEXT.md) — mapa arquitetural completo do projeto.
- `/Users/tiagorocha/Desktop/MFE/mfe/apps/icligo-ui-backoffice/src/components/GitBook/gitBookTools.js` — definição original das tools reais (com `execute()` a chamar a API real de reservas).
