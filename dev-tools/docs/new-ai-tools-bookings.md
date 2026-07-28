# Novas AI Tools — Reservas (Bookings)

Ficheiro: `packages/gitbook/src/components/AI/tools.ts`
Criadas em `352cd40d` (sc-7473), afinadas em `25f916d0` e `da816129`.

Estas 5 tools foram adicionadas ao array devolvido por `getTools()`, antes de `getControlTools()`, `builtInTools` e `integrationTools` (que já existiam). Todas dependem de um `locale` passado a `getTools(builtInTools, locale = 'pt')`, usado para formatar datas e montar URLs de formulários.

## Infraestrutura de suporte (não são tools, mas são usadas por elas)

| Helper | O que faz |
|---|---|
| `getBookings(page, size, filters, sort, locale)` | GET `/~gitbook/bff/bookings` (proxy BFF → `api.icligo.com/legacy-system/v1/bookings`), paginado |
| `getBooking(bookingId, locale)` | GET `/~gitbook/bff/bookings/{bookingId}` (proxy BFF → `.../bookings/{id}`) |
| `collectAvailableActions(nodes, trail, parentValue)` | Percorre a árvore de ações da reserva (`booking.actions`) e devolve só as folhas com `available === true`, achatadas, com o caminho de categorias |
| `formatBookingDates(value, locale)` | Percorre recursivamente o objeto/array e reformata qualquer string ISO 8601 para `DD/MM/YYYY` ou `MM/DD/YYYY` conforme o `locale`, em UTC |
| `countPassengers(booking)` | `adults + childs` de `booking.tripInfo`; devolve `null` se não aplicável (ex. eventos) |
| `buildSupportFormUrl(locale, category, type, bookingId)` | Monta o URL do formulário de suporte em `https://myoffice.icligo.com/{locale}/forms/support?category=...&type=...&booking=...` |

Ambos os endpoints BFF (`/~gitbook/bff/bookings` e `/~gitbook/bff/bookings/[bookingId]`) reenviam o `access_token` do cookie do pedido como header `Cookie` para a API legacy (`api.icligo.com/legacy-system/v1/bookings`).

---

## 1. `list_my_bookings`

Lista as reservas do próprio utilizador.

**Quando usar:** o utilizador pergunta pelas suas reservas, viagens futuras/passadas, ou quer encontrar uma reserva específica.

**Regras chave da descrição:**
- Responder ESTRITAMENTE com os dados devolvidos — nunca inventar reservas, datas, destinos, preços ou estados.
- Se a lista vier vazia, dizer isso claramente (não inventar).
- Devolve no máximo as primeiras 20 reservas (ordenadas por `checkin`); se pode haver mais, avisar que não é a lista completa.
- Datas já vêm formatadas para a língua do utilizador — apresentar tal e qual, nunca mostrar ISO em bruto.
- Apresentação obrigatória: uma entrada por reserva, sempre com exatamente 3 campos, na mesma ordem/layout:
  1. **Localizador** (`locator`)
  2. **Data de check-in** (`checkin`, já formatada)
  3. **Número de passageiros** (`passengers`, = adultos + crianças; se `null`, mostrar "não disponível")
- Se um destes 3 campos faltar, mostrar o campo mesmo assim indicando "não disponível" (nunca omitir o campo).
- Não acrescentar outros campos a menos que o utilizador peça mais detalhe.

### Input schema

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `state` | string | não | Filtra por estado. Valores possíveis: `CHECKIN`, `PENDING_PAYMENT`, `CANCELED_NOT_PAID`, `COMPLETED`, `ON_APPROVAL`, `PENDING_INVOICE`, `CANCELED` |
| `startDate` | string | não | `YYYY-MM-DD` — só reservas a partir desta data |
| `endDate` | string | não | `YYYY-MM-DD` — só reservas até esta data |

### Execução

1. Monta filtros: `{ type: 'ALL', date: 'booking', state?, startDate?, endDate? }` e `sort: { sort: 'checkinDate', order: 'ascend' }`.
2. Chama `getBookings(0, 20, filters, sort, locale)`.
3. Para cada booking, adiciona `passengers` via `countPassengers`.
4. Aplica `formatBookingDates` a toda a lista.

### Output

```jsonc
{
  "output": {
    "bookings": [ /* array de reservas, cada uma com todos os campos originais + `passengers` */ ],
    "count": 3
  },
  "summary": { "icon": "calendar", "text": "Found 3 booking(s)" }
}
```

---

## 2. `get_booking_details`

Detalhes completos de UMA reserva (datas, destino, hóspedes, preço, estado, documentos).

**Quando usar:** só DEPOIS de `list_my_bookings`, com um `bookingId` devolvido por essa tool, e só quando o utilizador pede mais detalhe sobre uma reserva específica.

**Regras chave:**
- Responder ESTRITAMENTE com os dados devolvidos; se faltar um campo, dizer que não está disponível — nunca inventar/completar.
- Nunca misturar dados de outras reservas.
- Nunca expor dados sensíveis/internos: detalhes de pagamento/cartão, documentos de identificação/fiscais completos, IDs internos, URLs/tokens em bruto, dados pessoais de terceiros.
- Não explicar aqui como executar ações (isso é `list_booking_actions`) nem os passos de check-in (isso é `explain_booking_checkin`).

### Input schema

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `bookingId` | string | sim (implícito) | Id de reserva, ex. um dos devolvidos por `list_my_bookings` |

### Execução

Chama `getBooking(bookingId, locale)` e devolve o resultado tal e qual (sem formatação de datas nem filtragem de campos sensíveis no código — a restrição de não expor dados sensíveis é apenas via prompt/descrição, não é enforced no `execute`).

### Output

```jsonc
{
  "output": { "booking": { /* objeto bruto devolvido pela API legacy */ } },
  "summary": { "icon": "calendar", "text": "Details for booking {bookingId}" }
}
```

---

## 3. `list_booking_actions`

Lista as ações concretas que o utilizador pode executar AGORA numa reserva (reclamação, cancelar, modificar datas/hóspedes, adicionar seguro, enviar dados do cliente, check-in, ...).

**Quando usar:** só depois de `list_my_bookings` ou `get_booking_details`, e só quando o utilizador pergunta o que pode fazer / que opções tem / como gerir a reserva.

**Regras chave:**
- Se `found` for `false`, dizer que a reserva não foi encontrada — nunca dizer "não tem ações".
- Se `found` for `true` e `actions` não estiver vazio, apresentar essas ações obrigatoriamente — nunca inventar/assumir ações fora da lista.
- Apresentação obrigatória: uma entrada por ação disponível, mesmo layout sempre — nome (`label`) + link em Markdown `[label](formUrl)`.
- Se `formUrl` for `null` (ação sem formulário direto, ex. check-in): mostrar a ação mas dizer que não há link de formulário; para check-in, indicar ao utilizador para perguntar como fazer o check-in (tratado por `explain_booking_checkin`).
- Nunca inventar/alterar um URL — usar `formUrl` tal e qual.
- Não descrever aqui os passos para executar uma ação — só dar o link do formulário.

### Input schema

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `bookingId` | string | sim (implícito) | Id de reserva, ex. um dos devolvidos por `list_my_bookings` |

### Execução

As ações NÃO vêm no detalhe (`getBooking`), só existem nos registos da listagem (`getBookings`):

1. Percorre páginas de `getBookings` (filtros `{ type: 'ALL', date: 'booking' }`, sort por `checkinDate`, até 10 páginas / `MAX_PAGES`) à procura de um registo cujo `bookingId`, `id` ou `locator` corresponda ao `bookingId` pedido.
2. Se encontrado, corre `collectAvailableActions(record.actions)` para obter as folhas disponíveis (`label`, `action`, `category`, `path`).
3. Para cada ação, calcula `formUrl`:
   - Se `path` começa por `"Suporte"` e tem `category` → `buildSupportFormUrl(locale, category, action, bookingId)`.
   - Caso contrário → `null`.

### Output

```jsonc
{
  "output": {
    "bookingId": "ABC123",
    "found": true,
    "actions": [
      {
        "label": "Reclamação",
        "action": "COMPLAINT",
        "category": "BOOKINGMANAGMENT",
        "path": "Suporte > Gestão de reserva > Reclamação",
        "formUrl": "https://myoffice.icligo.com/pt/forms/support?category=BOOKINGMANAGMENT&type=COMPLAINT&booking=ABC123"
      },
      {
        "label": "Check-in",
        "action": "CHECKIN",
        "category": null,
        "path": "Check-in",
        "formUrl": null
      }
    ]
  },
  "summary": {
    "icon": "list-check",
    "text": "Found 2 available action(s) for booking ABC123"
    // ou, se not found: "Booking ABC123 not found in the bookings list"
  }
}
```

---

## 4. `open_booking_support_ticket`

Abre o formulário de suporte de uma reserva numa nova aba do browser, para uma categoria/tipo escolhidos.

**Quando usar:** só com uma ação de suporte devolvida por `list_booking_actions` para essa mesma reserva (ou seja, uma cujo `path` comece por `"Suporte"`), passando o `category` e `action`(=`type`) dessa ação. Não usar para ações que não sejam de suporte (ex. check-in).

**Confirmação (UI):** tool com `confirmation` — ícone `life-ring`, label **"Open support form"** (o utilizador tem de confirmar antes de correr).

### Input schema

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `bookingId` | string | sim (implícito) | Id da reserva |
| `category` | string | sim (implícito) | Código `category` de uma ação de suporte devolvida por `list_booking_actions` |
| `type` | string | sim (implícito) | Código `action` dessa mesma ação de suporte |

### Execução

1. `buildSupportFormUrl(locale, category, type, bookingId)`.
2. `window.open(url, '_blank', 'noopener,noreferrer')` — abre no browser do cliente.

### Output

```jsonc
{
  "output": { "url": "https://myoffice.icligo.com/pt/forms/support?category=...&type=...&booking=ABC123" },
  "summary": { "icon": "life-ring", "text": "Opened support form for booking ABC123" }
}
```

---

## 5. `explain_booking_checkin`

Explica passo a passo como fazer o CHECK-IN de uma reserva no Backoffice.

**Quando usar:** só quando o utilizador pergunta explicitamente como fazer/completar o check-in de uma reserva.

**Regras chave:**
- Primeiro confirma, a partir dos dados da reserva, se o check-in está disponível (`available`).
- Se `available` for `false`: dizer que o check-in não é possível agora — nunca inventar passos.
- Se `available` for `true`: guiar o utilizador usando APENAS os `steps` devolvidos, pela ordem dada, sem acrescentar passos próprios.
- Exclusiva para check-in — não usar para cancelar, modificar, pagamento, contacto ou suporte.

### Input schema

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `bookingId` | string | sim (implícito) | Id da reserva |

### Execução

1. `getBooking(bookingId, locale)`.
2. Procura em `booking.actions` uma ação cujo `value` esteja em `CHECKIN_ACTION_VALUES = ['CHECKIN', 'CHECK_IN', 'checkin', 'check-in']` (ainda não há um endpoint dedicado de check-in — TODO no código).
3. `available = checkinAction?.available === true`.
4. Se `available`, devolve passos fixos no código (TODO: substituir por dados de um endpoint próprio quando existir):
   - "Abra a reserva a partir da lista de reservas ('As minhas reservas')."
   - "No detalhe da reserva, selecione a ação de check-in."
   - "Confirme os dados dos hóspedes e conclua o check-in."
   Se não disponível, `steps` fica `[]`.

### Output

```jsonc
{
  "output": {
    "bookingId": "ABC123",
    "available": true,
    "steps": [
      "Abra a reserva a partir da lista de reservas (\"As minhas reservas\").",
      "No detalhe da reserva, selecione a ação de check-in.",
      "Confirme os dados dos hóspedes e conclua o check-in."
    ]
  },
  "summary": {
    "icon": "circle-check",
    "text": "Check-in instructions for booking ABC123"
    // ou, se não disponível: "Check-in not available for booking ABC123"
  }
}
```

---

## Fluxo típico de uso pelas tools

```
list_my_bookings
   └─> get_booking_details        (mais detalhe de UMA reserva)
   └─> list_booking_actions       (o que pode fazer nessa reserva)
          ├─> open_booking_support_ticket   (ações do ramo "Suporte")
          └─> explain_booking_checkin       (ação de check-in, sem formulário)
```

## Endpoints BFF usados (Next.js route handlers)

| Rota | Método | Proxy para | Header enviado |
|---|---|---|---|
| `/~gitbook/bff/bookings` | GET | `https://api.icligo.com/legacy-system/v1/bookings` | `Cookie: access_token=...` (do cookie `access_token` do pedido) |
| `/~gitbook/bff/bookings/[bookingId]` | GET | `https://api.icligo.com/legacy-system/v1/bookings/{bookingId}` | idem |

Parâmetros de query reencaminhados em `/~gitbook/bff/bookings`: `page`, `date`, `type`, `sort`, `order`, `lang`, e opcionalmente `state`, `startDate`, `endDate`.

## Notas / dívida técnica identificada no código

- `CHECKIN_ACTION_VALUES` é uma lista de valores possíveis porque ainda não existe um identificador único/estável para a ação de check-in (TODO em `tools.ts:16`).
- Os `steps` de `explain_booking_checkin` estão fixos no código; deviam vir de um endpoint dedicado de check-in quando este existir (TODO em `tools.ts:456`).
- `get_booking_details` não filtra campos sensíveis no `execute` — a restrição de não expor dados sensíveis depende inteiramente da instrução dada ao modelo na `description`, não é enforced no código.
