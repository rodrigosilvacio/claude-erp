# ERPConnect

**Feito com IA — Claude Code Agent**

ERP de gestão comercial multiempresa: vendas, matrículas/assinaturas
recorrentes, CRM de propostas, agenda de atendimentos, estoque, financeiro
e relatórios — tudo num único painel, sem servidor próprio para manter.
Projeto público, de código aberto, pronto para qualquer pessoa clonar e
colocar no ar com o próprio banco de dados.

> **Este repositório não contém nenhuma chave, projeto ou dado de um
> deploy específico.** Todo campo de configuração (URL do banco, chaves de
> API, segredos) é um placeholder para você preencher com o **seu** próprio
> projeto Supabase — ver [Deploy passo a passo](#deploy-passo-a-passo).

## Sumário

- [O que é](#o-que-é)
- [Stack técnica](#stack-técnica)
- [Fluxos principais](#fluxos-principais)
- [Módulos](#módulos)
- [Integração de pagamentos](#integração-de-pagamentos)
- [Backend: Supabase (preferencial)](#backend-supabase-preferencial)
- [Segurança — limitação conhecida](#segurança--limitação-conhecida)
- [Deploy passo a passo](#deploy-passo-a-passo)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Licença](#licença)
- [Autor](#autor)

## O que é

O ERPConnect nasceu como ferramenta interna de gestão para pequenos e
médios negócios de serviço (escolas, academias, prestadores em geral) que
vendem tanto produto físico quanto curso/serviço recorrente — e foi
extraído para um repositório próprio como projeto público, para qualquer
pessoa reaproveitar, estudar ou rodar a própria instância.

Características centrais:

- **Multiempresa de verdade**: várias empresas/clientes no mesmo sistema,
  cada uma enxergando só os próprios dados (Row Level Security no banco,
  não só no front-end).
- **Sem build, sem framework**: HTML + JavaScript (ES Modules) direto no
  navegador. Editar um arquivo e atualizar a página já reflete a mudança —
  não tem etapa de compilação entre o código e o que roda.
- **Sem servidor próprio**: todo o backend é [Supabase](https://supabase.com)
  (Postgres + Auth + Edge Functions) — hospedado, gerenciado, com plano
  gratuito suficiente para validar o projeto.
- **Auditável**: toda regra de negócio sensível (preço, baixa de estoque,
  permissão) vive em funções do banco (`security definer`) e Row Level
  Security — não depende de o front-end "se comportar direito".

## Stack técnica

| Camada | Tecnologia | Observação |
|---|---|---|
| Frontend | HTML5 + JavaScript (ES Modules), CSS puro | Sem framework (React/Vue/etc.), sem bundler/build step |
| Roteamento | Hash routing próprio (`#/rota`) | `assets/app.js` — SPA de uma página só |
| Cliente Supabase | [`@supabase/supabase-js@2.110.5`](https://github.com/supabase/supabase-js) | Importado via CDN ([esm.sh](https://esm.sh)), versão fixada de propósito |
| Banco de dados | PostgreSQL (via Supabase) | Schema 100% versionado em `supabase/migrations/` |
| Autenticação | Supabase Auth (usuário/senha) | Login por usuário interno, mapeado para e-mail sintético internamente |
| Autorização | Row Level Security (RLS) + funções `security definer` | Isolamento multiempresa e papéis (admin / caixa) reforçados no banco, não só na tela |
| Backend sob demanda | Supabase Edge Functions ([Deno](https://deno.com)) | 7 functions — ver [tabela abaixo](#módulos) |
| Pagamento online | [Stripe](https://stripe.com) (`stripe@17.4.0`, SDK Deno) | Opcional — ver [Integração de pagamentos](#integração-de-pagamentos) |
| E-mail transacional | [Resend](https://resend.com) | Opcional — proposta, recibo, lembrete de vencimento |
| WhatsApp | [Z-API](https://www.z-api.io) | Opcional — lembrete de aula/vencimento |
| CEP | [ViaCEP](https://viacep.com.br) via function própria (`mcp-cep`) | Também exposta como servidor MCP público |
| QR Code | [`qrcode@1.5.4`](https://github.com/soldair/node-qrcode) | Gerado no navegador para o checkout Stripe |
| Tipografia | Google Fonts — Archivo, Manrope, IBM Plex Mono | Carregada via `<link>`, sem instalação |
| Hospedagem do frontend | Qualquer hospedagem estática (GitHub Pages, Netlify, Vercel, Cloudflare Pages...) | Zero configuração de servidor |

Este stack foi escolhido para minimizar o que existe entre "ter uma ideia"
e "estar no ar": sem build, sem servidor próprio, sem orquestração —
qualquer pessoa com uma conta Supabase gratuita e um lugar para hospedar
arquivos estáticos consegue rodar a própria cópia.

## Fluxos principais

Um resumo de como as peças se conectam — cada uma detalhada no código do
respectivo módulo (`assets/*.js`).

- **Venda (Loja)** — monta um carrinho de produtos → escolhe forma de
  pagamento (Dinheiro, Pix, Cartão manual, à vista ou parcelado, ou Stripe)
  → confirma → baixa automática de estoque → e-mail de recibo (opcional,
  via Resend).
- **Matrícula** — vincula um cliente a um curso/serviço, define
  parcelamento → 1ª parcela cobrada na hora (Stripe opcional) → parcelas
  seguintes nascem como títulos a receber, cobrados manualmente no balcão
  conforme vencem.
- **CRM → Venda/Matrícula** — uma proposta (para lead ou cliente já
  cadastrado) reúne itens de produto e/ou serviço → é enviada por e-mail →
  ao ser aprovada, converte automaticamente em Venda (itens de produto) e/ou
  Matrícula (itens de serviço), preservando o preço negociado — nunca fica
  "aprovada" sem virar negócio de verdade ou sem alguém decidir não converter.
- **Agenda → Atendimento** — agenda um horário para cliente + produto/serviço
  → no dia, "Atendido" abre a tela de Venda ou Matrícula já pré-preenchida —
  o agendamento só muda de status depois que o negócio é confirmado de
  verdade.
- **Estoque** — entrada de mercadoria (compra, pode gerar conta a pagar
  automaticamente) e baixa automática em toda venda confirmada compõem o
  kardex; divergências de contagem física são corrigidas por ajuste manual
  auditável (nunca editando o saldo direto).
- **Financeiro** — contas a pagar (fornecedores) e a receber (parcelas de
  vendas/matrículas) com lembrete automático antes do vencimento
  (e-mail e/ou WhatsApp, ambos opcionais).
- **Captação pública** — duas páginas sem login: pré-cadastro de cliente e
  agendamento de atendimento — para captar demanda de fora sem dar acesso
  ao sistema a ninguém de fora da equipe.
- **Administração multiempresa** — um admin global cria empresas e define
  identidade visual/módulos habilitados/regras por empresa; cada empresa
  gerencia os próprios usuários (papel Administrador ou Caixa) e só enxerga
  os próprios dados. Toda alteração relevante (preço, cadastro, exclusão)
  fica registrada em log de auditoria.

## Módulos

### Telas (`assets/*.js`)

| Módulo | Arquivo | O que faz |
|---|---|---|
| Clientes / Produtos / Fornecedores | `clientes.js`, `produtos.js`, `fornecedores.js` (+ `cadastro.js`) | CRUD genérico reaproveitado pelas três |
| Loja (Vendas) | `vendas.js` | Carrinho, parcelamento, Stripe opcional |
| Matrículas | `matriculas.js` | Contratação de curso/serviço parcelado |
| Agenda | `agenda.js` | Atendimentos por dia/semana/mês |
| CRM | `crm.js` | Propostas (lead/cliente) → convertem em Venda ou Matrícula |
| Estoques | `estoques.js` | Entradas, ajustes manuais, kardex |
| Contas a Pagar / Receber | `contas-pagar.js`, `financeiro.js` | Financeiro |
| Relatórios | `relatorios.js` | Faturamento, ticket médio, estoque baixo, etc. |
| Administração | `usuarios.js`, `empresas.js`, `configuracoes.js` | Usuários, empresas, identidade/módulos por empresa (admin global) |

### Edge Functions (`supabase/functions/`)

| Function | Pública? | Pra quê |
|---|---|---|
| `manage-usuarios` | Não* | Criar/editar/excluir usuário, redefinir senha (*aceita a 1ª criação sem sessão, com `bootstrap_secret`) |
| `create-stripe-checkout` | Não | Cria a sessão de pagamento Stripe (Vendas/Matrículas) |
| `stripe-webhook` | Sim | Confirma/cancela venda ou matrícula quando o Stripe avisa |
| `enviar-proposta` | Não | E-mail da proposta (CRM) pro cliente/lead |
| `enviar-confirmacao-negocio` | Não | E-mail de recibo após venda/matrícula |
| `appvendas-lembretes` | Sim (protegida por secret) | Lembrete de aula/vencimento — cron diário |
| `mcp-cep` | Sim | Consulta de CEP (proxy do ViaCEP), também um servidor MCP público |

"Não" pública = exige sessão Supabase válida (`verify_jwt = true`, ver
`supabase/config.toml`).

## Integração de pagamentos

O sistema **funciona sem nenhuma integração de pagamento online** — Dinheiro,
Pix e Cartão (manual, à vista ou parcelado) são registrados diretamente,
sem depender de terceiros.

Para cobrança online, a integração nativa é o **[Stripe](https://stripe.com)**:

1. O cliente escolhe "Stripe" como forma de pagamento em Vendas ou
   Matrículas.
2. A Edge Function `create-stripe-checkout` cria a venda/matrícula como
   `aguardando_pagamento` e abre uma **Stripe Checkout Session** — o cliente
   paga pelo próprio celular (QR code ou link), o sistema nunca vê dado de
   cartão.
3. O **preço cobrado é sempre recalculado no servidor** a partir do
   catálogo (ou da proposta do CRM já aprovada) — o valor mostrado na tela
   nunca é o que de fato é enviado ao Stripe, fechando a classe de fraude
   de "alterar o preço no navegador antes de pagar".
4. Quando o Stripe confirma o pagamento, a Edge Function `stripe-webhook`
   (validada pela assinatura do evento, `STRIPE_WEBHOOK_SECRET`) marca a
   venda/matrícula como paga e dá baixa no estoque. Sessão expirada ou
   pagamento recusado cancela automaticamente.
5. Em matrícula parcelada, o Stripe cobra só a 1ª parcela — as demais
   nascem como títulos a receber, cobrados manualmente conforme vencem.

Nenhuma chave do Stripe fica no front-end — tudo passa pelas Edge
Functions. Ver [Deploy passo a passo](#deploy-passo-a-passo) para
configurar sua própria conta.

## Backend: Supabase (preferencial)

O **Supabase é o backend recomendado e, hoje, o único suportado** por este
projeto — não é uma escolha entre várias opções, é a peça em torno da qual
todo o resto foi desenhado:

- **Postgres gerenciado** — schema versionado em
  `supabase/migrations/`, aplicado com um comando (`supabase db push`).
- **Auth pronta** — sessão, JWT, tudo que `assets/auth.js` consome direto
  do cliente `supabase-js`.
- **Edge Functions (Deno)** — as 7 rotinas de servidor (pagamento, e-mail,
  criação de usuário, lembretes) rodam nesse runtime, sem VM/container
  próprio para manter.
- **Row Level Security** — o isolamento entre empresas e a distinção
  admin/caixa são impostos pelo **banco**, não pelo front-end — mesmo uma
  chamada direta à API REST do Postgres respeita as mesmas regras.
- **Plano gratuito** cobre confortavelmente uma instância pequena/média
  para validar o projeto antes de decidir escalar.

Migrar para outro backend (Firebase, um Postgres genérico + API própria,
etc.) exigiria reescrever autenticação, todas as políticas de RLS e as 7
Edge Functions — não é um objetivo deste projeto hoje. Se seu caso de uso
exige isso, é um bom ponto de partida para um fork.

## Segurança — limitação conhecida

RLS isola dados por empresa (`empresa_id`) para todo usuário comum. Um
admin **vinculado a uma única empresa** (`role = 'admin'`, `empresa_id`
preenchido) é tratado como admin "de dentro" da própria empresa — correto.
Mas várias policies/RPCs de negócio (vendas, contas a pagar, matrículas,
estoque, propostas — ver comentários `is_admin()` nas migrations `0005`,
`0009`, `0014`, `0015`, `0031`, `0036`, `0040`, `0042`, `0044`) ainda usam
`is_admin()` puro em vez de `is_global_admin()`, então esse mesmo admin
também enxerga/edita dados de **outras** empresas — a mesma classe de
brecha que a migration `0020` já fechou para `usuarios`/`empresas`, só que
não replicada pro resto do schema.

**Se você vai rodar uma única empresa** (ou confia em todos os admins que
vinculará a empresas), isso não é um problema na prática. **Se o plano é
hospedar várias empresas que não devem se enxergar** (SaaS multi-cliente
com clientes que não se conhecem), troque `is_admin()` por
`is_global_admin()` nessas policies/RPCs antes de expor o sistema — é uma
migration nova, não uma reescrita.

## Deploy passo a passo

Visão geral dos passos — comandos e detalhes de cada um em
[`scripts/README.md`](scripts/README.md), incluindo os scripts prontos
(`deploy.sh`, `set-secrets.sh`, `bootstrap-admin.sh`).

1. **Crie um projeto no [Supabase](https://supabase.com/dashboard)** —
   plano gratuito serve para começar. Guarde a URL do projeto e a senha do
   banco.
2. **Instale o [Supabase CLI](https://supabase.com/docs/guides/cli)** e
   conecte ao seu projeto: `supabase login` e
   `supabase link --project-ref <seu-projeto>`.
3. **Aplique o schema e publique as Edge Functions**:
   `./scripts/deploy.sh` — roda `supabase db push` (as ~32 migrations, em
   ordem) e `supabase functions deploy` para as 7 functions.
4. **Configure os segredos**: copie `scripts/.env.example` para
   `scripts/.env`, preencha com os seus valores e rode
   `./scripts/set-secrets.sh`. Só dois são obrigatórios
   (`APPVENDAS_BOOTSTRAP_SECRET`, `APPVENDAS_LEMBRETES_SECRET` — strings
   aleatórias suas); o resto é por integração (Stripe/Resend/Z-API).
5. **Crie o primeiro administrador**: `./scripts/bootstrap-admin.sh` — sem
   ele, ninguém consegue logar para criar o primeiro usuário pela tela.
6. **(Opcional) Configure as integrações**: Stripe (pagamento online),
   Resend com um domínio seu verificado (e-mail) e Z-API (WhatsApp) — passo
   a passo de cada uma em [`scripts/README.md`](scripts/README.md#6-integrações-opcionais).
7. **Preencha `assets/supabaseClient.js`** com a URL e a chave
   `anon`/`publishable` do **seu** projeto (Project Settings → API no
   dashboard do Supabase — pública por design, protegida por RLS, mas
   ainda assim específica de cada projeto).
8. **Publique os arquivos estáticos** (a raiz deste repositório) em
   qualquer hospedagem — GitHub Pages, Netlify, Vercel, Cloudflare Pages —
   sem build, é servir os arquivos como estão.
9. **Primeiro acesso**: entre com o login/senha do passo 5 → Administração →
   Empresas → cadastre a primeira empresa → Administração → Usuários →
   crie as contas da equipe → Administração → Configurações → ajuste
   identidade visual e módulos habilitados.

Pronto — sistema no ar, com o seu próprio banco, suas próprias chaves,
sem depender do repositório original.

## Estrutura do repositório

```
index.html                    shell do app (sidebar + roteamento por hash)
pre-cadastro.html              cadastro público de cliente (sem login)
agendamento-publico.html       agendamento público (sem login)
pagamento-{confirmado,cancelado}.html   retorno do checkout Stripe
assets/                        todo o JS/CSS do frontend, um módulo por tela
supabase/migrations/           schema completo do banco, em ordem
supabase/functions/            7 Edge Functions (ver tabela acima)
supabase/tests/database/       teste pgTAP das RPCs principais
scripts/                       deploy, secrets, criação do 1º admin
```

## Licença

[MIT](LICENSE) — use, estude, modifique e distribua livremente. Ajuste a
licença no arquivo `LICENSE` se seu caso de uso pedir outra.

## Autor

**Rodrigo Silva**
AI & Digital Product Executive
[@rodrigosilvacio](https://github.com/rodrigosilvacio)
