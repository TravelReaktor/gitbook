# Correr o projeto localmente e aceder à documentação

Guia prático para este checkout específico (inclui os passos para ver a documentação privada `icligo-help-center`, usada no iframe `/documentation` do mfe). Para o mapa arquitetural completo do projeto, ver [CONTEXT.md](CONTEXT.md).

## 1. Pré-requisitos

- Node `^22.3.0` (`nvm use`).
- **Bun `1.3.7` exato** — o `packageManager` do [package.json](package.json) está pinado a esta versão. Uma versão diferente (ex: `1.3.0`) reescreve o formato do `bun.lock` ao instalar e deixa o workspace mal instalado (dependências em falta em runtime, tipo `framer-motion`).
  ```bash
  bun upgrade
  bun --version   # confirmar 1.3.7 (ou mais recente)
  ```

## 2. Instalar e arrancar

```bash
bun install
bun dev
```

Se `bun dev` der erro `Module not found` para algum pacote (ex: `framer-motion`), a instalação ficou incompleta — repor o lockfile e reinstalar do zero costuma resolver:
```bash
git checkout -- bun.lock
rm -rf node_modules packages/*/node_modules
bun install
```

## 3. Testar com um espaço público (sem credenciais)

Serve para confirmar que o ambiente está saudável, sem precisar de tokens:
```
http://localhost:3000/url/gitbook.com/docs
http://localhost:3000/url/open-source.gitbook.io/midjourney
```

## 4. Configurar o `.env.local` (opcional)

Fica na **raiz do repo** (não em `packages/gitbook/`) — o script `dev` lê-o via `env-cmd -f ../../.env.local`.

```
GITBOOK_API_TOKEN=<o teu token pessoal>
```

Para gerar o token: `app.gitbook.com` → avatar → **Settings** → **Developer** → **API tokens** → criar um novo (nome sugerido: `local-dev`), copiar o valor (só é mostrado uma vez).

Este token só serve para **evitar rate-limiting** em pedidos anónimos à API ([globals.ts:58-61](packages/gitbook/src/lib/env/globals.ts:58) — o próprio comentário no código diz isto). **Não é** o que dá acesso a espaços com Visitor Authentication (secção seguinte) — para esses, o `jwt_token` sozinho já basta: ao validá-lo, a API da GitBook emite o seu próprio token de acesso ao conteúdo (ver [middleware.ts:393](packages/gitbook/src/middleware.ts:393)), independente do `GITBOOK_API_TOKEN` local. Por isso continuas a ver a documentação mesmo depois de apagares o teu token pessoal.

## 5. Ver a documentação privada (`icligo-help-center`)

O espaço `icligo-1.gitbook.io/icligo-help-center` tem **Visitor Authentication (VA)** ativa — é o mesmo mecanismo que o mfe usa para embeber a documentação no iframe `/documentation` ([GitBookDocsFrame.js](../MFE/mfe/apps/icligo-ui-backoffice/src/components/GitBook/GitBookDocsFrame.js)). Um `GITBOOK_API_TOKEN` válido, mesmo de admin, **não** contorna esta gate — só um `jwt_token` assinado com o segredo de VA do espaço o faz.

Sem esse token, `http://localhost:3000/url/icligo-1.gitbook.io/icligo-help-center` mostra:
```
Authentication missing to access this content
```

### Como obter um `jwt_token` válido

1. Corre o mfe (`icligo-ui-backoffice`) localmente ou usa um ambiente já em execução, com login feito.
2. Abre a página `/documentation` (é o que dispara o pedido de token).
3. No DevTools → separador **Network**, procura o pedido a `/gitbook/visitor-token` e copia o valor de `token` da resposta JSON.
4. Usa-o na URL local:
   ```
   http://localhost:3000/url/icligo-1.gitbook.io/icligo-help-center?jwt_token=<TOKEN_COPIADO>
   ```

O token tem expiração curta (na ordem da hora) — repete o passo 3 quando expirar.

**Não desatives a Visitor Authentication do espaço** só para testar localmente — o `jwt_token` é a forma correta de o fazer sem tornar o espaço público.

## 6. Limitação conhecida: ícones em falta

Um checkout local deste open-source só gera o conjunto de ícones "custom" da GitBook (`scripts/generate.sh` → `gitbook-icons ... custom-icons`). O conjunto completo Font Awesome Pro é proprietário e não está disponível fora dos deployments oficiais da GitBook — por isso a maioria dos ícones dá 404 em local (`/~gitbook/static/icons/svgs/**`). Isto é **cosmético**: as páginas continuam a renderizar, só os ícones aparecem em falta. (Havia um bug relacionado que fazia isto rebentar a página inteira em vez de só faltar o ícone — já corrigido em [src/lib/icons/inline.ts](packages/gitbook/src/lib/icons/inline.ts), ver [CONTEXT.md §16](CONTEXT.md).)
