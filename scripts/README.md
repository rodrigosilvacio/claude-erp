# Deploy do backend (Supabase)

Passo a passo completo para colocar este ERP no ar num projeto Supabase seu,
do zero. Frontend (HTML/JS estático) é tratado à parte no fim deste arquivo.

## O que você precisa antes de começar

- Uma conta em [supabase.com](https://supabase.com) (plano gratuito serve
  para avaliar).
- [Supabase CLI](https://supabase.com/docs/guides/cli) instalado
  (`npm install -g supabase` ou `brew install supabase/tap/supabase`).
- Opcional, só se for usar essas integrações: conta no
  [Stripe](https://stripe.com) (pagamento online), conta no
  [Resend](https://resend.com) (e-mail transacional) com um domínio seu
  verificado, e uma instância no [Z-API](https://www.z-api.io) (lembretes
  por WhatsApp).

Nada disso precisa de servidor próprio — é tudo Supabase (Postgres + Auth +
Edge Functions) hospedado, e o frontend é arquivo estático puro.

## 1. Criar o projeto Supabase

No [dashboard do Supabase](https://supabase.com/dashboard), crie um novo
projeto (escolha uma região próxima dos seus usuários). Guarde a senha do
banco gerada na criação — só é pedida ali.

## 2. Conectar o Supabase CLI a este projeto

```bash
supabase login
supabase link --project-ref <REF-DO-SEU-PROJETO>
```

O `<REF-DO-SEU-PROJETO>` é o trecho antes de `.supabase.co` na URL do seu
projeto (Project Settings > API), ex.: `abcdefghijklmnop`.

## 3. Aplicar as migrations e publicar as Edge Functions

```bash
./scripts/deploy.sh
```

Isso roda `supabase db push` (aplica todo `supabase/migrations/*.sql`, em
ordem — são ~32 arquivos, é normal levar um minuto) e
`supabase functions deploy` para as 7 funções em `supabase/functions/`. O
`verify_jwt` de cada função já vem certo de `supabase/config.toml` — não
precisa mexer em nada no dashboard.

> Os nomes dos arquivos de migration pulam alguns números (ex.: vai de
> `0009` pra `0011`, de `0023` pra `0031`) — são migrations de outras
> aplicações do repositório de onde este projeto foi extraído, e não fazem
> parte deste sistema. Os números que restaram não foram renumerados de
> propósito: muitos comentários no próprio código (`ver migration 0020`,
> `ver migration 0033`, etc.) referenciam esses números exatos.

## 4. Configurar os secrets

```bash
cp scripts/.env.example scripts/.env
# preencha scripts/.env com os seus valores (ver comentários no arquivo)
./scripts/set-secrets.sh
```

`APPVENDAS_BOOTSTRAP_SECRET` e `APPVENDAS_LEMBRETES_SECRET` são
obrigatórios (só precisam ser strings aleatórias suas, ex.
`openssl rand -hex 32`). Os demais (`RESEND_*`, `STRIPE_*`, `ZAPI_*`) são
por integração — sem eles, só a funcionalidade específica (e-mail
transacional / pagamento online / lembrete por WhatsApp) fica indisponível,
o resto do sistema funciona normalmente.

## 5. Criar o primeiro usuário administrador

Com a tabela de usuários vazia, ninguém consegue logar para criar o
primeiro admin pela tela normal — por isso existe um script à parte:

```bash
./scripts/bootstrap-admin.sh
```

Ele pede a URL/anon key do projeto (Project Settings > API — "Project URL"
e a chave "anon public"/"publishable"), o `APPVENDAS_BOOTSTRAP_SECRET` que
você configurou no passo 4, e o nome/login/senha do admin. Esse admin nasce
**global** (sem empresa vinculada) — quem enxerga e configura todas as
empresas cadastradas no sistema.

## 6. Integrações opcionais

### Stripe (pagamento online)

1. `STRIPE_SECRET_KEY` e `STRIPE_WEBHOOK_SECRET` (passo 4) — o segundo só
   existe depois do passo 2 abaixo.
2. No [dashboard do Stripe](https://dashboard.stripe.com/webhooks), crie um
   endpoint apontando para
   `https://<REF-DO-SEU-PROJETO>.supabase.co/functions/v1/stripe-webhook`,
   escutando os eventos: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.expired`, `checkout.session.async_payment_failed`.
   Copie o "Signing secret" gerado para `STRIPE_WEBHOOK_SECRET` e rode
   `./scripts/set-secrets.sh` de novo.

### Resend (e-mail transacional)

1. Verifique um domínio seu em
   [resend.com/domains](https://resend.com/domains).
2. `RESEND_API_KEY` = uma API key da sua conta Resend.
3. `RESEND_FROM_ADDRESS` = um endereço `algo@seudominio.com` do domínio
   verificado (o padrão `onboarding@resend.dev` só entrega e-mail pra caixa
   dona da conta Resend — não serve pra clientes reais).

### Z-API (lembrete por WhatsApp)

1. Crie uma instância em [z-api.io](https://www.z-api.io) e conecte um
   número de WhatsApp a ela.
2. `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN` — todos no painel
   da sua instância.

### Agendador para os lembretes automáticos

`appvendas-lembretes` não dispara sozinha — precisa de algo chamando
`https://<REF-DO-SEU-PROJETO>.supabase.co/functions/v1/appvendas-lembretes?secret=<APPVENDAS_LEMBRETES_SECRET>`
uma vez por dia. Duas opções sem custo:
- [Supabase Cron](https://supabase.com/docs/guides/functions/schedule-functions)
  (Database > Cron Jobs no dashboard, `select net.http_get(...)` — a
  extensão `pg_cron` já vem disponível em todo projeto Supabase).
- Um agendador externo gratuito (ex. [cron-job.org](https://cron-job.org))
  batendo nessa URL diariamente.

## 7. Configurar o frontend

Edite `assets/supabaseClient.js` e preencha `SUPABASE_URL`/`SUPABASE_KEY`
com a URL e a chave "anon public"/"publishable" do seu projeto (as mesmas
do passo 5, Project Settings > API — essa chave é pública por design,
protegida pelas policies de RLS no banco, não precisa ficar em segredo).

Depois, publique os arquivos estáticos deste repositório (a raiz —
`index.html`, `assets/`, os outros `.html`) em qualquer hospedagem
estática. Não tem build/bundler: é servir os arquivos como estão. Algumas
opções gratuitas:

- **GitHub Pages** — Settings > Pages > Deploy from a branch > `main` >
  `/ (root)`, neste mesmo repositório.
- **Netlify** ou **Vercel** — "Import project", aponte para este repo,
  build command vazio, publish directory `.` (raiz).
- **Cloudflare Pages** — mesma ideia.

## 8. Primeiro acesso

1. Abra a URL onde publicou o frontend, entre com o login/senha do passo 5.
2. Administração > Empresas > "+ Nova empresa" — cadastre a primeira
   empresa/cliente que vai usar o sistema.
3. Administração > Usuários > "+ Novo usuário" — crie as contas da equipe
   dessa empresa (papel "Caixa" ou "Administrador", vinculadas a ela).
4. Administração > Configurações — nome exibido, cor, módulos habilitados
   e demais regras por empresa.

Pronto — o sistema está no ar e pronto pra uso real.
