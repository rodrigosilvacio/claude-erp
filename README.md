# ERPConnect

ERP de gestão comercial: cadastros (clientes, produtos, fornecedores),
vendas com carrinho e parcelamento, matrículas/assinaturas recorrentes,
agenda de atendimentos, CRM de propostas, controle de estoque (entradas,
ajustes, kardex), financeiro (contas a pagar/receber), relatórios e
administração multiempresa (várias empresas/clientes no mesmo sistema,
cada uma isolada por Row Level Security). HTML/JS estático (sem build) +
[Supabase](https://supabase.com) (Postgres, Auth, Edge Functions) — sem
servidor próprio pra manter.

Extraído para distribuição livre a partir de um projeto maior — vem sem
nenhuma chave, projeto ou dado do deploy original. **[Siga
`scripts/README.md` para colocar no ar do zero](scripts/README.md)** —
cobre criar o projeto Supabase, aplicar as migrations, publicar as Edge
Functions, configurar segredos e integrações opcionais, criar o primeiro
admin e publicar o frontend.

## Estrutura

```
index.html                    shell do app (sidebar + roteamento por hash)
pre-cadastro.html              cadastro público de cliente (sem login)
agendamento-publico.html       agendamento público (sem login)
pagamento-{confirmado,cancelado}.html   retorno do checkout Stripe
assets/                        todo o JS/CSS do frontend, um módulo por tela
supabase/migrations/           schema completo do banco, em ordem
supabase/functions/            7 Edge Functions (ver abaixo)
supabase/tests/database/       teste pgTAP das RPCs principais
scripts/                       deploy, secrets, criação do 1º admin
```

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
| Administração | `usuarios.js`, `empresas.js`, `configuracoes.js` | Usuários, empresas, identidade/módulos por empresa (globalAdmin) |

### Edge Functions (`supabase/functions/`)

| Function | Pública? | Pra quê |
|---|---|---|
| `manage-usuarios` | Não* | Criar/editar/excluir usuário, redefinir senha (*aceita a 1ª criação sem sessão, com `bootstrap_secret`) |
| `create-stripe-checkout` | Não | Cria a sessão de pagamento Stripe (Vendas/Matrículas) |
| `stripe-webhook` | Sim | Confirma/cancela venda ou matrícula quando o Stripe avisa |
| `enviar-proposta` | Não | E-mail da proposta (CRM) pro cliente/lead |
| `enviar-confirmacao-negocio` | Não | E-mail de recibo após venda/matrícula |
| `appvendas-lembretes` | Sim (protegida por secret) | Lembrete de aula/vencimento — cron diário |
| `mcp-cep` | Sim | Consulta de CEP (proxy do ViaCEP) |

"Não" pública = exige sessão Supabase válida (`verify_jwt = true`, ver
`supabase/config.toml`).

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

## Licença

[MIT](LICENSE) — ajuste conforme sua necessidade.
