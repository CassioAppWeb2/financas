# Assistente Financeiro Pessoal Inteligente — Fase 1

Controle financeiro **conversacional**: você fala (ou digita) “gastei 50 na padaria” e o assistente
interpreta, valida, classifica, lança e responde. App e WhatsApp são apenas **canais** do mesmo
assistente, do mesmo motor financeiro e do mesmo banco de dados.

```
 App Web/PWA ──┐                                  ┌───────────────────────┐
               ├─► Normalizador ─► ASSISTENTE ─► │ Interpretação          │
 WhatsApp ─────┘    (IncomingMessage)             │ regras → Gemini (opc.) │
                                                  └──────────┬────────────┘
                                                             ▼  JSON validado
                                                  ┌───────────────────────┐
                                                  │ MOTOR FINANCEIRO (SQL) │ valida, classifica,
                                                  │ funções fe_*           │ parcela, aprende,
                                                  └──────────┬────────────┘ audita, calcula
                                                             ▼
                                                     PostgreSQL (Supabase)
```

## O que está pronto (Fase 1)

| Item | Situação |
|---|---|
| Autenticação (e-mail e senha) | ✅ Supabase Auth |
| PostgreSQL com as 18 tabelas do documento + índices + segurança por usuário (RLS) | ✅ `supabase/migrations` |
| Motor Financeiro: validação, duplicidade, parcelas, saldos, aprendizado, auditoria, indicadores | ✅ funções `fe_*` |
| Chat “Assistente” estilo WhatsApp, com cartões e indicador de digitação | ✅ |
| Interpretação de linguagem natural (valores “R$ 1.500,00”, “mil e quinhentos”, “1,5 mil”; datas “ontem”, “dia 10”, “quinto dia útil”) | ✅ grátis, sem IA |
| IA opcional (Google Gemini, plano gratuito) para frases difíceis e áudio | ✅ basta a chave |
| Voz no app (microfone) | ✅ reconhecimento de voz do navegador (grátis) |
| Confirmação inteligente (falta valor, falta categoria, valor ambíguo, duplicado, apagar) | ✅ |
| Corrigir / apagar último lançamento pelo chat | ✅ |
| Consultas e análises (quanto gastei, maior despesa, saldo, quanto posso gastar, posso comprar X, comparar meses, estou gastando demais) | ✅ dados reais, estimativas sinalizadas |
| Dashboard (receitas, despesas, saldo, compromissos, saldo projetado, gráficos) | ✅ |
| Lançamentos (lista, filtros, busca, formulário, edição, exclusão, exportar CSV) | ✅ |
| Contas e Categorias (criar, editar, subcategorias) | ✅ |
| PWA instalável (manifest, ícones, service worker, modo escuro) | ✅ |
| WhatsApp: vínculo por código, webhook, texto e áudio, trava para ficar na cota gratuita (1.000 respostas/mês) | ✅ código pronto — falta a conta da Meta |
| Telegram: robô oficial gratuito, texto e áudio | ✅ código pronto — falta criar o robô no @BotFather |
| Família: várias pessoas no mesmo controle, visão da família e de cada pessoa | ✅ convite por código |
| Cartões, orçamentos, metas, recorrências, relatórios PDF/Excel, importação OFX | ⏳ Fases 2–3 (tabelas já criadas) |

## Tecnologia — e por que mudou em relação ao documento

O documento sugeria Next.js + Prisma. Foi usada uma arquitetura equivalente, **mais leve e 100% gratuita**:

* **Banco + login + servidor:** Supabase (PostgreSQL 17, Auth, Edge Functions em TypeScript/Deno).
* **Motor Financeiro:** funções no próprio PostgreSQL — cada lançamento é validado e gravado numa única
  transação, e o navegador **não tem permissão** de chamar o motor nem de gravar direto nas tabelas.
* **App:** PWA em HTML/CSS/JavaScript puro (sem etapa de build), hospedado no GitHub Pages.
* **IA:** interpretador próprio por regras (gratuito, instantâneo) + Google Gemini opcional (plano gratuito).

A troca de fornecedor é simples: a IA está em `supabase/functions/_shared/ai.ts` (Gemini/OpenAI),
o WhatsApp em `channels.ts` e o acesso ao motor em `engine.ts`.

## Estrutura

```
supabase/
  migrations/                 banco: tabelas, motor financeiro (fe_*) e API do app (app_*)
  functions/
    _shared/
      types.ts                IncomingMessage, Interpretation, intents
      money.ts, dates.ts      valores e datas em português
      categorizer.ts          palavras-chave → categoria
      interpreter_rules.ts    interpretação sem IA
      ai.ts                   Gemini/OpenAI: interpretação e transcrição de áudio
      assistant.ts            o Assistente (fluxo de conversa e respostas)
      channels.ts             canais App e WhatsApp (adaptador, webhook, assinatura)
      engine.ts               cliente do Motor Financeiro
    assistant/index.ts        função única: /assistant (app), /assistant/whatsapp, /assistant/telegram
web/                          aplicativo PWA
tests/                        118 testes automatizados
dev/                          banco e servidor locais para testes
```

## Testes

```bash
./dev/reset_db.sh   # cria o banco local (PostgreSQL) e aplica as migrations
bun test            # 118 testes: frases do item 41, valores, datas, conversa ponta a ponta,
                    # isolamento entre usuários, WhatsApp (texto, áudio, assinatura, vínculo)
bun dev/server.ts   # app local em http://localhost:5173 (imita o Supabase)
```

## Implantação (publicar)

### Endereços em produção
* App: <https://cassioappweb2.github.io/financas/>
* Supabase: projeto `xggsoktbreizikalxahl` (separado do app da confeitaria)
* Função: `https://xggsoktbreizikalxahl.supabase.co/functions/v1/assistant` (rotas `/whatsapp` e `/telegram`)

### 1. Supabase (banco, login e servidor)
1. Aplique os arquivos de `supabase/migrations` em ordem.
2. Publique a função: `supabase functions deploy assistant --no-verify-jwt`.
3. **Authentication → Sign In / Providers → Email:** desligue “Confirm email” (uso pessoal).
4. **Authentication → URL Configuration:** Site URL = endereço do app.
5. Opcional: em **Edge Functions → Secrets**, `GEMINI_API_KEY` (gratuita em <https://aistudio.google.com/apikey>).

### 2. App (GitHub Pages)
O conteúdo de `web/` fica no ramo `gh-pages`; `web/js/config.js` já contém a URL e a chave pública.

### 3. Telegram (gratuito)
1. No Telegram, fale com **@BotFather** → `/newbot` → escolha nome e usuário (terminado em `bot`) → copie o token.
2. Secrets: `TELEGRAM_BOT_TOKEN` e `TELEGRAM_WEBHOOK_SECRET`.
3. Registre o webhook abrindo no navegador:
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://xggsoktbreizikalxahl.supabase.co/functions/v1/assistant/telegram&secret_token=<SEGREDO>`
4. Coloque o usuário do robô em `TELEGRAM_BOT` no `config.js`.

### 4. WhatsApp (sem custo para uso pessoal)
1. Crie um app em <https://developers.facebook.com> com o produto **WhatsApp**. Use o **número de teste** gratuito da Meta
   e cadastre como destinatários os celulares da família.
2. Webhook: URL `https://xggsoktbreizikalxahl.supabase.co/functions/v1/assistant/whatsapp`, token de verificação =
   o valor de `WHATSAPP_VERIFY_TOKEN`; assine o campo **messages**.
3. Secrets `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`;
   coloque o número em `WHATSAPP_NUMBER` no `config.js`.
4. No app: **Configurações → Conectar WhatsApp → Gerar código** e envie o código ao número.

> Custos: Supabase e GitHub Pages têm plano gratuito. Gemini tem plano gratuito (no gratuito o Google pode usar
> as mensagens para melhorar seus produtos). Telegram é gratuito. WhatsApp: desde 01/10/2026 a Meta dá
> 1.000 respostas grátis por mês por número; o app só responde (nunca inicia conversa) e para em 950
> (`WHATSAPP_MONTHLY_LIMIT`), então não gera cobrança. Acima do limite, as respostas continuam no chat do app.

## Família
* O titular gera um convite em **Configurações → Família**; a outra pessoa cria a conta dela e digita o código.
* Contas, categorias, metas e lançamentos ficam compartilhados. Cada lançamento registra **quem registrou** e
  **de quem é** (a pessoa ou "Família", para gastos compartilhados — “gastamos”, “da casa”).
* Consultas: “quanto gastamos?” (família, com divisão por pessoa), “quanto eu gastei?”, “quanto a Ana gastou?”,
  “gastos compartilhados”. Dashboard e Lançamentos têm filtro por pessoa.
* Cada pessoa tem sua conversa e conecta o próprio WhatsApp/Telegram.

## Segurança
* RLS em todas as tabelas: cada usuário só lê as próprias linhas; nenhuma gravação direta do navegador.
* Motor Financeiro (`fe_*`) executável apenas pelo servidor; API do app (`app_*`) sempre usa `auth.uid()`.
* Valores e datas validados no banco; consultas parametrizadas (sem SQL injection).
* Webhook do WhatsApp valida a assinatura HMAC da Meta; mensagens repetidas são ignoradas.
* Limite de 30 mensagens/minuto por usuário; chaves de API só como secrets do servidor.
* Exclusões são lógicas e tudo fica em `audit_logs` (inclusive mensagem original e interpretação da IA).

## Regra absoluta
O assistente diferencia **fato** (dado do banco), **interpretação** (o que entendeu da mensagem — e pergunta
quando falta algo) e **estimativa** (projeções, sempre marcadas como “estimativa”). A IA nunca grava no banco:
sua resposta é validada (valor só é aceito se aparece na mensagem; categoria só se existe no cadastro).

### Publicar a função `assistant` (sem a CLI)
O código compartilhado (`supabase/functions/_shared`) é publicado a partir do GitHub: o `index.ts` enviado ao Supabase
importa os módulos por `https://raw.githubusercontent.com/CassioAppWeb2/financas/<commit>/supabase/functions/_shared/...`,
fixados num commit (nada muda sozinho). Para atualizar: faça push em `main`, troque o `<commit>` no entrypoint e publique de novo.
Use sempre `import ... from "https://raw.githubusercontent.com/..."` (import estático) no entrypoint: `await import(...)` dinâmico não funciona no Supabase e derruba a função.
Com a CLI, `supabase functions deploy assistant --no-verify-jwt` continua funcionando normalmente com o `index.ts` do repositório.
